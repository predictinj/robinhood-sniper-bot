import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { BotDb } from '../src/storage/db.js';
import { MockDexAdapter } from '../src/dex/mock.js';
import { TradingEngine, TradeBlockedError } from '../src/trading/engine.js';
import { loadConfig } from '../src/config/index.js';
import { runSafetyChecks } from '../src/safety/checks.js';

const VALID_KEY = ('0x' + 'a'.repeat(64)) as `0x${string}`;

function makeEngine(env: Record<string, string> = {}, db = new BotDb(':memory:')) {
  const cfg = loadConfig({ MODE: 'paper', COOLDOWN_SECONDS: '0', MAX_BUY_ETH: '1', ...env });
  const mock = new MockDexAdapter({});
  const engine = new TradingEngine({ cfg, db, adapter: mock, publicClient: null, walletClient: null, account: null });
  return { cfg, db, mock, engine };
}

describe('trading engine risk gating', () => {
  it('refuses a buy above MAX_BUY_ETH in every mode', async () => {
    const { mock, engine } = makeEngine({ MAX_BUY_ETH: '0.5' });
    const pool = mock.createPool({ sellable: true });
    await expect(engine.buy(pool.token, pool.address, parseEther('1'))).rejects.toThrow(TradeBlockedError);
  });

  it('enforces MAX_OPEN_POSITIONS', async () => {
    const { mock, engine } = makeEngine({ MAX_OPEN_POSITIONS: '1' });
    const p1 = mock.createPool({ sellable: true });
    const p2 = mock.createPool({ sellable: true });
    await engine.buy(p1.token, p1.address, parseEther('0.5'));
    await expect(engine.buy(p2.token, p2.address, parseEther('0.5'))).rejects.toThrow(/MAX_OPEN_POSITIONS/);
  });

  it('enforces the cooldown between buys', async () => {
    const { mock, engine } = makeEngine({ COOLDOWN_SECONDS: '3600', MAX_OPEN_POSITIONS: '10' });
    const p1 = mock.createPool({ sellable: true });
    const p2 = mock.createPool({ sellable: true });
    await engine.buy(p1.token, p1.address, parseEther('0.5'));
    await expect(engine.buy(p2.token, p2.address, parseEther('0.5'))).rejects.toThrow(/cooldown/i);
  });

  it('refuses to buy a token that failed safety checks', async () => {
    const { cfg, mock, engine } = makeEngine();
    const pool = mock.createPool({ sellable: false }); // honeypot
    const report = await runSafetyChecks({ client: null, adapter: mock, cfg }, pool);
    expect(report.passed).toBe(false);
    await expect(engine.buy(pool.token, pool.address, parseEther('0.5'), report)).rejects.toThrow(/failed safety checks/);
  });

  it('blocks everything under emergency stop, including paper buys', async () => {
    const { db, mock, engine } = makeEngine();
    db.setSetting('emergency_stop', '1');
    const pool = mock.createPool({ sellable: true });
    await expect(engine.buy(pool.token, pool.address, parseEther('0.5'))).rejects.toThrow(/EMERGENCY STOP/);
  });

  it('never sends real trades in live mode without full arming', async () => {
    const db = new BotDb(':memory:');
    const { mock, engine } = makeEngine(
      {
        MODE: 'live',
        ENABLE_LIVE_TRADING: 'true',
        PRIVATE_KEY: VALID_KEY,
        // DEX addresses intentionally missing + no confirm-live
      },
      db,
    );
    const pool = mock.createPool({ sellable: true });
    try {
      await engine.buy(pool.token, pool.address, parseEther('0.5'));
      expect.unreachable('buy should have been blocked');
    } catch (err) {
      expect(err).toBeInstanceOf(TradeBlockedError);
      const blockers = (err as TradeBlockedError).blockers.join(' ');
      expect(blockers).toContain('DEX_ROUTER_ADDRESS');
      expect(blockers).toContain('confirm-live');
    }
    expect(db.listTrades(10)).toHaveLength(0); // nothing recorded, nothing sent
  });

  it('sell fails cleanly when there is no open position', async () => {
    const { mock, engine } = makeEngine();
    const pool = mock.createPool({ sellable: true });
    await expect(engine.sell(pool.token, 100, 'manual')).rejects.toThrow(/no open position/);
  });

  it('testnet mode without a private key is blocked with a clear reason', async () => {
    const { mock, engine } = makeEngine({ MODE: 'testnet', CHAIN_ID: '46630' });
    const pool = mock.createPool({ sellable: true });
    try {
      await engine.buy(pool.token, pool.address, parseEther('0.5'));
      expect.unreachable('buy should have been blocked');
    } catch (err) {
      expect(err).toBeInstanceOf(TradeBlockedError);
      expect((err as TradeBlockedError).blockers.join(' ')).toContain('PRIVATE_KEY');
    }
  });
});

describe('failed transaction bookkeeping', () => {
  it('a paper buy that cannot be quoted records no phantom position', async () => {
    const { db, mock, engine } = makeEngine();
    const fake = ('0x' + 'f'.repeat(40)) as `0x${string}`;
    await expect(engine.buy(fake, null, parseEther('0.5'))).rejects.toThrow(/unknown token/);
    expect(db.openPositions()).toHaveLength(0);
    expect(db.listTrades(10)).toHaveLength(0);
  });
});
