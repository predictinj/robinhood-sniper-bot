export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export type Mode = 'paper' | 'testnet' | 'live';
export type DexType = 'uniswap_v2' | 'uniswap_v3' | 'mock';

export interface TokenMeta {
  address: Address;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: bigint | null;
}

export interface PoolInfo {
  address: Address;
  dex: string;
  /** the non-base token being traded */
  token: Address;
  baseToken: Address;
  token0: Address;
  token1: Address;
  blockNumber: bigint;
}

export interface TxRequest {
  to: Address;
  data: Hex;
  value: bigint;
}

export type SafetySeverity = 'critical' | 'warning' | 'info';

export interface SafetyFinding {
  check: string;
  severity: SafetySeverity;
  passed: boolean;
  detail: string;
}

export interface SafetyReport {
  token: Address;
  pool: Address | null;
  passed: boolean;
  criticalFailures: string[];
  warnings: string[];
  findings: SafetyFinding[];
  meta: TokenMeta | null;
  liquidityBase: bigint | null;
  estimatedBuyTaxBps: number | null;
  estimatedSellTaxBps: number | null;
}

export type TradeSide = 'buy' | 'sell';
export type TradeStatus = 'simulated' | 'pending' | 'confirmed' | 'failed';

export interface TradeRecord {
  id?: number;
  mode: Mode;
  side: TradeSide;
  token: Address;
  pool: Address | null;
  amountIn: bigint;
  amountOut: bigint;
  /** base token per 1 token, as a float for reporting */
  price: number;
  txHash: string | null;
  status: TradeStatus;
  error: string | null;
  createdAt?: string;
}

export type PositionStatus = 'open' | 'closed';

export interface Position {
  id: number;
  token: Address;
  pool: Address | null;
  mode: Mode;
  /** base per token at entry */
  entryPrice: number;
  /** raw token units held */
  amountToken: bigint;
  /** base spent, wei */
  costBase: bigint;
  currentPrice: number;
  pnlPercent: number;
  highWaterPrice: number;
  status: PositionStatus;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
}

export type ExitReason = 'take_profit' | 'stop_loss' | 'trailing_stop' | 'manual';
