import { describe, expect, it } from 'vitest';
import { ConfigError, liveTradingBlockers, loadConfig } from '../src/config/index.js';

const VALID_KEY = '0x' + 'a'.repeat(64);
const ADDR = '0x' + '1'.repeat(40);

describe('config validation', () => {
  it('applies safe defaults for an empty env', () => {
    const cfg = loadConfig({});
    expect(cfg.mode).toBe('paper');
    expect(cfg.dexType).toBe('mock');
    expect(cfg.enableLiveTrading).toBe(false);
    expect(cfg.chainId).toBe(4663);
    expect(cfg.maxBuyEth).toBeGreaterThan(0);
  });

  it('uses testnet chain defaults when MODE=testnet', () => {
    const cfg = loadConfig({ MODE: 'testnet' });
    expect(cfg.chainId).toBe(46630);
    expect(cfg.rpcUrl).toContain('testnet');
  });

  it('rejects an invalid private key format', () => {
    expect(() => loadConfig({ PRIVATE_KEY: 'not-a-key' })).toThrow(ConfigError);
    expect(() => loadConfig({ PRIVATE_KEY: '0x1234' })).toThrow(ConfigError);
  });

  it('rejects invalid addresses', () => {
    expect(() => loadConfig({ DEX_ROUTER_ADDRESS: '0x123' })).toThrow(ConfigError);
    expect(() => loadConfig({ BASE_TOKEN_ADDRESS: 'nope' })).toThrow(ConfigError);
  });

  it('rejects testnet mode with mainnet chain id and vice versa', () => {
    expect(() => loadConfig({ MODE: 'testnet', CHAIN_ID: '4663' })).toThrow(/mainnet chain id/);
    expect(() => loadConfig({ MODE: 'live', CHAIN_ID: '46630' })).toThrow(/testnet chain id/);
  });

  it('rejects out-of-range risk values', () => {
    expect(() => loadConfig({ MAX_SLIPPAGE_BPS: '20000' })).toThrow(ConfigError);
    expect(() => loadConfig({ STOP_LOSS_PERCENT: '150' })).toThrow(ConfigError);
  });

  it('treats empty strings as unset', () => {
    const cfg = loadConfig({ PRIVATE_KEY: '', DEX_ROUTER_ADDRESS: '', TRAILING_STOP_PERCENT: '' });
    expect(cfg.privateKey).toBeUndefined();
    expect(cfg.dexRouterAddress).toBeUndefined();
    expect(cfg.trailingStopPercent).toBeUndefined();
  });
});

describe('liveTradingBlockers', () => {
  const liveEnv = {
    MODE: 'live',
    ENABLE_LIVE_TRADING: 'true',
    PRIVATE_KEY: VALID_KEY,
    DEX_TYPE: 'uniswap_v2',
    DEX_FACTORY_ADDRESS: ADDR,
    DEX_ROUTER_ADDRESS: ADDR,
    BASE_TOKEN_ADDRESS: ADDR,
  };

  it('blocks when anything is missing', () => {
    const cfg = loadConfig({ MODE: 'paper' });
    const blockers = liveTradingBlockers(cfg, { liveConfirmed: false, emergencyStop: false });
    expect(blockers.length).toBeGreaterThan(3);
    expect(blockers.join(' ')).toContain('MODE');
    expect(blockers.join(' ')).toContain('ENABLE_LIVE_TRADING');
    expect(blockers.join(' ')).toContain('confirm-live');
  });

  it('blocks without CLI confirmation even when env is fully set', () => {
    const cfg = loadConfig(liveEnv);
    const blockers = liveTradingBlockers(cfg, { liveConfirmed: false, emergencyStop: false });
    expect(blockers).toEqual(['live trading has not been confirmed via `bot confirm-live`']);
  });

  it('blocks on emergency stop', () => {
    const cfg = loadConfig(liveEnv);
    const blockers = liveTradingBlockers(cfg, { liveConfirmed: true, emergencyStop: true });
    expect(blockers.join(' ')).toContain('EMERGENCY STOP');
  });

  it('is clear when fully armed', () => {
    const cfg = loadConfig(liveEnv);
    expect(liveTradingBlockers(cfg, { liveConfirmed: true, emergencyStop: false })).toEqual([]);
  });

  it('always blocks the mock adapter from live trading', () => {
    const cfg = loadConfig({ ...liveEnv, DEX_TYPE: 'mock' });
    const blockers = liveTradingBlockers(cfg, { liveConfirmed: true, emergencyStop: false });
    expect(blockers.join(' ')).toContain('mock');
  });
});
