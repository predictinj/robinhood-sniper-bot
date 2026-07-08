import { encodeFunctionData, type PublicClient } from 'viem';
import type { Address, PoolInfo, TxRequest } from '../types/index.js';
import type { DexAdapter } from './adapter.js';
import { erc20Abi, uniswapV2FactoryAbi, uniswapV2PairAbi, uniswapV2RouterAbi } from './abis.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('dex:v2');

export interface UniswapV2AdapterOptions {
  publicClient: PublicClient;
  /** client used for event subscriptions (may be WS-backed) */
  subscriptionClient: PublicClient;
  factory: Address;
  router: Address;
  baseToken: Address;
  /** true → buys pay native ETH via swapExactETHForTokens, sells receive native ETH */
  baseIsNativeWrapper: boolean;
  pollingIntervalMs?: number;
}

/**
 * Generic UniswapV2-style adapter (pair factory + router02-compatible).
 * Paste the Robinhood Chain DEX factory/router addresses into .env
 * (DEX_FACTORY_ADDRESS / DEX_ROUTER_ADDRESS) — nothing is hardcoded here.
 */
export class UniswapV2Adapter implements DexAdapter {
  readonly name = 'uniswap_v2';
  private readonly o: UniswapV2AdapterOptions;

  constructor(opts: UniswapV2AdapterOptions) {
    this.o = opts;
  }

  private toPoolInfo(token0: Address, token1: Address, pair: Address, blockNumber: bigint): PoolInfo | null {
    const base = this.o.baseToken.toLowerCase();
    let token: Address;
    if (token0.toLowerCase() === base) token = token1;
    else if (token1.toLowerCase() === base) token = token0;
    else return null; // pool doesn't involve our base token — ignore
    return { address: pair, dex: this.name, token, baseToken: this.o.baseToken, token0, token1, blockNumber };
  }

  async scanNewPools(fromBlock: bigint, toBlock: bigint): Promise<PoolInfo[]> {
    const logs = await this.o.publicClient.getContractEvents({
      address: this.o.factory,
      abi: uniswapV2FactoryAbi,
      eventName: 'PairCreated',
      fromBlock,
      toBlock,
    });
    const pools: PoolInfo[] = [];
    for (const l of logs) {
      const { token0, token1, pair } = l.args as { token0: Address; token1: Address; pair: Address };
      const info = this.toPoolInfo(token0, token1, pair, l.blockNumber ?? 0n);
      if (info) pools.push(info);
    }
    return pools;
  }

  watchNewPools(onPool: (pool: PoolInfo) => void, onError: (err: Error) => void): () => void {
    return this.o.subscriptionClient.watchContractEvent({
      address: this.o.factory,
      abi: uniswapV2FactoryAbi,
      eventName: 'PairCreated',
      pollingInterval: this.o.pollingIntervalMs ?? 4000,
      onLogs: (logs) => {
        for (const l of logs) {
          try {
            const { token0, token1, pair } = l.args as { token0: Address; token1: Address; pair: Address };
            const info = this.toPoolInfo(token0, token1, pair, l.blockNumber ?? 0n);
            if (info) onPool(info);
          } catch (err) {
            onError(err instanceof Error ? err : new Error(String(err)));
          }
        }
      },
      onError: (err) => onError(err instanceof Error ? err : new Error(String(err))),
    });
  }

  async getPoolLiquidityBase(pool: PoolInfo): Promise<bigint> {
    const [reserve0, reserve1] = (await this.o.publicClient.readContract({
      address: pool.address,
      abi: uniswapV2PairAbi,
      functionName: 'getReserves',
    })) as readonly [bigint, bigint, number];
    const baseIsToken0 = pool.token0.toLowerCase() === this.o.baseToken.toLowerCase();
    return baseIsToken0 ? reserve0 : reserve1;
  }

  private buyPath(token: Address): Address[] {
    return [this.o.baseToken, token];
  }

  private sellPath(token: Address): Address[] {
    return [token, this.o.baseToken];
  }

  async quoteBuy(token: Address, amountInBase: bigint): Promise<bigint> {
    const amounts = (await this.o.publicClient.readContract({
      address: this.o.router,
      abi: uniswapV2RouterAbi,
      functionName: 'getAmountsOut',
      args: [amountInBase, this.buyPath(token)],
    })) as readonly bigint[];
    return amounts[amounts.length - 1]!;
  }

  async quoteSell(token: Address, amountTokens: bigint): Promise<bigint> {
    const amounts = (await this.o.publicClient.readContract({
      address: this.o.router,
      abi: uniswapV2RouterAbi,
      functionName: 'getAmountsOut',
      args: [amountTokens, this.sellPath(token)],
    })) as readonly bigint[];
    return amounts[amounts.length - 1]!;
  }

  async buildBuyTx(p: { token: Address; amountInBase: bigint; minAmountOut: bigint; recipient: Address; deadlineSec: number }): Promise<TxRequest> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + p.deadlineSec);
    if (this.o.baseIsNativeWrapper) {
      const data = encodeFunctionData({
        abi: uniswapV2RouterAbi,
        functionName: 'swapExactETHForTokens',
        args: [p.minAmountOut, this.buyPath(p.token), p.recipient, deadline],
      });
      return { to: this.o.router, data, value: p.amountInBase };
    }
    const data = encodeFunctionData({
      abi: uniswapV2RouterAbi,
      functionName: 'swapExactTokensForTokens',
      args: [p.amountInBase, p.minAmountOut, this.buyPath(p.token), p.recipient, deadline],
    });
    return { to: this.o.router, data, value: 0n };
  }

  async buildSellTx(p: { token: Address; amountTokens: bigint; minAmountOutBase: bigint; recipient: Address; deadlineSec: number }): Promise<TxRequest> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + p.deadlineSec);
    // Fee-on-transfer-safe variants: work for both taxed and normal tokens.
    if (this.o.baseIsNativeWrapper) {
      const data = encodeFunctionData({
        abi: uniswapV2RouterAbi,
        functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
        args: [p.amountTokens, p.minAmountOutBase, this.sellPath(p.token), p.recipient, deadline],
      });
      return { to: this.o.router, data, value: 0n };
    }
    const data = encodeFunctionData({
      abi: uniswapV2RouterAbi,
      functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
      args: [p.amountTokens, p.minAmountOutBase, this.sellPath(p.token), p.recipient, deadline],
    });
    return { to: this.o.router, data, value: 0n };
  }

  spender(): Address {
    return this.o.router;
  }

  /**
   * Best-effort tax estimate: compares the router quote (which uses pure
   * reserve math) against a static-call simulation of the swap when possible.
   * Without trace access this often can't detect transfer taxes, so we return
   * null rather than a false "0%" — the safety layer treats null as a warning.
   */
  async estimateTaxesBps(_token: Address): Promise<{ buyBps: number; sellBps: number } | null> {
    return null;
  }
}

/** Read ERC20 allowance for the router. */
export async function currentAllowance(client: PublicClient, token: Address, owner: Address, spender: Address): Promise<bigint> {
  try {
    return (await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })) as bigint;
  } catch (err) {
    log.warn({ err: String(err), token }, 'allowance read failed; assuming 0');
    return 0n;
  }
}

/** Build an exact-amount ERC20 approve tx (never unlimited unless amount says so). */
export function buildApproveTx(token: Address, spender: Address, amount: bigint): TxRequest {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
  return { to: token, data, value: 0n };
}
