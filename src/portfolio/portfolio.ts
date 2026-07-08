import { formatEther } from 'viem';
import type { BotDb } from '../storage/db.js';
import type { Position } from '../types/index.js';

export interface PortfolioSummary {
  openPositions: number;
  closedPositions: number;
  totalCostOpenEth: string;
  unrealizedPnlPercentAvg: number;
  trades: number;
}

/** Aggregated portfolio reporting over the positions/trades tables. */
export function portfolioSummary(db: BotDb): PortfolioSummary {
  const all = db.listPositions(10_000);
  const open = all.filter((p) => p.status === 'open');
  const closed = all.filter((p) => p.status === 'closed');
  const totalCost = open.reduce((acc, p) => acc + p.costBase, 0n);
  const avgPnl = open.length ? open.reduce((acc, p) => acc + p.pnlPercent, 0) / open.length : 0;
  return {
    openPositions: open.length,
    closedPositions: closed.length,
    totalCostOpenEth: formatEther(totalCost),
    unrealizedPnlPercentAvg: Number(avgPnl.toFixed(2)),
    trades: db.listTrades(10_000).length,
  };
}

export function formatPosition(p: Position): string {
  const pnl = p.pnlPercent >= 0 ? `+${p.pnlPercent.toFixed(2)}%` : `${p.pnlPercent.toFixed(2)}%`;
  return [
    `#${p.id} [${p.status.toUpperCase()}] ${p.token}`,
    `  mode=${p.mode} entry=${p.entryPrice.toExponential(4)} current=${p.currentPrice.toExponential(4)} pnl=${pnl}`,
    `  amount=${p.amountToken} cost=${formatEther(p.costBase)} ETH opened=${p.openedAt}${p.closeReason ? ` closed(${p.closeReason})` : ''}`,
  ].join('\n');
}
