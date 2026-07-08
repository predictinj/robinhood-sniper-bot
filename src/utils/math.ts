const BPS_DENOMINATOR = 10_000n;

/** amount reduced by `bps` basis points (used for slippage-protected minOut). */
export function applySlippageBps(amount: bigint, bps: number): bigint {
  if (bps < 0 || bps > 10_000) throw new Error(`invalid bps: ${bps}`);
  return (amount * (BPS_DENOMINATOR - BigInt(Math.floor(bps)))) / BPS_DENOMINATOR;
}

/** Percent change from entry to current, e.g. 25 means +25%. */
export function pnlPercent(entryPrice: number, currentPrice: number): number {
  if (entryPrice <= 0) return 0;
  return ((currentPrice - entryPrice) / entryPrice) * 100;
}

/** price = base per 1 whole token, given raw amounts and token decimals. */
export function priceFromAmounts(baseWei: bigint, tokenRaw: bigint, tokenDecimals: number): number {
  if (tokenRaw === 0n) return 0;
  const base = Number(baseWei) / 1e18;
  const tokens = Number(tokenRaw) / 10 ** tokenDecimals;
  if (tokens === 0) return 0;
  return base / tokens;
}

/** Difference between expected and actual, in bps of expected (>=0). */
export function shortfallBps(expected: bigint, actual: bigint): number {
  if (expected <= 0n) return 0;
  if (actual >= expected) return 0;
  return Number(((expected - actual) * BPS_DENOMINATOR) / expected);
}

export function formatBig(x: bigint, decimals: number, precision = 6): string {
  const neg = x < 0n;
  const abs = neg ? -x : x;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, precision).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${fracStr ? '.' + fracStr : ''}`;
}
