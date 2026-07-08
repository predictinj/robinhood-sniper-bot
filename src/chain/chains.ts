import { defineChain, type Chain } from 'viem';
import {
  ROBINHOOD_MAINNET_ID,
  ROBINHOOD_MAINNET_RPC,
  ROBINHOOD_TESTNET_ID,
  ROBINHOOD_TESTNET_RPC,
} from '../config/index.js';

export const robinhoodMainnet: Chain = defineChain({
  id: ROBINHOOD_MAINNET_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_MAINNET_RPC] } },
});

export const robinhoodTestnet: Chain = defineChain({
  id: ROBINHOOD_TESTNET_ID,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_TESTNET_RPC] } },
  testnet: true,
});

/** Build a Chain object for the configured chain id + RPC. */
export function chainFor(chainId: number, rpcUrl: string): Chain {
  if (chainId === ROBINHOOD_MAINNET_ID) return { ...robinhoodMainnet, rpcUrls: { default: { http: [rpcUrl] } } };
  if (chainId === ROBINHOOD_TESTNET_ID) return { ...robinhoodTestnet, rpcUrls: { default: { http: [rpcUrl] } } };
  return defineChain({
    id: chainId,
    name: `Custom EVM chain ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}
