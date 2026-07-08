import { describe, expect, it, beforeEach } from 'vitest';
import { parseEther } from 'viem';
import { BotDb } from '../src/storage/db.js';
import { MockDexAdapter } from '../src/dex/mock.js';
import { PaperEngine } from '../src/simulation/paper.js';

describe('paper trading', () => {
  let db: BotDb;
  let mock: MockDexAdapter;
  let paper: PaperEngine;

  beforeEach(() => {
    db = new BotDb(':memory:');
    mock = new MockDexAdapter({});
    paper = new PaperEngine(db, mock, 10);
  });

  it('starts with the configured balance', () => {
    expect(paper.balance()).toBe(parseEther('10'));
  });

  it('buy fills at quote, debits balance, opens a position and records the trade', async () => {
    const pool = mock.createPool({ sellable: true, buyTaxBps: 0, sellTaxBps: 0 });
    const res = await paper.buy(pool.token, pool.address, parseEther('1'));
    expect(res.amountOut).toBeGreaterThan(0n);
    expect(paper.balance()).toBe(parseEther('9'));
    const pos = db.getPosition(res.positionId)!;
    expect(pos.status).toBe('open');
    expect(pos.amountToken).toBe(res.amountOut);
    const [trade] = db.listTrades(1);
    expect(trade!.side).toBe('buy');
    expect(trade!.status).toBe('simulated');
    expect(trade!.tx_hash).toBeNull();
  });

  it('rejects a buy above the paper balance', async () => {
    const pool = mock.createPool({ sellable: true });
    await expect(paper.buy(pool.token, pool.address, parseEther('11'))).rejects.toThrow(/balance too low/);
  });

  it('sell credits balance and closes the position', async () => {
    const pool = mock.createPool({ sellable: true, buyTaxBps: 0, sellTaxBps: 0 });
    const { positionId } = await paper.buy(pool.token, pool.address, parseEther('1'));
    const pos = db.getPosition(positionId)!;
    const res = await paper.sell(pos, 100, 'manual');
    expect(res.amountOutBase).toBeGreaterThan(parseEther('0.9')); // ~1 ETH minus rounding
    expect(db.getPosition(positionId)!.status).toBe('closed');
    expect(paper.balance()).toBeGreaterThan(parseEther('9.9'));
  });

  it('partial sell keeps the position open with reduced size', async () => {
    const pool = mock.createPool({ sellable: true, buyTaxBps: 0, sellTaxBps: 0 });
    const { positionId, amountOut } = await paper.buy(pool.token, pool.address, parseEther('1'));
    await paper.sell(db.getPosition(positionId)!, 40, 'manual');
    const pos = db.getPosition(positionId)!;
    expect(pos.status).toBe('open');
    expect(pos.amountToken).toBeLessThan(amountOut);
  });

  it('propagates honeypot sell failures instead of faking a fill', async () => {
    const pool = mock.createPool({ sellable: false });
    const { positionId } = await paper.buy(pool.token, pool.address, parseEther('1'));
    await expect(paper.sell(db.getPosition(positionId)!, 100, 'manual')).rejects.toThrow(/not sellable/);
    expect(db.getPosition(positionId)!.status).toBe('open'); // nothing was sold
  });
});
