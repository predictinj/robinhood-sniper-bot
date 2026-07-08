import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { BotDb } from '../src/storage/db.js';
import { MockDexAdapter } from '../src/dex/mock.js';
import { TradingEngine } from '../src/trading/engine.js';
import { PositionManager, evaluateExit } from '../src/trading/positionManager.js';
import { loadConfig } from '../src/config/index.js';

const rules = { takeProfitPercent: 50, stopLossPercent: 20, trailingStopPercent: undefined as number | undefined };

describe('evaluateExit (pure rules)', () => {
  it('holds inside the band', () => {
    expect(evaluateExit(100, 110, 110, rules)).toBeNull();
    expect(evaluateExit(100, 85, 100, rules)).toBeNull();
  });

  it('triggers take-profit at +TP%', () => {
    expect(evaluateExit(100, 150, 150, rules)).toBe('take_profit');
    expect(evaluateExit(100, 200, 200, rules)).toBe('take_profit');
  });

  it('triggers stop-loss at -SL%', () => {
    expect(evaluateExit(100, 80, 100, rules)).toBe('stop_loss');
    expect(evaluateExit(100, 50, 100, rules)).toBe('stop_loss');
  });

  it('stop-loss wins over take-profit rules ordering', () => {
    // pathological config where both could match: SL is evaluated first
    expect(evaluateExit(100, 79, 300, { ...rules, takeProfitPercent: 0 })).toBe('stop_loss');
  });

  it('triggers trailing stop only when in profit and dropped from high', () => {
    const trailing = { takeProfitPercent: 1000, stopLossPercent: 90, trailingStopPercent: 10 };
    expect(evaluateExit(100, 135, 150, trailing)).toBe('trailing_stop'); // -10% from high, above entry
    expect(evaluateExit(100, 146, 150, trailing)).toBeNull(); // only -2.7% from high
    expect(evaluateExit(100, 95, 150, trailing)).toBeNull(); // below entry → let SL handle it
  });
});

function makeEngine(overrides: Record<string, string> = {}) {
  const cfg = loadConfig({
    MODE: 'paper',
    TAKE_PROFIT_PERCENT: '50',
    STOP_LOSS_PERCENT: '20',
    COOLDOWN_SECONDS: '0',
    MAX_BUY_ETH: '1',
    POSITION_POLL_MS: '999999',
    ...overrides,
  });
  const db = new BotDb(':memory:');
  const mock = new MockDexAdapter({});
  const engine = new TradingEngine({ cfg, db, adapter: mock, publicClient: null, walletClient: null, account: null });
  const manager = new PositionManager(cfg, db, mock, engine);
  return { cfg, db, mock, engine, manager };
}

describe('PositionManager auto-exits (paper)', () => {
  it('takes profit automatically when the price pumps', async () => {
    const { db, mock, engine, manager } = makeEngine();
    const pool = mock.createPool({ sellable: true, buyTaxBps: 0, sellTaxBps: 0 });
    const { positionId } = await engine.buy(pool.token, pool.address, parseEther('1'));

    mock.movePrice(pool.token, 1.8); // +80% > TP 50%
    await manager.tick();

    const pos = db.getPosition(positionId!)!;
    expect(pos.status).toBe('closed');
    expect(pos.closeReason).toBe('take_profit');
    expect(engine.paper.balance()).toBeGreaterThan(parseEther('10')); // profit realised
  });

  it('stops loss automatically when the price dumps', async () => {
    const { db, mock, engine, manager } = makeEngine();
    const pool = mock.createPool({ sellable: true, buyTaxBps: 0, sellTaxBps: 0 });
    const { positionId } = await engine.buy(pool.token, pool.address, parseEther('1'));

    mock.movePrice(pool.token, 0.5); // -50% < SL 20%
    await manager.tick();

    const pos = db.getPosition(positionId!)!;
    expect(pos.status).toBe('closed');
    expect(pos.closeReason).toBe('stop_loss');
    expect(engine.paper.balance()).toBeLessThan(parseEther('10')); // loss realised honestly
  });

  it('keeps the position open while inside the band', async () => {
    const { db, mock, engine, manager } = makeEngine();
    const pool = mock.createPool({ sellable: true, buyTaxBps: 0, sellTaxBps: 0 });
    const { positionId } = await engine.buy(pool.token, pool.address, parseEther('1'));

    mock.movePrice(pool.token, 1.1); // +10%
    await manager.tick();

    const pos = db.getPosition(positionId!)!;
    expect(pos.status).toBe('open');
    expect(pos.pnlPercent).toBeGreaterThan(5);
    expect(pos.highWaterPrice).toBeGreaterThan(pos.entryPrice);
  });

  it('survives a token that becomes unsellable (records the error, keeps running)', async () => {
    const { db, mock, engine, manager } = makeEngine();
    const pool = mock.createPool({ sellable: true, buyTaxBps: 0, sellTaxBps: 0 });
    await engine.buy(pool.token, pool.address, parseEther('1'));
    mock.getToken(pool.token)!.sellable = false;

    await expect(manager.tick()).resolves.toBeUndefined();
    const errors = db.db.prepare('SELECT * FROM errors').all() as Array<{ scope: string }>;
    expect(errors.some((e) => e.scope === 'positions')).toBe(true);
  });
});
