import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { formatEther, isAddress, parseEther } from 'viem';
import type { App } from '../bot.js';
import type { Address, PoolInfo } from '../types/index.js';
import { portfolioSummary } from '../portfolio/portfolio.js';
import { liveTradingBlockers } from '../config/index.js';
import { runFullSafety } from '../bot.js';
import { TradeBlockedError } from '../trading/engine.js';
import { buildPulseFeed } from './analytics.js';
import { childLogger } from '../utils/logger.js';
import { DASHBOARD_HTML } from './html.js';

const log = childLogger('dashboard');

export interface DashboardOptions {
  port?: number;
  host?: string;
  /**
   * Allow one-click buy/sell from the browser. OFF by default. Even when ON,
   * the server refuses to act in `live` mode — live trading stays behind the
   * CLI confirm-live ceremony. Intended for paper/testnet use on localhost.
   */
  enableActions?: boolean;
}

/** Assemble the full read-only state snapshot for the dashboard. */
export async function buildDashboardState(app: App, enableActions: boolean) {
  const { cfg, db } = app;
  const summary = portfolioSummary(db);
  const blockers = liveTradingBlockers(cfg, { liveConfirmed: db.isLiveConfirmed(), emergencyStop: db.isEmergencyStopped() });
  const feed = await buildPulseFeed(app);

  return {
    now: new Date().toISOString(),
    actions: { enabled: enableActions && cfg.mode !== 'live', mode: cfg.mode },
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
    feed,
    trades: db.listTrades(40).map((t) => ({
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
    errors: db.db.prepare('SELECT scope, message, created_at FROM errors ORDER BY id DESC LIMIT 20').all(),
  };
}

export interface DashboardHandle {
  url: string;
  close: () => Promise<void>;
}

/** Read the request body as JSON (small, bounded). */
function readJson(req: IncomingMessage, limitBytes = 8192): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Handle a gated quick-action (buy/sell) from the browser. */
async function handleTrade(app: App, body: unknown): Promise<{ ok: boolean; message?: string; error?: string }> {
  const { cfg, db } = app;
  if (cfg.mode === 'live') {
    return { ok: false, error: 'live trading is not allowed from the dashboard — use the CLI confirm-live ceremony' };
  }
  const b = (body ?? {}) as { action?: string; token?: string; amount?: number; percent?: number };
  if (!b.token || !isAddress(b.token)) return { ok: false, error: 'invalid or missing token address' };
  const token = b.token as Address;

  try {
    if (b.action === 'buy') {
      const amount = parseEther(String(b.amount ?? cfg.maxBuyEth));
      const poolRow = db.getPoolForToken(token);
      let report;
      let pool: Address | null = null;
      if (poolRow) {
        pool = poolRow.address as Address;
        const poolInfo: PoolInfo = {
          address: poolRow.address as Address,
          dex: String(poolRow.dex),
          token: poolRow.token as Address,
          baseToken: poolRow.base_token as Address,
          token0: poolRow.token0 as Address,
          token1: poolRow.token1 as Address,
          blockNumber: BigInt(String(poolRow.block_number)),
        };
        report = await runFullSafety(app, poolInfo);
        db.insertSafetyReport(report);
        if (!report.passed) return { ok: false, error: `safety failed: ${report.criticalFailures.join('; ')}` };
      }
      const res = await app.engine.buy(token, pool, amount, report);
      return { ok: true, message: `buy ok — position #${res.positionId}${res.txHash ? ` tx ${res.txHash.slice(0, 12)}…` : ' (simulated)'}` };
    }
    if (b.action === 'sell') {
      const percent = Number(b.percent ?? 100);
      const res = await app.engine.sell(token, percent, 'manual');
      return { ok: true, message: `sell ${percent}% ok${res.txHash ? ` tx ${res.txHash.slice(0, 12)}…` : ' (simulated)'}` };
    }
    return { ok: false, error: `unknown action: ${b.action}` };
  } catch (err) {
    if (err instanceof TradeBlockedError) return { ok: false, error: err.blockers.join('; ') };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Start the dashboard HTTP server. Binds to 127.0.0.1 by default (local-only). */
export function startDashboard(app: App, opts: DashboardOptions = {}): Promise<DashboardHandle> {
  const port = opts.port ?? 3000;
  const host = opts.host ?? '127.0.0.1';
  const enableActions = !!opts.enableActions;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    const sendJson = (code: number, obj: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    };

    // gated write surface
    if (method === 'POST' && url === '/api/trade') {
      if (!enableActions) return sendJson(403, { ok: false, error: 'quick-actions are disabled (start with --enable-actions)' });
      readJson(req)
        .then((body) => handleTrade(app, body))
        .then((result) => sendJson(result.ok ? 200 : 400, result))
        .catch((err) => sendJson(400, { ok: false, error: String(err) }));
      return;
    }

    if (method !== 'GET') {
      return sendJson(405, { ok: false, error: 'method not allowed' });
    }

    try {
      if (url === '/' || url.startsWith('/?')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
        return;
      }
      if (url.startsWith('/api/state')) {
        buildDashboardState(app, enableActions)
          .then((state) => sendJson(200, state))
          .catch((err) => {
            log.error({ err: String(err) }, 'state build failed');
            sendJson(500, { error: String(err) });
          });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      log.error({ err: String(err) }, 'dashboard request failed');
      sendJson(500, { error: String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      log.info({ url, actions: enableActions }, 'dashboard listening');
      resolve({ url, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}
