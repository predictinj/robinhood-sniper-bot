import { Command } from 'commander';
import { formatEther, parseEther, isAddress } from 'viem';
import { createInterface } from 'node:readline/promises';
import { buildApp, onNewPool, preflight, runFullSafety } from './bot.js';
import { loadConfig, liveTradingBlockers, ConfigError } from './config/index.js';
import { evaluateExit } from './trading/positionManager.js';
import { TradeBlockedError } from './trading/engine.js';
import { portfolioSummary, formatPosition } from './portfolio/portfolio.js';
import { MockDexAdapter } from './dex/mock.js';
import type { Address, PoolInfo } from './types/index.js';

const program = new Command();
program
  .name('bot')
  .description('Robinhood Chain token monitor & trading bot (paper/testnet/live). Run `bot config-check` first.')
  .version('0.1.0');

function fail(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function requireAddress(value: string, label: string): Address {
  if (!isAddress(value)) fail(`${label} is not a valid address: ${value}`);
  return value as Address;
}

function withApp<T>(fn: (app: ReturnType<typeof buildApp>) => Promise<T>): Promise<T> {
  let app: ReturnType<typeof buildApp>;
  try {
    app = buildApp();
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }
  return fn(app).finally(() => app.shutdown());
}

// ---------------------------------------------------------------- status

program
  .command('status')
  .description('current mode, balances, open positions, live-trading readiness')
  .action(() =>
    withApp(async (app) => {
      const { cfg, db } = app;
      const summary = portfolioSummary(db);
      console.log(`mode:            ${cfg.mode}${app.simulationOnly ? ' (simulation-only: mock adapter)' : ''}`);
      console.log(`chain id:        ${cfg.chainId}`);
      console.log(`rpc:             ${cfg.rpcUrl}`);
      console.log(`dex:             ${app.adapter.name}`);
      console.log(`emergency stop:  ${db.isEmergencyStopped() ? '⛔ ACTIVE (trading disabled)' : 'off'}`);
      console.log(`live confirmed:  ${db.isLiveConfirmed() ? 'yes' : 'no'}`);
      if (cfg.mode === 'paper') console.log(`paper balance:   ${formatEther(app.engine.paper.balance())} ETH`);
      if (app.clients?.account) {
        const bal = await app.clients.publicClient.getBalance({ address: app.clients.account.address }).catch(() => null);
        console.log(`wallet:          ${app.clients.account.address}${bal !== null ? ` (${formatEther(bal)} ETH)` : ' (balance unavailable)'}`);
      }
      console.log(`positions:       ${summary.openPositions} open / ${summary.closedPositions} closed (avg uPnL ${summary.unrealizedPnlPercentAvg}%)`);
      console.log(`open cost:       ${summary.totalCostOpenEth} ETH`);
      console.log(`trades:          ${summary.trades}`);
      const blockers = app.engine.realTradeBlockers();
      if (cfg.mode !== 'paper') {
        console.log(blockers.length ? `real trading blocked:\n  - ${blockers.join('\n  - ')}` : 'real trading: READY');
      }
    }),
  );

// ---------------------------------------------------------------- config-check

program
  .command('config-check')
  .description('validate .env, RPC connectivity, chain id and live-readiness')
  .action(() =>
    withApp(async (app) => {
      const { cfg, db } = app;
      console.log('✔ configuration parsed OK');
      console.log(`  mode=${cfg.mode} chainId=${cfg.chainId} dex=${cfg.dexType}`);
      console.log(`  maxBuy=${cfg.maxBuyEth} ETH slippage=${cfg.maxSlippageBps}bps gasCap=${cfg.maxGasGwei}gwei`);
      console.log(`  minLiquidity=${cfg.minLiquidityEth} ETH maxTax=${cfg.maxTokenTaxBps}bps`);
      console.log(`  TP=${cfg.takeProfitPercent}% SL=${cfg.stopLossPercent}% trailing=${cfg.trailingStopPercent ?? 'off'}%`);
      console.log(`  maxPositions=${cfg.maxOpenPositions} cooldown=${cfg.cooldownSeconds}s`);

      const problems = await preflight(app);
      if (problems.length) {
        for (const p of problems) console.log(`✖ ${p}`);
      } else if (app.clients) {
        console.log('✔ RPC reachable and chain id matches');
      } else {
        console.log('ℹ no chain connection needed (paper + mock)');
      }

      const blockers = liveTradingBlockers(cfg, { liveConfirmed: db.isLiveConfirmed(), emergencyStop: db.isEmergencyStopped() });
      console.log(blockers.length ? `live trading blockers:\n  - ${blockers.join('\n  - ')}` : '✔ LIVE TRADING FULLY ARMED');
      if (!blockers.length) console.log('  (run `bot emergency-stop` at any time to disarm)');
    }),
  );

// ---------------------------------------------------------------- scan / watch / paper

program
  .command('scan')
  .description('one-shot historical scan for new pools (last N blocks, default 2000)')
  .option('--blocks <n>', 'how many blocks back to scan', '2000')
  .action((opts: { blocks: string }) =>
    withApp(async (app) => {
      let fromBlock = 0n;
      let toBlock = 0n;
      if (app.clients) {
        toBlock = await app.clients.publicClient.getBlockNumber();
        const span = BigInt(opts.blocks);
        fromBlock = toBlock > span ? toBlock - span : 0n;
      }
      const pools = await app.scanner.scanRange(fromBlock, toBlock);
      if (!pools.length) console.log('no new pools found');
      for (const p of pools) console.log(`new pool ${p.address} token=${p.token} dex=${p.dex} block=${p.blockNumber}`);
      console.log(`\nstored pools (latest):`);
      for (const row of app.db.listPools(10)) console.log(`  ${row.address} token=${row.token} discovered=${row.discovered_at}`);
    }),
  );

program
  .command('watch')
  .description('monitor-only: watch new pools + run safety checks, never trade')
  .action(() =>
    withApp(async (app) => {
      console.log(`watching for new pools on ${app.adapter.name} (monitor-only, no trades)… Ctrl-C to stop`);
      if (app.adapter instanceof MockDexAdapter) {
        const mock = app.adapter;
        const t = setInterval(() => mock.tickPrices(), 2000);
        t.unref?.();
      }
      // monitor-only: reuse the pipeline but with a no-buy engine facade
      const scanner = new (await import('./scanner/scanner.js')).Scanner({
        publicClient: app.clients?.publicClient ?? null,
        adapter: app.adapter,
        db: app.db,
        onNewPool: async (pool: PoolInfo) => {
          const report = await runFullSafety(app, pool);
          app.db.insertSafetyReport(report);
          if (report.meta) app.db.upsertToken(report.meta);
          if (!report.passed) app.db.flagToken(pool.token, report.criticalFailures.join('; '));
          console.log(
            `pool ${pool.address} token=${pool.token} safety=${report.passed ? 'PASS' : 'FAIL'}` +
              (report.criticalFailures.length ? ` [${report.criticalFailures.join(' | ')}]` : ''),
          );
        },
      });
      process.on('SIGINT', () => {
        scanner.stop();
        process.exit(0);
      });
      await scanner.watch();
    }),
  );

program
  .command('paper')
  .description('run the full pipeline in paper mode regardless of MODE in .env')
  .action(async () => {
    process.env.MODE = 'paper';
    await withApp(async (app) => {
      console.log(`paper trading with ${app.adapter.name} adapter. Balance: ${formatEther(app.engine.paper.balance())} ETH. Ctrl-C to stop`);
      app.positions.start();
      if (app.adapter instanceof MockDexAdapter) {
        const mock = app.adapter;
        const t = setInterval(() => mock.tickPrices(), 2000);
        t.unref?.();
      }
      process.on('SIGINT', () => {
        app.shutdown();
        process.exit(0);
      });
      await app.scanner.watch();
    });
  });

// ---------------------------------------------------------------- buy / sell

program
  .command('buy')
  .description('buy a token (respects MODE: paper=simulated, testnet/live=real)')
  .requiredOption('--token <address>', 'token address')
  .option('--amount <eth>', 'amount of base/ETH to spend (default MAX_BUY_ETH)')
  .option('--skip-safety', 'do not run safety checks first (NOT recommended)', false)
  .action((opts: { token: string; amount?: string; skipSafety: boolean }) =>
    withApp(async (app) => {
      const token = requireAddress(opts.token, '--token');
      const amount = parseEther(opts.amount ?? app.cfg.maxBuyEth.toString());
      const poolRow = app.db.getPoolForToken(token);
      const pool = (poolRow?.address as Address) ?? null;

      let report;
      if (!opts.skipSafety) {
        if (!poolRow) fail(`no known pool for ${token} — run \`bot scan\` first, or use --skip-safety in paper mode`);
        const poolInfo: PoolInfo = {
          address: poolRow.address as Address,
          dex: poolRow.dex as string,
          token: poolRow.token as Address,
          baseToken: poolRow.base_token as Address,
          token0: poolRow.token0 as Address,
          token1: poolRow.token1 as Address,
          blockNumber: BigInt(poolRow.block_number as string),
        };
        report = await runFullSafety(app, poolInfo);
        app.db.insertSafetyReport(report);
        if (!report.passed) fail(`token failed safety checks:\n  - ${report.criticalFailures.join('\n  - ')}`);
      }

      try {
        const res = await app.engine.buy(token, pool, amount, report);
        console.log(`✔ buy executed. position=#${res.positionId}${res.txHash ? ` tx=${res.txHash}` : ' (simulated)'}`);
      } catch (err) {
        if (err instanceof TradeBlockedError) fail(err.message);
        throw err;
      }
    }),
  );

program
  .command('sell')
  .description('sell an open position (fully or partially)')
  .requiredOption('--token <address>', 'token address')
  .option('--percent <pct>', 'percent of position to sell', '100')
  .action((opts: { token: string; percent: string }) =>
    withApp(async (app) => {
      const token = requireAddress(opts.token, '--token');
      const pct = Number(opts.percent);
      if (!(pct > 0 && pct <= 100)) fail('--percent must be in (0, 100]');
      try {
        const res = await app.engine.sell(token, pct, 'manual');
        console.log(`✔ sell executed${res.txHash ? ` tx=${res.txHash}` : ' (simulated)'}`);
      } catch (err) {
        if (err instanceof TradeBlockedError) fail(err.message);
        fail(err instanceof Error ? err.message : String(err));
      }
    }),
  );

// ---------------------------------------------------------------- reporting

program
  .command('positions')
  .description('list positions (open first)')
  .option('--all', 'include closed positions', false)
  .action((opts: { all: boolean }) =>
    withApp(async (app) => {
      const list = opts.all ? app.db.listPositions(100) : app.db.openPositions();
      if (!list.length) return console.log('no positions');
      for (const p of list) console.log(formatPosition(p) + '\n');
      const s = portfolioSummary(app.db);
      console.log(`open=${s.openPositions} closed=${s.closedPositions} open-cost=${s.totalCostOpenEth} ETH avg-uPnL=${s.unrealizedPnlPercentAvg}%`);
    }),
  );

program
  .command('trades')
  .description('list recent trades')
  .option('--limit <n>', 'max rows', '25')
  .action((opts: { limit: string }) =>
    withApp(async (app) => {
      const rows = app.db.listTrades(Number(opts.limit));
      if (!rows.length) return console.log('no trades yet');
      for (const t of rows) {
        console.log(
          `#${t.id} ${t.created_at} [${t.mode}/${t.status}] ${String(t.side).toUpperCase()} ${t.token} in=${t.amount_in} out=${t.amount_out}${t.tx_hash ? ` tx=${t.tx_hash}` : ''}${t.error ? ` error=${t.error}` : ''}`,
        );
      }
    }),
  );

// ---------------------------------------------------------------- safety-check

program
  .command('safety-check')
  .description('run the full safety pipeline against a token and print the report')
  .requiredOption('--token <address>', 'token address')
  .action((opts: { token: string }) =>
    withApp(async (app) => {
      const token = requireAddress(opts.token, '--token');
      const poolRow = app.db.getPoolForToken(token);
      if (!poolRow) fail(`no known pool for ${token} — run \`bot scan\` or \`bot watch\` first so the pool is discovered`);
      const pool: PoolInfo = {
        address: poolRow.address as Address,
        dex: poolRow.dex as string,
        token: poolRow.token as Address,
        baseToken: poolRow.base_token as Address,
        token0: poolRow.token0 as Address,
        token1: poolRow.token1 as Address,
        blockNumber: BigInt(poolRow.block_number as string),
      };
      const report = await runFullSafety(app, pool);
      app.db.insertSafetyReport(report);
      console.log(`token:  ${token}`);
      console.log(`pool:   ${pool.address} (${pool.dex})`);
      console.log(`result: ${report.passed ? '✔ PASS' : '✖ FAIL'}`);
      for (const f of report.findings) {
        const icon = f.passed ? '✔' : f.severity === 'critical' ? '✖' : '⚠';
        console.log(`  ${icon} [${f.severity}] ${f.check}: ${f.detail}`);
      }
    }),
  );

// ---------------------------------------------------------------- live controls

program
  .command('confirm-live')
  .description('interactive confirmation ceremony required before ANY live trade')
  .action(() =>
    withApp(async (app) => {
      const { cfg, db } = app;
      const blockers = liveTradingBlockers(cfg, { liveConfirmed: true, emergencyStop: db.isEmergencyStopped() });
      if (blockers.length) {
        fail(`cannot arm live trading — fix these first:\n  - ${blockers.join('\n  - ')}`);
      }
      console.log('⚠️  LIVE TRADING CONFIRMATION');
      console.log('   You are about to allow this bot to spend REAL funds on Robinhood Chain mainnet.');
      console.log(`   Per-trade cap: ${cfg.maxBuyEth} ETH · max open positions: ${cfg.maxOpenPositions} · stop-loss: ${cfg.stopLossPercent}%`);
      console.log('   Automated trading of newly created tokens is HIGH RISK — you can lose everything you allocate.');
      console.log('   Read docs/LIVE_TRADING_WARNING.md first. Test on testnet before this step.\n');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Type exactly: I UNDERSTAND THE RISKS\n> ');
      rl.close();
      if (answer.trim() !== 'I UNDERSTAND THE RISKS') fail('confirmation phrase did not match — live trading remains disabled');
      db.setSetting('live_confirmed', '1');
      db.insertEvent('live_confirmed', { at: new Date().toISOString() });
      console.log('✔ live trading confirmed. It stays armed until `bot emergency-stop` or deleting the flag.');
    }),
  );

program
  .command('emergency-stop')
  .description('IMMEDIATELY disable all trading (paper, testnet and live)')
  .action(() =>
    withApp(async (app) => {
      app.db.setSetting('emergency_stop', '1');
      app.db.setSetting('live_confirmed', '0'); // require re-confirmation after a stop
      app.db.insertEvent('emergency_stop', { at: new Date().toISOString() });
      console.log('⛔ EMERGENCY STOP ACTIVE. No trades will be sent. Live confirmation revoked.');
      console.log('   Re-enable with `bot resume` (and `bot confirm-live` again for live mode).');
    }),
  );

program
  .command('resume')
  .description('clear the emergency stop (live mode still needs confirm-live again)')
  .action(() =>
    withApp(async (app) => {
      app.db.setSetting('emergency_stop', '0');
      app.db.insertEvent('resume', { at: new Date().toISOString() });
      console.log('✔ emergency stop cleared. Live trading still requires `bot confirm-live`.');
    }),
  );

// ---------------------------------------------------------------- backtest

program
  .command('backtest')
  .description('replay stored price events through the TP/SL rules to sanity-check exit settings')
  .option('--take-profit <pct>', 'override TAKE_PROFIT_PERCENT')
  .option('--stop-loss <pct>', 'override STOP_LOSS_PERCENT')
  .option('--trailing <pct>', 'override TRAILING_STOP_PERCENT')
  .action((opts: { takeProfit?: string; stopLoss?: string; trailing?: string }) =>
    withApp(async (app) => {
      const rules = {
        takeProfitPercent: opts.takeProfit ? Number(opts.takeProfit) : app.cfg.takeProfitPercent,
        stopLossPercent: opts.stopLoss ? Number(opts.stopLoss) : app.cfg.stopLossPercent,
        trailingStopPercent: opts.trailing ? Number(opts.trailing) : app.cfg.trailingStopPercent,
      };
      const events = app.db.listEvents('price', 100_000);
      if (!events.length) {
        console.log('no stored price events to backtest. Run `bot paper` (or `npm run paper`) for a while first.');
        return;
      }
      // group price series per token, then simulate entering at the first price
      const series = new Map<string, number[]>();
      for (const e of events) {
        const d = JSON.parse(e.data_json) as { token: string; price: number };
        if (!series.has(d.token)) series.set(d.token, []);
        series.get(d.token)!.push(d.price);
      }
      let wins = 0;
      let losses = 0;
      let openEnded = 0;
      let totalPnl = 0;
      for (const [token, prices] of series) {
        const entry = prices[0]!;
        let high = entry;
        let exited = false;
        for (const p of prices.slice(1)) {
          high = Math.max(high, p);
          const reason = evaluateExit(entry, p, high, rules);
          if (reason) {
            const pnl = ((p - entry) / entry) * 100;
            totalPnl += pnl;
            pnl >= 0 ? wins++ : losses++;
            console.log(`${token}: exit=${reason} pnl=${pnl.toFixed(2)}% after ${prices.indexOf(p)} ticks`);
            exited = true;
            break;
          }
        }
        if (!exited) openEnded++;
      }
      console.log(`\nbacktest over ${series.size} tokens (${events.length} price ticks):`);
      console.log(`  rules: TP=${rules.takeProfitPercent}% SL=${rules.stopLossPercent}% trailing=${rules.trailingStopPercent ?? 'off'}`);
      console.log(`  exits: ${wins} wins / ${losses} losses / ${openEnded} never exited`);
      console.log(`  cumulative pnl across exits: ${totalPnl.toFixed(2)}%`);
      console.log('  NOTE: this replays paper/mock price data — indicative only, not a market simulation.');
    }),
  );

// ---------------------------------------------------------------- dashboard

program
  .command('dashboard')
  .description('start the read-only web dashboard (and the live pipeline) on localhost')
  .option('--port <n>', 'port to listen on', '3000')
  .option('--host <host>', 'host to bind (default 127.0.0.1, local-only)', '127.0.0.1')
  .option('--no-pipeline', 'serve the dashboard only, without running the scanner/trader')
  .option('--enable-actions', 'allow one-click buy/sell from the browser (paper/testnet only; never live)', false)
  .action((opts: { port: string; host: string; pipeline: boolean; enableActions: boolean }) =>
    withApp(async (app) => {
      const { startDashboard } = await import('./dashboard/server.js');
      const handle = await startDashboard(app, { port: Number(opts.port), host: opts.host, enableActions: opts.enableActions });
      console.log(`\n  Dashboard:  ${handle.url}`);
      console.log(`  Mode:       ${app.cfg.mode}${app.simulationOnly ? ' (simulation-only: mock adapter)' : ''}`);
      const actionsState = opts.enableActions ? (app.cfg.mode === 'live' ? 'requested but DISABLED in live mode (CLI-only)' : 'ENABLED (paper/testnet)') : 'off (read-only)';
      console.log(`  Actions:    ${actionsState}`);
      console.log(`  ${opts.pipeline ? 'Live pipeline running (scanner + trading + positions).' : 'Dashboard only (pipeline disabled).'}`);
      console.log('  Ctrl-C to stop.\n');

      if (opts.pipeline) {
        app.positions.start();
        if (app.adapter instanceof MockDexAdapter) {
          const mock = app.adapter;
          const t = setInterval(() => mock.tickPrices(), 2000);
          t.unref?.();
        }
        const stop = async () => {
          await handle.close();
          app.shutdown();
          process.exit(0);
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        await app.scanner.watch(); // runs until Ctrl-C
      } else {
        await new Promise<void>((resolve) => {
          process.on('SIGINT', async () => {
            await handle.close();
            resolve();
          });
        });
      }
    }),
  );

program.parseAsync(process.argv).catch((err) => {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
