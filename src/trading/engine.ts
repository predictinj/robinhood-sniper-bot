import { formatEther, parseEther, parseGwei, type PublicClient, type WalletClient, type Account } from 'viem';
import type { Address, ExitReason, Mode, Position, SafetyReport, TxRequest } from '../types/index.js';
import type { BotConfig } from '../config/index.js';
import { liveTradingBlockers } from '../config/index.js';
import type { DexAdapter } from '../dex/adapter.js';
import type { BotDb } from '../storage/db.js';
import { PaperEngine } from '../simulation/paper.js';
import { applySlippageBps, priceFromAmounts } from '../utils/math.js';
import { currentAllowance, buildApproveTx } from '../dex/uniswapV2.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('trading');

const TX_DEADLINE_SEC = 120;
const RECEIPT_TIMEOUT_MS = 90_000;

export class TradeBlockedError extends Error {
  constructor(public readonly blockers: string[]) {
    super(`trade blocked:\n  - ${blockers.join('\n  - ')}`);
  }
}

export interface TradingEngineOptions {
  cfg: BotConfig;
  db: BotDb;
  adapter: DexAdapter;
  publicClient: PublicClient | null;
  walletClient: WalletClient | null;
  account: Account | null;
}

/**
 * Trading engine: single entry point for all buys and sells.
 *
 * paper   → PaperEngine, no chain writes ever.
 * testnet → real transactions, but only on the testnet chain id.
 * live    → real transactions, gated by liveTradingBlockers() — MODE=live,
 *           ENABLE_LIVE_TRADING=true, key + DEX config present, valid risk
 *           limits, `bot confirm-live` run, and no emergency stop.
 */
export class TradingEngine {
  private readonly o: TradingEngineOptions;
  readonly paper: PaperEngine;

  constructor(opts: TradingEngineOptions) {
    this.o = opts;
    this.paper = new PaperEngine(opts.db, opts.adapter, opts.cfg.paperBalanceEth);
  }

  get mode(): Mode {
    return this.o.cfg.mode;
  }

  /** All reasons the engine would refuse to send a REAL transaction right now. */
  realTradeBlockers(): string[] {
    const { cfg, db } = this.o;
    if (cfg.mode === 'testnet') {
      // testnet needs a key + dex config, but not the live confirmation ceremony
      const blockers: string[] = [];
      if (db.isEmergencyStopped()) blockers.push('EMERGENCY STOP is active (run `bot resume` to clear)');
      if (!cfg.privateKey) blockers.push('PRIVATE_KEY is not set');
      if (cfg.dexType === 'mock') blockers.push('DEX_TYPE is "mock" — testnet trading needs a real adapter');
      if (!cfg.dexRouterAddress || !cfg.dexFactoryAddress || !cfg.baseTokenAddress) blockers.push('DEX router/factory/base token addresses are not configured');
      return blockers;
    }
    return liveTradingBlockers(cfg, { liveConfirmed: db.isLiveConfirmed(), emergencyStop: db.isEmergencyStopped() });
  }

  private assertRiskLimitsForBuy(amountInBase: bigint) {
    const { cfg, db } = this.o;
    const blockers: string[] = [];

    if (db.isEmergencyStopped()) blockers.push('EMERGENCY STOP is active');

    const maxBuy = parseEther(cfg.maxBuyEth.toString());
    if (amountInBase > maxBuy) blockers.push(`amount ${formatEther(amountInBase)} ETH exceeds MAX_BUY_ETH=${cfg.maxBuyEth}`);
    if (amountInBase <= 0n) blockers.push('amount must be > 0');

    const open = db.openPositions().filter((p) => p.mode === cfg.mode);
    if (open.length >= cfg.maxOpenPositions) blockers.push(`already at MAX_OPEN_POSITIONS=${cfg.maxOpenPositions}`);

    const lastBuy = db.lastBuyAt();
    if (lastBuy && cfg.cooldownSeconds > 0) {
      const elapsed = (Date.now() - Date.parse(lastBuy + 'Z')) / 1000;
      if (elapsed >= 0 && elapsed < cfg.cooldownSeconds) {
        blockers.push(`cooldown: ${Math.ceil(cfg.cooldownSeconds - elapsed)}s remaining (COOLDOWN_SECONDS=${cfg.cooldownSeconds})`);
      }
    }
    if (blockers.length) throw new TradeBlockedError(blockers);
  }

