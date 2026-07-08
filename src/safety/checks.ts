import { parseEther, zeroAddress, type PublicClient } from 'viem';
import type { Address, PoolInfo, SafetyFinding, SafetyReport, TokenMeta } from '../types/index.js';
import type { DexAdapter } from '../dex/adapter.js';
import type { BotConfig } from '../config/index.js';
import { erc20Abi } from '../dex/abis.js';
import { parseAbi } from 'viem';
import { childLogger } from '../utils/logger.js';

const log = childLogger('safety');

/** Minimal slice of PublicClient the checks need (null in mock/offline mode). */
export type SafetyClient = Pick<PublicClient, 'readContract' | 'getCode'>;

const ownerProbeAbi = parseAbi([
  'function getOwner() view returns (address)',
  'function _maxTxAmount() view returns (uint256)',
  'function maxTransactionAmount() view returns (uint256)',
  'function maxWalletAmount() view returns (uint256)',
  'function _maxWalletSize() view returns (uint256)',
  'function tradingEnabled() view returns (bool)',
]);

export interface SafetyContext {
  client: SafetyClient | null;
  adapter: DexAdapter;
  cfg: BotConfig;
}

/**
 * Run the full pre-trade safety pipeline for a token/pool.
 * The bot NEVER buys a token whose report has a critical failure.
 * Warnings are logged and stored but do not block by themselves —
 * except where config makes them blocking (e.g. tax over MAX_TOKEN_TAX_BPS).
 */
export async function runSafetyChecks(ctx: SafetyContext, pool: PoolInfo): Promise<SafetyReport> {
  const { adapter, cfg, client } = ctx;
  const token = pool.token;
  const findings: SafetyFinding[] = [];
  const add = (check: string, severity: SafetyFinding['severity'], passed: boolean, detail: string) =>
    findings.push({ check, severity, passed, detail });

  // 1. base-token pairing — only trade pools quoted in the configured base token
  const expectedBase = (cfg.baseTokenAddress ?? pool.baseToken).toLowerCase();
  const pairedWithBase = pool.baseToken.toLowerCase() === expectedBase;
  add('base_token_pair', 'critical', pairedWithBase, pairedWithBase ? `pool is quoted in base token ${pool.baseToken}` : `pool base ${pool.baseToken} != configured base`);

  // 2. contract code exists
  let hasCode = true;
  if (client) {
    try {
      const code = await client.getCode({ address: token });
      hasCode = !!code && code !== '0x';
    } catch (err) {
      hasCode = false;
      add('code_read', 'warning', false, `getCode failed: ${trim(err)}`);
    }
  }
  add('contract_code', 'critical', hasCode, hasCode ? 'token address has contract code' : 'no contract code at token address');

  // 3. ERC20 metadata
  let meta: TokenMeta | null = null;
  if (adapter.getTokenMeta) {
    const m = await adapter.getTokenMeta(token).catch(() => null);
    if (m) meta = { address: token, ...m };
  } else if (client) {
    meta = await readErc20Meta(client, token);
  }
  const metaOk = !!meta && meta.decimals !== null && meta.decimals >= 0 && meta.decimals <= 36 && (meta.totalSupply ?? 0n) > 0n;
  add(
    'erc20_metadata',
    'critical',
    metaOk,
    metaOk
      ? `${meta!.name} (${meta!.symbol}), decimals=${meta!.decimals}, supply=${meta!.totalSupply}`
      : 'could not read valid name/symbol/decimals/totalSupply (or decimals out of range / zero supply)',
  );

  // 4. liquidity size
  let liquidityBase: bigint | null = null;
  try {
    liquidityBase = await adapter.getPoolLiquidityBase(pool);
  } catch (err) {
    add('liquidity_read', 'critical', false, `could not read pool liquidity: ${trim(err)}`);
  }
  if (liquidityBase !== null) {
    const min = parseEther(cfg.minLiquidityEth.toString());
    const ok = liquidityBase >= min;
    add('min_liquidity', 'critical', ok, `pool base liquidity ${liquidityBase} wei vs required ${min} wei`);
  }

  // 5. sellability — quote a buy then quote selling the result; a revert on the
  // sell side is the classic honeypot signature detectable from public data.
  let estBuyOut: bigint | null = null;
  const probeIn = parseEther(Math.min(cfg.maxBuyEth, 0.01).toString());
  try {
    estBuyOut = await adapter.quoteBuy(token, probeIn);
    add('buy_quote', 'critical', estBuyOut > 0n, `quoteBuy(${probeIn}) -> ${estBuyOut}`);
  } catch (err) {
    add('buy_quote', 'critical', false, `buy quote reverted: ${trim(err)}`);
  }
  if (estBuyOut && estBuyOut > 0n) {
    try {
      const sellOut = await adapter.quoteSell(token, estBuyOut);
      add('sell_quote', 'critical', sellOut > 0n, `quoteSell(${estBuyOut}) -> ${sellOut}`);
    } catch (err) {
      add('sell_quote', 'critical', false, `SELL QUOTE REVERTED — possible honeypot: ${trim(err)}`);
    }
  }

  // 6. tax estimation (best-effort; null = unknown → warning, not a pass)
  let buyTaxBps: number | null = null;
  let sellTaxBps: number | null = null;
  if (adapter.estimateTaxesBps) {
    const taxes = await adapter.estimateTaxesBps(token).catch(() => null);
    if (taxes) {
      buyTaxBps = taxes.buyBps;
      sellTaxBps = taxes.sellBps;
      const total = taxes.buyBps + taxes.sellBps;
      const ok = total <= cfg.maxTokenTaxBps;
      add('token_tax', 'critical', ok, `estimated buy ${taxes.buyBps}bps + sell ${taxes.sellBps}bps vs max ${cfg.maxTokenTaxBps}bps`);
    } else {
      add('token_tax', 'warning', true, 'tax not estimable from public data — treat with caution');
    }
  }

  // 7. ownership / permissions probe (best-effort, real chains only)
  if (client && hasCode) {
    const owner = await probeOwner(client, token);
    if (owner === null) {
      add('ownership', 'info', true, 'no owner()/getOwner() function detected');
    } else if (owner === zeroAddress) {
      add('ownership', 'info', true, 'ownership renounced (owner = zero address)');
    } else {
      add('ownership', 'warning', true, `token has active owner ${owner} — owner may retain privileged control`);
    }

    // 8. max-tx / max-wallet style restrictions
    const restriction = await probeRestrictions(client, token, meta?.totalSupply ?? null);
    if (restriction) add('tx_wallet_limits', 'warning', true, restriction);

    // 9. trading-enabled style switches
    const tradingEnabled = await tryRead<boolean>(client, token, ownerProbeAbi, 'tradingEnabled');
    if (tradingEnabled === false) add('trading_enabled', 'critical', false, 'token exposes tradingEnabled() and it returns false');
  }

  const criticalFailures = findings.filter((f) => f.severity === 'critical' && !f.passed).map((f) => `${f.check}: ${f.detail}`);
  const warnings = findings.filter((f) => f.severity === 'warning' && !f.passed).map((f) => `${f.check}: ${f.detail}`)
    .concat(findings.filter((f) => f.severity === 'warning' && f.passed && f.check !== 'ownership').map((f) => `${f.check}: ${f.detail}`));

  const report: SafetyReport = {
    token,
    pool: pool.address,
    passed: criticalFailures.length === 0,
    criticalFailures,
    warnings,
    findings,
    meta,
    liquidityBase,
    estimatedBuyTaxBps: buyTaxBps,
    estimatedSellTaxBps: sellTaxBps,
  };
  log.debug({ token, passed: report.passed, critical: criticalFailures.length, warnings: warnings.length }, 'safety report');
  return report;
}

