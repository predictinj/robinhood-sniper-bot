import type { Address, PoolInfo, TxRequest } from '../types/index.js';

/**
 * Adapter interface every DEX integration implements.
 *
 * Robinhood Chain's DEX landscape may change, so nothing chain-specific is
 * hardcoded: factory/router/quoter addresses come from config, and new DEX
 * styles are added by implementing this interface (see docs/DEX_ADAPTERS.md).
 *
 * Amount conventions:
 *  - "base" amounts are in wei of the configured base token (18 decimals assumed for ETH/WETH).
 *  - "token" amounts are raw units of the target token.
 */
export interface DexAdapter {
  readonly name: string;

  /** Scan a historical block range for newly created pools that include the base token. */
  scanNewPools(fromBlock: bigint, toBlock: bigint): Promise<PoolInfo[]>;

  /**
   * Subscribe to new pool creations. Returns an unsubscribe function.
   * Implementations must call onError instead of throwing so the scanner can
   * reconnect.
   */
  watchNewPools(onPool: (pool: PoolInfo) => void, onError: (err: Error) => void): () => void;

  /** Base-token side of the pool's reserves/liquidity, in base wei. */
  getPoolLiquidityBase(pool: PoolInfo): Promise<bigint>;

  /** Expected token amount out for a buy of `amountInBase` base wei. */
  quoteBuy(token: Address, amountInBase: bigint): Promise<bigint>;

  /** Expected base wei out for selling `amountTokens` raw token units. */
  quoteSell(token: Address, amountTokens: bigint): Promise<bigint>;

  /** Build (but do not send) the swap transaction for a buy. */
  buildBuyTx(params: { token: Address; amountInBase: bigint; minAmountOut: bigint; recipient: Address; deadlineSec: number }): Promise<TxRequest>;

  /** Build (but do not send) the swap transaction for a sell. */
  buildSellTx(params: { token: Address; amountTokens: bigint; minAmountOutBase: bigint; recipient: Address; deadlineSec: number }): Promise<TxRequest>;

  /** The contract that must be approved to spend tokens for sells (and base-token buys). */
  spender(): Address | null;

  /**
   * Optional: best-effort buy/sell tax estimate in bps.
   * Real chains often can't provide this without a trace; return null when unknown.
   */
  estimateTaxesBps?(token: Address): Promise<{ buyBps: number; sellBps: number } | null>;

  /**
   * Optional: token metadata without chain access (used by the mock adapter).
   * Real adapters omit this; metadata is read from the ERC20 contract instead.
   */
  getTokenMeta?(token: Address): Promise<{ name: string; symbol: string; decimals: number; totalSupply: bigint } | null>;
}
