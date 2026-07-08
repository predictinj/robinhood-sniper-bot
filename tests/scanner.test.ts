import { describe, expect, it } from 'vitest';
import { BotDb } from '../src/storage/db.js';
import { MockDexAdapter } from '../src/dex/mock.js';
import { Scanner } from '../src/scanner/scanner.js';
import type { PoolInfo } from '../src/types/index.js';

describe('scanner', () => {
  it('stores discovered pools once and calls onNewPool for each new pool', async () => {
    const db = new BotDb(':memory:');
    const mock = new MockDexAdapter({});
    const seen: PoolInfo[] = [];
    const scanner = new Scanner({ publicClient: null, adapter: mock, db, onNewPool: (p) => void seen.push(p) });

    const fresh = await scanner.scanRange(0n, 100n);
    expect(fresh.length).toBeGreaterThan(0);
    expect(seen.length).toBe(fresh.length);
    expect(db.listPools().length).toBe(fresh.length);
    expect(db.listEvents('pool_discovered').length).toBe(fresh.length);
  });

  it('dedupes pools that are discovered twice', async () => {
    const db = new BotDb(':memory:');
    const mock = new MockDexAdapter({});
    let calls = 0;
    const scanner = new Scanner({ publicClient: null, adapter: mock, db, onNewPool: () => void calls++ });

    const pool = mock.createPool({ sellable: true });
    // simulate the same pool arriving twice (e.g. WS + poll race)
    await (scanner as unknown as { handleDiscovered: (p: PoolInfo) => Promise<boolean> }).handleDiscovered(pool);
    await (scanner as unknown as { handleDiscovered: (p: PoolInfo) => Promise<boolean> }).handleDiscovered(pool);
    expect(calls).toBe(1);
    expect(db.listPools().length).toBe(1);
  });

  it('keeps running when the onNewPool pipeline throws', async () => {
    const db = new BotDb(':memory:');
    const mock = new MockDexAdapter({});
    const scanner = new Scanner({
      publicClient: null,
      adapter: mock,
      db,
      onNewPool: () => {
        throw new Error('pipeline exploded');
      },
    });
    await expect(scanner.scanRange(0n, 100n)).resolves.toBeDefined();
    const errors = db.db.prepare('SELECT * FROM errors').all() as Array<{ scope: string; message: string }>;
    expect(errors.some((e) => e.message.includes('pipeline exploded'))).toBe(true);
  });

  it('watch mode discovers pools continuously and stops cleanly', async () => {
    const db = new BotDb(':memory:');
    const mock = new MockDexAdapter({ emitIntervalMs: 15 });
    let count = 0;
    const scanner = new Scanner({ publicClient: null, adapter: mock, db, onNewPool: () => void count++, reconnectDelayMs: 10 });
    const done = scanner.watch();
    await new Promise((r) => setTimeout(r, 120));
    scanner.stop();
    await done;
    expect(count).toBeGreaterThan(2);
  });
});
