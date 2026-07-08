import type { ExitReason, Position } from '../types/index.js';
import type { BotConfig } from '../config/index.js';
import type { DexAdapter } from '../dex/adapter.js';
import type { BotDb } from '../storage/db.js';
import type { TradingEngine } from './engine.js';
import { pnlPercent, priceFromAmounts } from '../utils/math.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('positions');

export interface ExitRules {
  takeProfitPercent: number;
  stopLossPercent: number;
  trailingStopPercent?: number;
}

/**
 * Pure exit decision — easy to test. Returns the reason to close, or null.
 * Priority: stop-loss > take-profit > trailing stop.
 */
export function evaluateExit(
  entryPrice: number,
  currentPrice: number,
  highWaterPrice: number,
  rules: ExitRules,
): ExitReason | null {
  const pnl = pnlPercent(entryPrice, currentPrice);
  if (rules.stopLossPercent > 0 && pnl <= -rules.stopLossPercent) return 'stop_loss';
  if (rules.takeProfitPercent > 0 && pnl >= rules.takeProfitPercent) return 'take_profit';
  if (rules.trailingStopPercent && highWaterPrice > 0) {
    const dropFromHigh = ((highWaterPrice - currentPrice) / highWaterPrice) * 100;
    if (dropFromHigh >= rules.trailingStopPercent && currentPrice > entryPrice) return 'trailing_stop';
  }
  return null;
}

/**
 * Periodically re-prices open positions via the adapter and triggers
 * take-profit / stop-loss / trailing-stop sells through the trading engine.
 */
export class PositionManager {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly cfg: BotConfig,
    private readonly db: BotDb,
    private readonly adapter: DexAdapter,
    private readonly engine: TradingEngine,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.positionPollMs);
    this.timer.unref?.();
    log.info({ intervalMs: this.cfg.positionPollMs }, 'position manager started');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One re-pricing pass over all open positions. Safe to call directly (tests/CLI). */
  async tick(): Promise<void> {
    if (this.running) return; // don't overlap slow ticks
    this.running = true;
    try {
      for (const pos of this.db.openPositions()) {
        await this.evaluatePosition(pos);
      }
    } finally {
      this.running = false;
    }
  }

  private async evaluatePosition(pos: Position): Promise<void> {
    let currentPrice: number;
    try {
      const quote = await this.adapter.quoteSell(pos.token, pos.amountToken);
      currentPrice = priceFromAmounts(quote, pos.amountToken, 18);
    } catch (err) {
      // an unsellable position is an emergency of its own — flag loudly but keep going
      this.db.insertError('positions', `cannot price position ${pos.id} (${pos.token}): ${String(err)}`);
      log.warn({ position: pos.id, token: pos.token, err: String(err) }, 'position pricing failed — token may have become unsellable');
      return;
    }

    const high = Math.max(pos.highWaterPrice, currentPrice);
    const pnl = pnlPercent(pos.entryPrice, currentPrice);
    this.db.updatePositionPrice(pos.id, currentPrice, pnl, high);
    this.db.insertEvent('price', { token: pos.token, position: pos.id, price: currentPrice, pnl });

    const reason = evaluateExit(pos.entryPrice, currentPrice, high, {
      takeProfitPercent: this.cfg.takeProfitPercent,
      stopLossPercent: this.cfg.stopLossPercent,
      trailingStopPercent: this.cfg.trailingStopPercent,
    });
    if (!reason) return;

    log.info({ position: pos.id, token: pos.token, pnl: pnl.toFixed(2), reason }, 'exit triggered');
    try {
      await this.engine.sell(pos.token, 100, reason);
    } catch (err) {
      this.db.insertError('positions', `auto-sell failed for position ${pos.id}: ${String(err)}`);
      log.error({ position: pos.id, err: String(err) }, 'auto-sell failed — will retry next tick');
    }
  }
}
