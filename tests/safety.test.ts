import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { MockDexAdapter } from '../src/dex/mock.js';
import { runSafetyChecks } from '../src/safety/checks.js';
import { loadConfig } from '../src/config/index.js';

const cfg = loadConfig({ MIN_LIQUIDITY_ETH: '1', MAX_TOKEN_TAX_BPS: '1000' });

describe('token safety checks', () => {
  it('passes a healthy token', async () => {
    const mock = new MockDexAdapter({});
    const pool = mock.createPool({ sellable: true, buyTaxBps: 100, sellTaxBps: 100, liquidityBase: parseEther('10') });
    const report = await runSafetyChecks({ client: null, adapter: mock, cfg }, pool);
    expect(report.passed).toBe(true);
    expect(report.criticalFailures).toEqual([]);
    expect(report.meta?.symbol).toMatch(/^MOCK/);
    expect(report.estimatedBuyTaxBps).toBe(100);
  });

  it('fails a honeypot (sell quote reverts)', async () => {
    const mock = new MockDexAdapter({});
    const pool = mock.createPool({ sellable: false, buyTaxBps: 0, sellTaxBps: 0, liquidityBase: parseEther('10') });
    const report = await runSafetyChecks({ client: null, adapter: mock, cfg }, pool);
    expect(report.passed).toBe(false);
    expect(report.criticalFailures.join(' ')).toMatch(/honeypot|sell/i);
  });

  it('fails a token whose taxes exceed MAX_TOKEN_TAX_BPS', async () => {
    const mock = new MockDexAdapter({});
    const pool = mock.createPool({ sellable: true, buyTaxBps: 900, sellTaxBps: 900, liquidityBase: parseEther('10') });
    const report = await runSafetyChecks({ client: null, adapter: mock, cfg }, pool);
    expect(report.passed).toBe(false);
    expect(report.criticalFailures.join(' ')).toContain('token_tax');
  });

  it('fails a pool with too little liquidity', async () => {
    const mock = new MockDexAdapter({});
    const pool = mock.createPool({ sellable: true, buyTaxBps: 0, sellTaxBps: 0, liquidityBase: parseEther('0.1') });
    const report = await runSafetyChecks({ client: null, adapter: mock, cfg }, pool);
    expect(report.passed).toBe(false);
    expect(report.criticalFailures.join(' ')).toContain('min_liquidity');
  });

  it('fails a pool not quoted in the configured base token', async () => {
    const mock = new MockDexAdapter({});
    const cfgWithBase = loadConfig({ BASE_TOKEN_ADDRESS: '0x' + '9'.repeat(40) });
    const pool = mock.createPool({ sellable: true, liquidityBase: parseEther('10') });
    const report = await runSafetyChecks({ client: null, adapter: mock, cfg: cfgWithBase }, pool);
    expect(report.passed).toBe(false);
    expect(report.criticalFailures.join(' ')).toContain('base_token_pair');
  });
});
