import { parseEther } from 'viem';
import type { Address, PoolInfo, TxRequest } from '../types/index.js';
import type { DexAdapter } from './adapter.js';

/** Deterministic PRNG so mock runs are reproducible per seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthAddress(rand: () => number, tag: number): Address {
  let hex = '';
  for (let i = 0; i < 36; i++) hex += Math.floor(rand() * 16).toString(16);
  return `0x${tag.toString(16).padStart(4, '0')}${hex}` as Address;
}

export interface MockToken {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  /** base wei per whole token */
  price: number;
  liquidityBase: bigint;
  buyTaxBps: number;
  sellTaxBps: number;
  sellable: boolean;
}

export interface MockAdapterOptions {
  baseToken?: Address;
  seed?: number;
  /** ms between synthetic pool discoveries in watch mode */
  emitIntervalMs?: number;
  /** volatility per price tick, e.g. 0.05 = ±5% */
  volatility?: number;
}

export const MOCK_BASE_TOKEN = '0x4200000000000000000000000000000000000006' as Address;

/**
 * Mock adapter: emits synthetic pools and random-walk prices so the whole
 * pipeline (scanner → safety → paper trading → TP/SL) works with zero chain
 * access. Some generated tokens are intentionally "bad" (honeypot / high tax /
 * thin liquidity) so the safety layer has something to catch.
 */
export class MockDexAdapter implements DexAdapter {
  readonly name = 'mock';
  readonly tokens = new Map<string, MockToken>();
  private readonly pools = new Map<string, PoolInfo>();
  private readonly rand: () => number;
  private readonly o: Required<MockAdapterOptions>;
  private counter = 0;
  private blockNumber = 1000n;

  constructor(opts: MockAdapterOptions = {}) {
    this.o = {
      baseToken: opts.baseToken ?? MOCK_BASE_TOKEN,
      seed: opts.seed ?? 42,
      emitIntervalMs: opts.emitIntervalMs ?? 8000,
      volatility: opts.volatility ?? 0.05,
    };
    this.rand = mulberry32(this.o.seed);
  }

  get baseToken(): Address {
    return this.o.baseToken;
  }

  /** Create one synthetic token+pool. ~30% are "bad" in some way. */
  createPool(overrides: Partial<MockToken> = {}): PoolInfo {
    this.counter++;
    this.blockNumber += 10n;
    const r = this.rand();
    const bad = r < 0.3;
    const badKind = Math.floor(this.rand() * 3); // 0 honeypot, 1 high tax, 2 thin liquidity
    const token: MockToken = {
      address: synthAddress(this.rand, this.counter),
      name: `Mock Token ${this.counter}`,
      symbol: `MOCK${this.counter}`,
      decimals: 18,
      price: 0.00001 * (0.5 + this.rand() * 2),
      liquidityBase: bad && badKind === 2 ? parseEther('0.05') : parseEther((2 + this.rand() * 20).toFixed(4)),
      buyTaxBps: bad && badKind === 1 ? 2000 + Math.floor(this.rand() * 3000) : Math.floor(this.rand() * 300),
      sellTaxBps: bad && badKind === 1 ? 2000 + Math.floor(this.rand() * 5000) : Math.floor(this.rand() * 300),
      sellable: !(bad && badKind === 0),
      ...overrides,
    };
    this.tokens.set(token.address.toLowerCase(), token);
    const pool: PoolInfo = {
      address: synthAddress(this.rand, this.counter + 0x8000),
      dex: this.name,
      token: token.address,
      baseToken: this.o.baseToken,
      token0: this.o.baseToken,
      token1: token.address,
      blockNumber: this.blockNumber,
    };
    this.pools.set(pool.address.toLowerCase(), pool);
    return pool;
  }

  /** Random-walk all token prices one tick (called by the paper loop). */
  tickPrices() {
    for (const t of this.tokens.values()) {
      const drift = (this.rand() * 2 - 1) * this.o.volatility;
      t.price = Math.max(t.price * (1 + drift), 1e-12);
    }
  }

  /** Force a price move for tests (factor 1.5 = +50%). */
  movePrice(token: Address, factor: number) {
    const t = this.tokens.get(token.toLowerCase());
    if (t) t.price *= factor;
  }

  getToken(address: Address): MockToken | undefined {
    return this.tokens.get(address.toLowerCase());
  }

  async scanNewPools(_fromBlock: bigint, _toBlock: bigint): Promise<PoolInfo[]> {
    // one-shot scan yields a couple of fresh synthetic pools
    return [this.createPool(), this.createPool()];
  }

  watchNewPools(onPool: (pool: PoolInfo) => void, _onError: (err: Error) => void): () => void {
    const timer = setInterval(() => {
      onPool(this.createPool());
    }, this.o.emitIntervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async getPoolLiquidityBase(pool: PoolInfo): Promise<bigint> {
    const token = this.tokens.get(pool.token.toLowerCase());
    if (!token) throw new Error(`mock: unknown pool token ${pool.token}`);
    return token.liquidityBase;
  }

  async quoteBuy(token: Address, amountInBase: bigint): Promise<bigint> {
    const t = this.mustToken(token);
    const tokensOut = (Number(amountInBase) / 1e18 / t.price) * (1 - t.buyTaxBps / 10_000);
    return BigInt(Math.floor(tokensOut * 10 ** t.decimals));
  }

  async quoteSell(token: Address, amountTokens: bigint): Promise<bigint> {
    const t = this.mustToken(token);
    if (!t.sellable) throw new Error(`mock: token ${t.symbol} is not sellable (honeypot simulation)`);
    const baseOut = (Number(amountTokens) / 10 ** t.decimals) * t.price * (1 - t.sellTaxBps / 10_000);
    return BigInt(Math.floor(baseOut * 1e18));
  }

  async buildBuyTx(): Promise<TxRequest> {
    throw new Error('mock adapter cannot build real transactions — it exists for paper mode and tests only');
  }

  async buildSellTx(): Promise<TxRequest> {
    throw new Error('mock adapter cannot build real transactions — it exists for paper mode and tests only');
  }

  spender(): Address | null {
    return null;
  }

  async estimateTaxesBps(token: Address): Promise<{ buyBps: number; sellBps: number } | null> {
    const t = this.tokens.get(token.toLowerCase());
    return t ? { buyBps: t.buyTaxBps, sellBps: t.sellTaxBps } : null;
  }

  async getTokenMeta(token: Address): Promise<{ name: string; symbol: string; decimals: number; totalSupply: bigint } | null> {
    const t = this.tokens.get(token.toLowerCase());
    if (!t) return null;
    return { name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: 10n ** 27n };
  }

  private mustToken(address: Address): MockToken {
    const t = this.tokens.get(address.toLowerCase());
    if (!t) throw new Error(`mock: unknown token ${address}`);
    return t;
  }
}
