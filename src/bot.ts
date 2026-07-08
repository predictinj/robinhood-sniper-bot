import { parseEther, formatEther } from 'viem';
import { loadConfig, type BotConfig } from './config/index.js';
import { createClients, verifyChain, type ChainClients } from './chain/client.js';
import { createAdapter, dexFullyConfigured } from './dex/index.js';
import type { DexAdapter } from './dex/adapter.js';
import { MockDexAdapter } from './dex/mock.js';
import { BotDb } from './storage/db.js';
import { Scanner } from './scanner/scanner.js';
import { runSafetyChecks } from './safety/checks.js';
import { TradingEngine, TradeBlockedError } from './trading/engine.js';
import { PositionManager } from './trading/positionManager.js';
import type { PoolInfo } from './types/index.js';
import { childLogger } from './utils/logger.js';

const log = childLogger('bot');

export interface App {
  cfg: BotConfig;
  db: BotDb;
  clients: ChainClients | null;
  adapter: DexAdapter;
  engine: TradingEngine;
  positions: PositionManager;
  scanner: Scanner;
  /** true when running against the mock adapter / incomplete DEX config */
  simulationOnly: boolean;
  shutdown: () => void;
}

/**
 * Wire the whole bot together from config. In paper mode with DEX_TYPE=mock no
 * chain connection is required at all. If DEX addresses are missing for a real
 * adapter, the bot degrades to monitor/simulation mode with the mock adapter
 * and tells the user what to configure.
 */
export function buildApp(cfg: BotConfig = loadConfig()): App {
  const db = new BotDb(cfg.dbPath);

  const needsChain = !(cfg.mode === 'paper' && cfg.dexType === 'mock');
  let clients: ChainClients | null = null;
  if (needsChain) {
    clients = createClients(cfg);
  }

  let adapter: DexAdapter;
  let simulationOnly = false;
  if (cfg.dexType !== 'mock' && !dexFullyConfigured(cfg)) {
    log.warn(
      'DEX addresses are not fully configured (DEX_FACTORY_ADDRESS / DEX_ROUTER_ADDRESS / BASE_TOKEN_ADDRESS' +
        (cfg.dexType === 'uniswap_v3' ? ' / DEX_QUOTER_ADDRESS' : '') +
        '). Running in MONITOR/SIMULATION mode with the mock adapter — no live trading is possible until these are set in .env.',
    );
    adapter = new MockDexAdapter({});
    simulationOnly = true;
  } else {
    adapter = createAdapter(cfg, clients ?? ({ publicClient: null, subscriptionClient: null, walletClient: null, account: null } as unknown as ChainClients));
    if (cfg.dexType === 'mock') simulationOnly = true;
  }

  const engine = new TradingEngine({
    cfg,
    db,
    adapter,
    publicClient: clients?.publicClient ?? null,
    walletClient: clients?.walletClient ?? null,
    account: clients?.account ?? null,
  });

  const positions = new PositionManager(cfg, db, adapter, engine);

  const scanner = new Scanner({
    publicClient: clients?.publicClient ?? null,
    adapter,
    db,
    onNewPool: (pool) => onNewPool({ cfg, db, adapter, engine, client: clients?.publicClient ?? null }, pool),
  });

  const shutdown = () => {
    scanner.stop();
    positions.stop();
    db.close();
  };

  return { cfg, db, clients, adapter, engine, positions, scanner, simulationOnly, shutdown };
}

/**
 * The snipe pipeline for one discovered pool:
 * safety checks → store report → flag or auto-buy within risk limits.
 * Auto-buys only happen when the bot was started in trading mode (start/paper),
 * i.e. this function is used as the scanner callback there.
 */
export async function onNewPool(
  ctx: { cfg: BotConfig; db: BotDb; adapter: DexAdapter; engine: TradingEngine; client?: import('./safety/checks.js').SafetyClient | null },
  pool: PoolInfo,
): Promise<void> {
  const { cfg, db, adapter, engine } = ctx;
  try {
    const report = await runSafetyChecks({ client: ctx.client ?? null, adapter, cfg }, pool);
    db.insertSafetyReport(report);
    if (report.meta) db.upsertToken(report.meta);

    if (!report.passed) {
      db.flagToken(pool.token, report.criticalFailures.join('; '));
      log.warn({ token: pool.token, failures: report.criticalFailures }, 'token FLAGGED — not buying');
      return;
    }

    const amountIn = parseEther(cfg.maxBuyEth.toString());
    const { positionId, txHash } = await engine.buy(pool.token, pool.address, amountIn, report);
    log.info({ token: pool.token, positionId, txHash, amount: formatEther(amountIn) }, 'auto-buy executed');
  } catch (err) {
    if (err instanceof TradeBlockedError) {
      log.info({ token: pool.token, blockers: err.blockers }, 'auto-buy blocked by risk limits');
    } else {
      db.insertError('bot', `onNewPool failed: ${String(err)}`, { pool: pool.address });
      log.error({ err: String(err), pool: pool.address }, 'pipeline error for new pool');
    }
  }
}

/**
 * Full-safety variant used when a chain client is available (real adapters):
 * passes the public client so contract-level checks run too.
 */
export async function runFullSafety(app: App, pool: PoolInfo) {
  return runSafetyChecks({ client: app.clients?.publicClient ?? null, adapter: app.adapter, cfg: app.cfg }, pool);
}

/** Verify chain connectivity if this app instance needs a chain at all. */
export async function preflight(app: App): Promise<string[]> {
  const problems: string[] = [];
  if (app.clients) {
    const p = await verifyChain(app.clients.publicClient, app.cfg.chainId);
    if (p) problems.push(p);
  }
  return problems;
}