  /**
   * Buy `amountInBase` (base wei) of `token`. Routes to paper or real trading
   * per MODE, enforcing every risk limit first. Returns the position id.
   */
  async buy(token: Address, pool: Address | null, amountInBase: bigint, safety?: SafetyReport): Promise<{ positionId: number | null; txHash: string | null }> {
    const { cfg, db } = this.o;
    this.assertRiskLimitsForBuy(amountInBase);

    if (safety && !safety.passed) {
      throw new TradeBlockedError([`token failed safety checks: ${safety.criticalFailures.join('; ')}`]);
    }

    const decimals = safety?.meta?.decimals ?? 18;

    if (cfg.mode === 'paper') {
      const res = await this.paper.buy(token, pool, amountInBase, decimals);
      return { positionId: res.positionId, txHash: null };
    }

    const blockers = this.realTradeBlockers();
    if (blockers.length) throw new TradeBlockedError(blockers);
    return this.realBuy(token, pool, amountInBase, decimals);
  }

  /** Sell `percent` of the open position for `token`. */
  async sell(token: Address, percent: number, reason: ExitReason): Promise<{ txHash: string | null }> {
    const { cfg, db } = this.o;
    const position = db.openPositionForToken(token);
    if (!position) throw new Error(`no open position for ${token}`);

    if (cfg.mode === 'paper' || position.mode === 'paper') {
      await this.paper.sell(position, percent, reason);
      return { txHash: null };
    }

    const blockers = this.realTradeBlockers();
    if (blockers.length) throw new TradeBlockedError(blockers);
    return this.realSell(position, percent, reason);
  }

  // ---------------------------------------------------------------- real path

  private clients() {
    const { publicClient, walletClient, account } = this.o;
    if (!publicClient || !walletClient || !account) {
      throw new TradeBlockedError(['chain clients unavailable (missing RPC or PRIVATE_KEY)']);
    }
    return { publicClient, walletClient, account };
  }

