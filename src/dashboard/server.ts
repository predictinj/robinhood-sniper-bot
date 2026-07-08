import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { formatEther } from 'viem';
import type { App } from '../bot.js';
import { portfolioSummary } from '../portfolio/portfolio.js';
import { liveTradingBlockers } from '../config/index.js';
import { childLogger } from '../utils/logger.js';
import { DASHBOARD_HTML } from './html.js';

const log = childLogger('dashboard');

/**
 * Minimal read-only dashboard. No external deps: Node http + a single HTML page
 * that polls the JSON API. It only READS the bot's SQLite state — it never
 * places trades or exposes secrets (the private key is never in the DB and is
 * never sent to the browser).
 */
export function buildDashboardState(app: App) {
  const { cfg, db } = app;
  const summary = portfolioSummary(db);
  const blockers = liveTradingBlockers(cfg, { liveConfirmed: db.isLiveConfirmed(), emergencyStop: db.isEmergencyStopped() });

  return {
    now: new Date().toISOString(),
    config: {
      mode: cfg.mode,
      chainId: cfg.chainId,
      rpcUrl: cfg.rpcUrl,
      dex: app.adapter.name,
      simulationOnly: app.simulationOnly,
      maxBuyEth: cfg.maxBuyEth,
      maxSlippageBps: cfg.maxSlippageBps,
      maxGasGwei: cfg.maxGasGwei,
      minLiquidityEth: cfg.minLiquidityEth,
      maxTokenTaxBps: cfg.maxTokenTaxBps,
      takeProfitPercent: cfg.takeProfitPercent,
      stopLossPercent: cfg.stopLossPercent,
      trailingStopPercent: cfg.trailingStopPercent ?? null,
      maxOpenPositions: cfg.maxOpenPositions,
      cooldownSeconds: cfg.cooldownSeconds,
    },
    state: {
      emergencyStop: db.isEmergencyStopped(),
      liveConfirmed: db.isLiveConfirmed(),
      liveBlockers: blockers,
      paperBalanceEth: cfg.mode === 'paper' ? formatEther(app.engine.paper.balance()) : null,
    },
    summary,
    positions: db.listPositions(200).map((p) => ({
      id: p.id,
      token: p.token,
      mode: p.mode,
      status: p.status,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice,
      pnlPercent: p.pnlPercent,
      amountToken: p.amountToken.toString(),
      costEth: formatEther(p.costBase),
      openedAt: p.openedAt,
      closeReason: p.closeReason,
    })),
    trades: db.listTrades(50).map((t) => ({
      id: t.id,
      createdAt: t.created_at,
      mode: t.mode,
      side: t.side,
      status: t.status,
      token: t.token,
      amountIn: t.amount_in,
      amountOut: t.amount_out,
      txHash: t.tx_hash,
      error: t.error,
    })),
    pools: db.listPools(50).map((p) => ({
      address: p.address,
      token: p.token,
      dex: p.dex,
      liquidityBase: p.liquidity_base,
      discoveredAt: p.discovered_at,
    })),
    flaggedTokens: (db.db.prepare('SELECT address, symbol, notes FROM tokens WHERE flagged = 1 ORDER BY first_seen_at DESC LIMIT 50').all() as Array<{ address: string; symbol: string | null; notes: string | null }>),
    errors: (db.db.prepare('SELECT scope, message, created_at FROM errors ORDER BY id DESC LIMIT 25').all() as Array<{ scope: string; message: string; created_at: string }>),
  };
}

export interface DashboardHandle {
  url: string;
  close: () => Promise<void>;
}

/** Start the dashboard HTTP server. Binds to 127.0.0.1 by default (local-only). */
export function startDashboard(app: App, opts: { port?: number; host?: string } = {}): Promise<DashboardHandle> {
  const port = opts.port ?? 3000;
  const host = opts.host ?? '127.0.0.1';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // read-only surface: only GET is allowed
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed (dashboard is read-only)');
      return;
    }
    const url = req.url ?? '/';
    try {
      if (url === '/' || url.startsWith('/?')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
        return;
      }
      if (url.startsWith('/api/state')) {
        const body = JSON.stringify(buildDashboardState(app));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      log.error({ err: String(err) }, 'dashboard request failed');
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      log.info({ url }, 'dashboard listening');
      resolve({
        url,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
