import { encodeFunctionData, type PublicClient } from 'viem';
import type { Address, PoolInfo, TxRequest } from '../types/index.js';
import type { DexAdapter } from './adapter.js';
import { erc20Abi, uniswapV3FactoryAbi, uniswapV3QuoterV2Abi, uniswapV3RouterAbi } from './abis.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('dex:v3');

export interface UniswapV3AdapterOptions {
  publicClient: PublicClient;
  subscriptionClient: PublicClient;
  factory: Address;
  router: Address;
  /** QuoterV2 contract — required for quotes (DEX_QUOTER_ADDRESS) */
  quoter: Address;
  baseToken: Address;
  baseIsNativeWrapper: boolean;
  /** default fee tier used when quoting/trading a token (most new pools use 3000) */
  defaultFee?: number;
  pollingIntervalMs?: number;
}

/**
 * Generic UniswapV3-style adapter (factory + SwapRouter + QuoterV2 compatible).
 * Note: v3 buys are always ERC20->ERC20 through the router's exactInputSingle;
 * when the base token is the wrapped native token you must hold WETH-style
 * balance (the adapter does not wrap ETH for you).
 */
export class UniswapV3Adapter implements DexAdapter {
  readonly name = 'uniswap_v3';
  private readonly o: Required<Pick<UniswapV3AdapterOptions, 'defaultFee'>> & UniswapV3AdapterOptions;
  /** remember the fee tier a token's pool was discovered with */
  private readonly feeByToken = new Map<string, number>();

  constructor(opts: UniswapV3AdapterOptions) {
    this.o = { defaultFee: 3000, ...opts };
  }

  private feeFor(token: Address): number {
    return this.feeByToken.get(token.toLowerCase()) ?? this.o.defaultFee;
  }

  private toPoolInfo(token0: Address, token1: Address, fee: number, pool: Address, blockNumber: bigint): PoolInfo | null {
    const base = this.o.baseToken.toLowerCase();
    let token: Address;
    if (token0.toLowerCase() === base) token = token1;
    else if (token1.toLowerCase() === base) token = token0;
    else return null;
    this.feeByToken.set(token.toLowerCase(), fee);
    return { address: pool, dex: this.name, token, baseToken: this.o.baseToken, token0, token1, blockNumber };
  }

  async scanNewPools(fromBlock: bigint, toBlock: bigint): Promise<PoolInfo[]> {
    const logs = await this.o.publicClient.getContractEvents({
      address: this.o.factory,
      abi: uniswapV3FactoryAbi,
      eventName: 'PoolCreated',
      fromBlock,
      toBlock,
    });
    const pools: PoolInfo[] = [];
    for (const l of logs) {
      const { token0, token1, fee, pool } = l.args as { token0: Address; token1: Address; fee: number; pool: Address };
      const info = this.toPoolInfo(token0, token1, Number(fee), pool, l.blockNumber ?? 0n);
      if (info) pools.push(info);
    }
    return pools;
  }

  watchNewPools(onPool: (pool: PoolInfo) => void, onError: (err: Error) => void): () => void {
    return this.o.subscriptionClient.watchContractEvent({
      address: this.o.factory,
      abi: uniswapV3FactoryAbi,
      eventName: 'PoolCreated',
      pollingInterval: this.o.pollingIntervalMs ?? 4000,
      onLogs: (logs) => {
        for (const l of logs) {
          try {
            const { token0, token1, fee, pool } = l.args as { token0: Address; token1: Address; fee: number; pool: Address };
            const info = this.toPoolInfo(token0, token1, Number(fee), pool, l.blockNumber ?? 0n);
            if (info) onPool(info);
          } catch (err) {
            onError(err instanceof Error ? err : new Error(String(err)));
          }
        }
      },
      onError: (err) => onError(err instanceof Error ? err : new Error(String(err))),
    });
  }

  /**
   * v3 has concentrated liquidity, so "reserves" don't exist; we approximate
   * pool depth with the base token's balance held by the pool contract.
   */
  async getPoolLiquidityBase(pool: PoolInfo): Promise<bigint> {
    return (await this.o.publicClient.readContract({
      address: this.o.baseToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [pool.address],
    })) as bigint;
  }

  private async quote(tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number): Promise<bigint> {
    // QuoterV2 quote functions are non-view (they revert internally); use simulateContract.
    const { result } = await this.o.publicClient.simulateContract({
      address: this.o.quoter,
      abi: uniswapV3QuoterV2Abi,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    });
    return (result as readonly [bigint, bigint, number, bigint])[0];
  }

  async quoteBuy(token: Address, amountInBase: bigint): Promise<bigint> {
    return this.quote(this.o.baseToken, token, amountInBase, this.feeFor(token));
  }

  async quoteSell(token: Address, amountTokens: bigint): Promise<bigint> {
    return this.quote(token, this.o.baseToken, amountTokens, this.feeFor(token));
  }

  async buildBuyTx(p: { token: Address; amountInBase: bigint; minAmountOut: bigint; recipient: Address; deadlineSec: number }): Promise<TxRequest> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + p.deadlineSec);
    const data = encodeFunctionData({
      abi: uniswapV3RouterAbi,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: this.o.baseToken,
          tokenOut: p.token,
          fee: this.feeFor(p.token),
          recipient: p.recipient,
          deadline,
          amountIn: p.amountInBase,
          amountOutMinimum: p.minAmountOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return { to: this.o.router, data, value: 0n };
  }

  async buildSellTx(p: { token: Address; amountTokens: bigint; minAmountOutBase: bigint; recipient: Address; deadlineSec: number }): Promise<TxRequest> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + p.deadlineSec);
    const data = encodeFunctionData({
      abi: uniswapV3RouterAbi,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: p.token,
          tokenOut: this.o.baseToken,
          fee: this.feeFor(p.token),
          recipient: p.recipient,
          deadline,
          amountIn: p.amountTokens,
          amountOutMinimum: p.minAmountOutBase,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return { to: this.o.router, data, value: 0n };
  }

  spender(): Address {
    return this.o.router;
  }

  async estimateTaxesBps(_token: Address): Promise<{ buyBps: number; sellBps: number } | null> {
    log.debug('v3 tax estimation not available without trace access');
    return null;
  }
}