  /** Cap fees at MAX_GAS_GWEI; throws if the network wants more. */
  private async feeParams(publicClient: PublicClient): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const cap = parseGwei(this.o.cfg.maxGasGwei.toString());
    const fees = await publicClient.estimateFeesPerGas().catch(async () => {
      const gasPrice = await publicClient.getGasPrice();
      return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice / 10n };
    });
    const maxFee = fees.maxFeePerGas ?? 0n;
    if (maxFee > cap) {
      throw new TradeBlockedError([`network max fee ${formatEther(maxFee * 10n ** 9n)} exceeds MAX_GAS_GWEI=${this.o.cfg.maxGasGwei} — refusing to trade`]);
    }
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? maxFee / 10n };
  }

  /** Simulate, gas-estimate and send a prepared tx; wait for the receipt. */
  private async sendTx(tx: TxRequest, label: string): Promise<`0x${string}`> {
    const { publicClient, walletClient, account } = this.clients();

    // dry-run first — a revert here costs nothing
    try {
      await publicClient.call({ account: account.address, to: tx.to, data: tx.data, value: tx.value });
    } catch (err) {
      throw new Error(`${label}: simulation reverted — not sending. ${trimErr(err)}`);
    }

    const fees = await this.feeParams(publicClient);
    let gas: bigint;
    try {
      gas = await publicClient.estimateGas({ account: account.address, to: tx.to, data: tx.data, value: tx.value });
    } catch (err) {
      throw new Error(`${label}: gas estimation failed — not sending. ${trimErr(err)}`);
    }

    const send = async () =>
      walletClient.sendTransaction({
        account,
        chain: walletClient.chain,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gas: (gas * 120n) / 100n,
        ...fees,
      });

    let hash: `0x${string}`;
    try {
      hash = await send();
    } catch (err) {
      const msg = trimErr(err);
      // duplicate/underpriced nonce: wait for the pool to settle and retry once
      if (/nonce|replacement|already known/i.test(msg)) {
        log.warn({ label }, 'nonce conflict — retrying once after 3s');
        await new Promise((r) => setTimeout(r, 3000));
        hash = await send();
      } else {
        throw new Error(`${label}: send failed. ${msg}`);
      }
    }

    log.info({ label, hash }, 'transaction sent, waiting for receipt');
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== 'success') {
      throw new Error(`${label}: transaction ${hash} reverted on-chain`);
    }
    return hash;
  }

  private async ensureApproval(token: Address, amount: bigint): Promise<void> {
    const { publicClient, account } = this.clients();
    const spender = this.o.adapter.spender();
    if (!spender) throw new Error('adapter has no spender (mock adapter cannot trade on-chain)');
    const allowance = await currentAllowance(publicClient, token, account.address as Address, spender);
    if (allowance >= amount) return;
    // exact approval only — never unlimited
    log.info({ token, spender, amount: amount.toString() }, 'sending exact approval');
    const tx = buildApproveTx(token, spender, amount);
    await this.sendTx(tx, `approve(${token})`);
  }

  private async realBuy(token: Address, pool: Address | null, amountInBase: bigint, decimals: number): Promise<{ positionId: number | null; txHash: string | null }> {
    const { cfg, db, adapter } = this.o;
    const { publicClient, account } = this.clients();

    // balance check
    if (cfg.baseTokenIsNativeWrapper) {
      const bal = await publicClient.getBalance({ address: account.address });
      if (bal < amountInBase) {
        throw new TradeBlockedError([`insufficient ETH: balance ${formatEther(bal)}, need ${formatEther(amountInBase)} + gas`]);
      }
    } else {
      if (!cfg.baseTokenAddress) throw new TradeBlockedError(['BASE_TOKEN_ADDRESS missing']);
      await this.ensureApproval(cfg.baseTokenAddress, amountInBase);
    }

    const quoted = await adapter.quoteBuy(token, amountInBase);
    if (quoted <= 0n) throw new Error('buy quote returned 0 — refusing to trade');
    const minOut = applySlippageBps(quoted, cfg.maxSlippageBps);
    const price = priceFromAmounts(amountInBase, quoted, decimals);

    const tx = await adapter.buildBuyTx({ token, amountInBase, minAmountOut: minOut, recipient: account.address as Address, deadlineSec: TX_DEADLINE_SEC });

    const tradeId = db.insertTrade({
      mode: cfg.mode, side: 'buy', token, pool,
      amountIn: amountInBase, amountOut: quoted, price,
      txHash: null, status: 'pending', error: null,
    });

    try {
      const hash = await this.sendTx(tx, `buy(${token})`);
      db.updateTradeStatus(tradeId, 'confirmed', hash, null);
      const positionId = db.openPosition({ token, pool, mode: cfg.mode, entryPrice: price, amountToken: quoted, costBase: amountInBase });
      db.insertEvent('buy', { token, amountInBase: amountInBase.toString(), quoted: quoted.toString(), hash, mode: cfg.mode });
      return { positionId, txHash: hash };
    } catch (err) {
      const msg = trimErr(err);
      db.updateTradeStatus(tradeId, 'failed', null, msg);
      db.insertError('trading', `buy failed: ${msg}`, { token });
      throw err;
    }
  }

  private async realSell(position: Position, percent: number, reason: ExitReason): Promise<{ txHash: string | null }> {
    const { cfg, db, adapter } = this.o;
    const { account } = this.clients();

    const amountTokens = (position.amountToken * BigInt(Math.floor(percent * 100))) / 10_000n;
    if (amountTokens <= 0n) throw new Error('nothing to sell');

    await this.ensureApproval(position.token, amountTokens);

    const quoted = await adapter.quoteSell(position.token, amountTokens);
    const minOut = applySlippageBps(quoted, cfg.maxSlippageBps);
    const tx = await adapter.buildSellTx({
      token: position.token, amountTokens, minAmountOutBase: minOut,
      recipient: account.address as Address, deadlineSec: TX_DEADLINE_SEC,
    });

    const tradeId = db.insertTrade({
      mode: cfg.mode, side: 'sell', token: position.token, pool: position.pool,
      amountIn: amountTokens, amountOut: quoted, price: position.currentPrice,
      txHash: null, status: 'pending', error: null,
    });

    try {
      const hash = await this.sendTx(tx, `sell(${position.token})`);
      db.updateTradeStatus(tradeId, 'confirmed', hash, null);
      db.reducePosition(position.id, amountTokens, percent >= 100 ? reason : null);
      db.insertEvent('sell', { token: position.token, amountTokens: amountTokens.toString(), quoted: quoted.toString(), hash, reason });
      return { txHash: hash };
    } catch (err) {
      const msg = trimErr(err);
      db.updateTradeStatus(tradeId, 'failed', null, msg);
      db.insertError('trading', `sell failed: ${msg}`, { token: position.token });
      throw err;
    }
  }
}

function trimErr(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}
