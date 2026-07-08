import { formatEther } from 'viem';
import type { Address } from '../types/index.js';
import type { App } from '../bot.js';
import { scoreFindings, type SafetyGrade } from '../safety/score.js';

export interface TokenCard {
  pool: string;
  token: string;
  symbol: string | null;
  name: string | null;
  dex: string;
  ageSeconds: number;
  liquidityEth: string | null;
  safety: {
    checked: boolean;
    passed: boolean;
    score: number;
    grade: SafetyGrade;
    taxBps: number | null;
    criticalFlags: string[];
    warnFlags: string[];
  };
  price: number | null;
  priceChangePct: number | null;
  sparkline: number[];
  // holding-only
  positionId?: number;
  status?: string;
  pnlPercent?: number;
  costEth?: string;
  entryPrice?: number;
}

export interface PulseFeed {
  newPairs: TokenCard[];
  passedSafety: TokenCard[];
  holding: TokenCard[];
  flagged: TokenCard[];
}

function ageSeconds(iso: string): number {
  // sqlite datetime('now') is UTC without a zone marker
  const t = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

function changePct(series: number[]): number | null {
  if (series.length < 2) return null;
  const first = series[0]!;
  const last = series[series.length - 1]!;
  if (first <= 0) return null;
  return ((last - first) / first) * 100;
}

/**
 * Build the Axiom-inspired "Pulse" feed from local SQLite state.
 * Columns adapted for a generic EVM DEX (no bonding-curve migration lifecycle):
 *   New pairs → Passed safety → Holding, plus a Flagged/danger list.
 * Price enrichment for un-held pools is best-effort and capped so the endpoint
 * stays fast against a real RPC.
 */
export async function buildPulseFeed(app: App, opts: { enrichLimit?: number } = {}): Promise<PulseFeed> {
  const { db, adapter } = app;
  const enrichLimit = opts.enrichLimit ?? 10;

  const poolRows = db.listPools(120);
  const openByToken = new Map<string, ReturnType<typeof db.openPositions>[number]>();
  for (const p of db.openPositions()) openByToken.set(p.token.toLowerCase(), p);

  const cards: TokenCard[] = [];
  let enriched = 0;

  for (const row of poolRows) {
    const token = row.token as Address;
    const tokenRec = db.getToken(token);
    const safetyRec = db.latestSafety(token);
    const scored = safetyRec ? scoreFindings(safetyRec.findings) : null;

    const taxFinding = safetyRec?.findings.find((f) => f.check === 'token_tax');
    const taxBps = taxFinding ? parseTaxBps(taxFinding.detail) : null;

    const pos = openByToken.get(token.toLowerCase());
    const series = db.priceSeries(token, 40);

    let price: number | null = series.length ? series[series.length - 1]! : null;

    // best-effort live price for the most recent safe/held pools (capped)
    const wantEnrich = (pos || safetyRec?.passed) && enriched < enrichLimit;
    if (price === null && wantEnrich) {
      try {
        const probeIn = 10n ** 16n; // 0.01 base
        const out = await adapter.quoteBuy(token, probeIn);
        if (out > 0n) {
          const decimals = tokenRec?.decimals ?? 18;
          price = Number(probeIn) / 1e18 / (Number(out) / 10 ** decimals);
        }
        enriched++;
      } catch {
        enriched++; // count the attempt so we don't hammer a broken pool every poll
      }
    }

    const card: TokenCard = {
      pool: String(row.address),
      token,
      symbol: tokenRec?.symbol ?? null,
      name: tokenRec?.name ?? null,
      dex: String(row.dex),
      ageSeconds: ageSeconds(String(row.discovered_at)),
      liquidityEth: row.liquidity_base != null ? formatEther(BigInt(String(row.liquidity_base))) : null,
      safety: {
        checked: !!safetyRec,
        passed: safetyRec?.passed ?? false,
        score: scored?.score ?? 0,
        grade: scored?.grade ?? 'F',
        taxBps,
        criticalFlags: (safetyRec?.findings ?? []).filter((f) => f.severity === 'critical' && !f.passed).map((f) => f.check),
        warnFlags: (safetyRec?.findings ?? []).filter((f) => f.severity === 'warning' && !f.passed).map((f) => f.check),
      },
      price,
      priceChangePct: changePct(series),
      sparkline: series,
    };

    if (pos) {
      card.positionId = pos.id;
      card.status = pos.status;
      card.pnlPercent = pos.pnlPercent;
      card.costEth = formatEther(pos.costBase);
      card.entryPrice = pos.entryPrice;
      card.price = card.price ?? pos.currentPrice;
    }

    cards.push(card);
  }

  const flaggedAddrs = new Set(
    (db.db.prepare('SELECT address FROM tokens WHERE flagged = 1').all() as Array<{ address: string }>).map((r) => r.address.toLowerCase()),
  );

  return {
    newPairs: cards.slice(0, 40),
    passedSafety: cards.filter((c) => c.safety.checked && c.safety.passed && !c.positionId).slice(0, 40),
    holding: cards.filter((c) => c.positionId && c.status === 'open').slice(0, 40),
    flagged: cards.filter((c) => flaggedAddrs.has(c.token.toLowerCase()) || (c.safety.checked && !c.safety.passed)).slice(0, 40),
  };
}

/** Pull "buy NNNbps + sell NNNbps" out of the token_tax finding detail text. */
function parseTaxBps(detail: string): number | null {
  const m = detail.match(/buy\s+(\d+)bps\s*\+\s*sell\s+(\d+)bps/i);
  if (!m) return null;
  return Number(m[1]) + Number(m[2]);
}
