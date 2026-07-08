import type { BotConfig } from '../config/index.js';
import type { ChainClients } from '../chain/client.js';
import type { DexAdapter } from './adapter.js';
import { MockDexAdapter, MOCK_BASE_TOKEN } from './mock.js';
import { UniswapV2Adapter } from './uniswapV2.js';
import { UniswapV3Adapter } from './uniswapV3.js';

export class DexConfigError extends Error {}

/**
 * Build the configured DEX adapter. Real adapters require the router/factory
 * (and quoter for v3) addresses from .env — if they are missing, the caller
 * should fall back to monitor/simulation mode with the mock adapter.
 */
export function createAdapter(cfg: BotConfig, clients: ChainClients): DexAdapter {
  switch (cfg.dexType) {
    case 'mock':
      return new MockDexAdapter({ baseToken: cfg.baseTokenAddress ?? MOCK_BASE_TOKEN });
    case 'uniswap_v2': {
      if (!cfg.dexFactoryAddress || !cfg.dexRouterAddress || !cfg.baseTokenAddress) {
        throw new DexConfigError(
          'uniswap_v2 adapter requires DEX_FACTORY_ADDRESS, DEX_ROUTER_ADDRESS and BASE_TOKEN_ADDRESS in .env',
        );
      }
      return new UniswapV2Adapter({
        publicClient: clients.publicClient,
        subscriptionClient: clients.subscriptionClient,
        factory: cfg.dexFactoryAddress,
        router: cfg.dexRouterAddress,
        baseToken: cfg.baseTokenAddress,
        baseIsNativeWrapper: cfg.baseTokenIsNativeWrapper,
      });
    }
    case 'uniswap_v3': {
      if (!cfg.dexFactoryAddress || !cfg.dexRouterAddress || !cfg.dexQuoterAddress || !cfg.baseTokenAddress) {
        throw new DexConfigError(
          'uniswap_v3 adapter requires DEX_FACTORY_ADDRESS, DEX_ROUTER_ADDRESS, DEX_QUOTER_ADDRESS and BASE_TOKEN_ADDRESS in .env',
        );
      }
      return new UniswapV3Adapter({
        publicClient: clients.publicClient,
        subscriptionClient: clients.subscriptionClient,
        factory: cfg.dexFactoryAddress,
        router: cfg.dexRouterAddress,
        quoter: cfg.dexQuoterAddress,
        baseToken: cfg.baseTokenAddress,
        baseIsNativeWrapper: cfg.baseTokenIsNativeWrapper,
      });
    }
  }
}

/**
 * Whether the config has everything a REAL adapter needs. When false the bot
 * runs in monitor/simulation mode and tells the user what to configure.
 */
export function dexFullyConfigured(cfg: BotConfig): boolean {
  if (cfg.dexType === 'mock') return false;
  if (!cfg.dexFactoryAddress || !cfg.dexRouterAddress || !cfg.baseTokenAddress) return false;
  if (cfg.dexType === 'uniswap_v3' && !cfg.dexQuoterAddress) return false;
  return true;
}