async function readErc20Meta(client: SafetyClient, token: Address): Promise<TokenMeta | null> {
  const read = async <T>(functionName: 'name' | 'symbol' | 'decimals' | 'totalSupply'): Promise<T | null> => {
    try {
      return (await client.readContract({ address: token, abi: erc20Abi, functionName })) as T;
    } catch {
      return null;
    }
  };
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    read<string>('name'),
    read<string>('symbol'),
    read<number>('decimals'),
    read<bigint>('totalSupply'),
  ]);
  if (name === null && symbol === null && decimals === null && totalSupply === null) return null;
  return { address: token, name, symbol, decimals: decimals === null ? null : Number(decimals), totalSupply };
}

async function tryRead<T>(client: SafetyClient, address: Address, abi: typeof ownerProbeAbi | typeof erc20Abi, functionName: string): Promise<T | null> {
  try {
    return (await client.readContract({ address, abi, functionName } as Parameters<SafetyClient['readContract']>[0])) as T;
  } catch {
    return null;
  }
}

async function probeOwner(client: SafetyClient, token: Address): Promise<Address | null> {
  const owner = await tryRead<Address>(client, token, erc20Abi, 'owner');
  if (owner) return owner;
  return tryRead<Address>(client, token, ownerProbeAbi, 'getOwner');
}

async function probeRestrictions(client: SafetyClient, token: Address, totalSupply: bigint | null): Promise<string | null> {
  for (const fn of ['_maxTxAmount', 'maxTransactionAmount', 'maxWalletAmount', '_maxWalletSize'] as const) {
    const v = await tryRead<bigint>(client, token, ownerProbeAbi, fn);
    if (v !== null && v > 0n) {
      const pct = totalSupply && totalSupply > 0n ? Number((v * 10_000n) / totalSupply) / 100 : null;
      return `token exposes ${fn}() = ${v}${pct !== null ? ` (~${pct}% of supply)` : ''} — max-tx/max-wallet restrictions present`;
    }
  }
  return null;
}

function trim(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
