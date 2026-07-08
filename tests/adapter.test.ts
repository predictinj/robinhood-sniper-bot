import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { MockDexAdapter } from '../src/dex/mock.js';
import { createAdapter, dexFullyConfigured, DexConfigError } from '../src/dex/index.js';
import { loadConfig } from '../src/config/index.js';
import type { ChainClients } from '../src/chain/client.js';
import type { PoolInfo } from '../src/types/index.js';

const fakeClients = { publicClient: null, subscriptionClient: null, walletClient: null, account: null } as unknown as ChainClients;

describe('DEX adapter interface (mock)', () => {
  it('emits pools via watchNewPools and stops on unsubscribe', async () => {
    const mock = new MockDexAdapter({ emitIntervalMs: 10 });
    const seen: PoolInfo[] = [];
    const unwatch = mock.watchNewPools((p) => seen.push(p), () => {});
    await new Promise((r) => setTimeout(r, 60));
    unwatch();
    const count = seen.length;
    expect(count).toBeGreaterThan(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(seen.length).toBe(count); // no emissions after unsubscribe
  });

  it('scanNewPools returns pools quoted in the base token', async () => {
    const mock = new MockDexAdapter({});
    const pools = await mock.scanNewPools(0n, 100n);
    expect(pools.length).toBeGreaterThan(0);
    for (const p of pools) {
      expect(p.baseToken).toBe(mock.baseToken);
      expect([p.token0, p.token1]).toContain(p.token);
    }
  });

  it('round-trip quotes are consistent with taxes', async () => {
    const mock = new MockDexAdapter({});
    const pool = mock.createPool({ sellable: true, buyTaxBps: 500, sellTaxBps: 500 });
    const out = await mock.quoteBuy(pool.token, parseEther('1'));
    const back = await mock.quoteSell(pool.token, out);
    const roundTrip = Number(back) / 1e18;
    expect(roundTrip).toBeGreaterThan(0.85); // 5%+5% tax ≈ 0.9025
    expect(roundTrip).toBeLessThan(0.95);
  });

  it('refuses to build real transactions', async () => {
    const mock = new MockDexAdapter({});
    await expect(mock.buildBuyTx()).rejects.toThrow(/mock adapter cannot build real transactions/);
    await expect(mock.buildSellTx()).rejects.toThrow(/mock adapter cannot build real transactions/);
    expect(mock.spender()).toBeNull();
  });
});

describe('adapter factory', () => {
  it('builds the mock adapter with no addresses required', () => {
    const cfg = loadConfig({ DEX_TYPE: 'mock' });
    expect(createAdapter(cfg, fakeClients).name).toBe('mock');
    expect(dexFullyConfigured(cfg)).toBe(false);
  });

  it('requires addresses for uniswap_v2', () => {
    const cfg = loadConfig({ DEX_TYPE: 'uniswap_v2' });
    expect(() => createAdapter(cfg, fakeClients)).toThrow(DexConfigError);
    expect(dexFullyConfigured(cfg)).toBe(false);
  });

  it('requires the quoter for uniswap_v3', () => {
    const addr = '0x' + '1'.repeat(40);
    const cfg = loadConfig({ DEX_TYPE: 'uniswap_v3', DEX_FACTORY_ADDRESS: addr, DEX_ROUTER_ADDRESS: addr, BASE_TOKEN_ADDRESS: addr });
    expect(() => createAdapter(cfg, fakeClients)).toThrow(/QUOTER/);
    expect(dexFullyConfigured(cfg)).toBe(false);
  });

  it('reports fully configured when all v2 addresses are present', () => {
    const addr = '0x' + '1'.repeat(40);
    const cfg = loadConfig({ DEX_TYPE: 'uniswap_v2', DEX_FACTORY_ADDRESS: addr, DEX_ROUTER_ADDRESS: addr, BASE_TOKEN_ADDRESS: addr });
    expect(dexFullyConfigured(cfg)).toBe(true);
    expect(createAdapter(cfg, fakeClients).name).toBe('uniswap_v2');
  });
});
