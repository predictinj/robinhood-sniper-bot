import type { PublicClient } from 'viem';
import type { PoolInfo } from '../types/index.js';
import type { DexAdapter } from '../dex/adapter.js';
import type { BotDb } from '../storage/db.js';
import { childLogger } from '../utils/logger.js';
import { sleep, withRetry } from '../utils/retry.js';

const log = childLogger('scanner');

export interface ScannerOptions {
  publicClient: PublicClient | null;
  adapter: DexAdapter;
  db: BotDb;
  /** called for each newly discovered (non-duplicate) pool */
  onNewPool: (pool: PoolInfo) => Promise<void> | void;
  blockPollIntervalMs?: number;
  reconnectDelayMs?: number;
}

/**
 * Watches new blocks and DEX factory events, dedupes pools against SQLite,
 * and survives RPC errors by tearing down and re-subscribing with backoff.
 */
export class Scanner {
  private readonly o: ScannerOptions;
  private stopped = false;
  private unwatchPools: (() => void) | null = null;
  private unwatchBlocks: (() => void) | null = null;
  private reconnectAttempts = 0;

  constructor(opts: ScannerOptions) {
    this.o = opts;
  }

  /** One-shot historical scan over a block range. Returns newly stored pools. */
  async scanRange(fromBlock: bigint, toBlock: bigint): Promise<PoolInfo[]> {
    const pools = await withRetry(() => this.o.adapter.scanNewPools(fromBlock, toBlock), {
      retries: 3,
      onRetry: (err, attempt) => log.warn({ attempt, err: String(err) }, 'scanNewPools retry'),
    });
    const fresh: PoolInfo[] = [];
    for (const pool of pools) {
      if (await this.handleDiscovered(pool)) fresh.push(pool);
    }
    log.info({ scanned: pools.length, new: fresh.length, fromBlock: fromBlock.toString(), toBlock: toBlock.toString() }, 'historical scan complete');
    return fresh;
  }

  /** Continuous watch. Resolves only when stop() is called. */
  async watch(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.subscribe();
        // stay alive until an error tears subscriptions down or stop() is called
        while (!this.stopped && this.unwatchPools) {
          await sleep(1000);
        }
      } catch (err) {
        this.o.db.insertError('scanner', String(err));
        log.error({ err: String(err) }, 'scanner subscription failed');
      }
      if (!this.stopped) {
        const delay = Math.min(60_000, (this.o.reconnectDelayMs ?? 2000) * 2 ** Math.min(this.reconnectAttempts, 5));
        this.reconnectAttempts++;
        log.warn({ delayMs: delay, attempt: this.reconnectAttempts }, 'scanner reconnecting');
        await sleep(delay);
      }
    }
  }

  private async subscribe(): Promise<void> {
    this.teardown();

    // block watcher (real chains only) — heartbeat + activity log
    if (this.o.publicClient) {
      this.unwatchBlocks = this.o.publicClient.watchBlockNumber({
        emitOnBegin: true,
        pollingInterval: this.o.blockPollIntervalMs ?? 4000,
        onBlockNumber: (bn) => {
          this.reconnectAttempts = 0; // healthy connection
          log.debug({ block: bn.toString() }, 'new block');
        },
        onError: (err) => this.handleStreamError('block watcher', err),
      });
    }

    this.unwatchPools = this.o.adapter.watchNewPools(
      (pool) => {
        void this.handleDiscovered(pool);
      },
      (err) => this.handleStreamError('pool watcher', err),
    );
    log.info({ adapter: this.o.adapter.name }, 'scanner subscribed');
  }

  private handleStreamError(source: string, err: Error) {
    this.o.db.insertError('scanner', `${source}: ${err.message}`);
    log.warn({ source, err: err.message }, 'stream error — will resubscribe');
    this.teardown(); // watch() loop notices unwatchPools === null and reconnects
  }

  /** Returns true if this pool was new (not seen before). */
  private async handleDiscovered(pool: PoolInfo): Promise<boolean> {
    try {
      if (this.o.db.hasPool(pool.address)) return false;
      let liquidity: bigint | null = null;
      try {
        liquidity = await this.o.adapter.getPoolLiquidityBase(pool);
      } catch {
        // liquidity may not exist yet at creation time; safety checks re-read it
      }
      const inserted = this.o.db.insertPool(pool, liquidity);
      if (!inserted) return false; // raced duplicate
      this.o.db.insertEvent('pool_discovered', {
        pool: pool.address,
        token: pool.token,
        baseToken: pool.baseToken,
        dex: pool.dex,
        blockNumber: pool.blockNumber.toString(),
        liquidityBase: liquidity?.toString() ?? null,
      });
      log.info({ pool: pool.address, token: pool.token, dex: pool.dex }, 'new pool discovered');
      await this.o.onNewPool(pool);
      return true;
    } catch (err) {
      this.o.db.insertError('scanner', `handleDiscovered: ${String(err)}`, { pool: pool.address });
      log.error({ err: String(err), pool: pool.address }, 'error handling discovered pool');
      return false;
    }
  }

  private teardown() {
    this.unwatchPools?.();
    this.unwatchBlocks?.();
    this.unwatchPools = null;
    this.unwatchBlocks = null;
  }

  stop() {
    this.stopped = true;
    this.teardown();
    log.info('scanner stopped');
  }
}
