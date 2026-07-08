import { describe, expect, it, beforeEach } from 'vitest';
import { BotDb } from '../src/storage/db.js';
import type { Address, PoolInfo } from '../src/types/index.js';

const TOKEN = ('0x' + '2'.repeat(40)) as Address;
const POOL = ('0x' + '3'.repeat(40)) as Address;
const BASE = ('0x' + '4'.repeat(40)) as Address;

function poolInfo(): PoolInfo {
  return { address: POOL, dex: 'mock', token: TOKEN, baseToken: BASE, token0: BASE, token1: TOKEN, blockNumber: 123n };
}

describe('BotDb persistence', () => {
  let db: BotDb;
  beforeEach(() => {
    db = new BotDb(':memory:');
  });

  it('creates schema and stores settings', () => {
    db.setSetting('foo', 'bar');
    expect(db.getSetting('foo')).toBe('bar');
    db.setSetting('foo', 'baz');
    expect(db.getSetting('foo')).toBe('baz');
    expect(db.getSetting('missing')).toBeNull();
  });

  it('deduplicates pools', () => {
    expect(db.insertPool(poolInfo(), 100n)).toBe(true);
    expect(db.insertPool(poolInfo(), 100n)).toBe(false);
    expect(db.hasPool(POOL)).toBe(true);
    expect(db.listPools()).toHaveLength(1);
  });

  it('stores tokens, flags and safety reports', () => {
    db.upsertToken({ address: TOKEN, name: 'T', symbol: 'T', decimals: 18, totalSupply: 1000n });
    db.flagToken(TOKEN, 'honeypot');
    const t = db.getToken(TOKEN)!;
    expect(t.flagged).toBe(1);
    const id = db.insertSafetyReport({
      token: TOKEN, pool: POOL, passed: false,
      criticalFailures: ['sell_quote: reverted'], warnings: [], findings: [],
      meta: null, liquidityBase: null, estimatedBuyTaxBps: null, estimatedSellTaxBps: null,
    });
    expect(id).toBeGreaterThan(0);
  });

  it('round-trips bigint amounts through trades', () => {
    const big = 123456789012345678901234567890n;
    db.insertTrade({ mode: 'paper', side: 'buy', token: TOKEN, pool: POOL, amountIn: big, amountOut: big * 2n, price: 0.5, txHash: null, status: 'simulated', error: null });
    const [t] = db.listTrades(1);
    expect(BigInt(t!.amount_in as string)).toBe(big);
    expect(BigInt(t!.amount_out as string)).toBe(big * 2n);
  });

  it('opens, reduces and closes positions with proportional cost basis', () => {
    const id = db.openPosition({ token: TOKEN, pool: POOL, mode: 'paper', entryPrice: 0.001, amountToken: 1000n, costBase: 10_000n });
    db.reducePosition(id, 400n, null); // partial
    let pos = db.getPosition(id)!;
    expect(pos.status).toBe('open');
    expect(pos.amountToken).toBe(600n);
    expect(pos.costBase).toBe(6000n);
    db.reducePosition(id, 600n, 'take_profit'); // rest
    pos = db.getPosition(id)!;
    expect(pos.status).toBe('closed');
    expect(pos.closeReason).toBe('take_profit');
    expect(db.openPositions()).toHaveLength(0);
  });

  it('records events and errors with bigint-safe JSON', () => {
    db.insertEvent('pool_discovered', { amount: 5n, token: TOKEN });
    db.insertError('scanner', 'boom', { block: 42n });
    const events = db.listEvents('pool_discovered');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data_json).amount).toBe('5');
  });
});
