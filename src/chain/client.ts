import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  type PublicClient,
  type WalletClient,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { BotConfig } from '../config/index.js';
import { chainFor } from './chains.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('chain');

export interface ChainClients {
  publicClient: PublicClient;
  /** separate WS-backed client for subscriptions when ROBINHOOD_WS_URL is set */
  subscriptionClient: PublicClient;
  walletClient: WalletClient | null;
  account: Account | null;
}

/** Create viem clients for the configured chain. Throws on invalid private key. */
export function createClients(cfg: BotConfig): ChainClients {
  const chain = chainFor(cfg.chainId, cfg.rpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: http(cfg.rpcUrl, { retryCount: 3, retryDelay: 500 }),
  });

  const subscriptionClient = cfg.wsUrl
    ? createPublicClient({ chain, transport: webSocket(cfg.wsUrl, { retryCount: 10 }) })
    : publicClient;

  let account: Account | null = null;
  let walletClient: WalletClient | null = null;
  if (cfg.privateKey) {
    try {
      account = privateKeyToAccount(cfg.privateKey);
    } catch {
      // do not include the key material in the error
      throw new Error('PRIVATE_KEY is not a valid secp256k1 private key');
    }
    if (cfg.walletAddress && account.address.toLowerCase() !== cfg.walletAddress.toLowerCase()) {
      throw new Error(
        `WALLET_ADDRESS (${cfg.walletAddress}) does not match the address derived from PRIVATE_KEY (${account.address})`,
      );
    }
    walletClient = createWalletClient({ chain, account, transport: http(cfg.rpcUrl) });
  }

  return { publicClient, subscriptionClient, walletClient, account };
}

/**
 * Verify the RPC is reachable and reports the expected chain id.
 * Returns a human-readable problem string, or null if everything checks out.
 */
export async function verifyChain(publicClient: PublicClient, expectedChainId: number): Promise<string | null> {
  try {
    const actual = await publicClient.getChainId();
    if (actual !== expectedChainId) {
      return `RPC reports chain id ${actual}, expected ${expectedChainId} — wrong RPC URL or CHAIN_ID`;
    }
    return null;
  } catch (err) {
    log.warn({ err: String(err) }, 'RPC connectivity check failed');
    return `cannot reach RPC: ${err instanceof Error ? err.message : String(err)}`;
  }
}
