import { buildApp, preflight } from './bot.js';
import { MockDexAdapter } from './dex/mock.js';
import { logger } from './utils/logger.js';

/**
 * Long-running entry point: scanner + auto-trade pipeline + position manager.
 * MODE (paper/testnet/live) decides how trades execute; live trades are only
 * possible after every gate in docs/LIVE_TRADING_WARNING.md is satisfied.
 */
async function main() {
  const app = buildApp();
  const { cfg } = app;

  logger.info(
    { mode: cfg.mode, chainId: cfg.chainId, dex: app.adapter.name, simulationOnly: app.simulationOnly },
    'robinhood-sniper-bot starting',
  );

  if (cfg.mode === 'live') {
    const blockers = app.engine.realTradeBlockers();
    if (blockers.length) {
      logger.warn({ blockers }, 'MODE=live but live trading is NOT armed — running in monitor mode. Fix the blockers and run `bot confirm-live`.');
    } else {
      logger.warn('*** LIVE TRADING ARMED — real funds at risk. `npm run bot -- emergency-stop` halts all trading instantly. ***');
    }
  }
  if (app.simulationOnly) {
    logger.info('Running with the MOCK adapter (no real DEX configured). Paper trading works fully; set DEX_TYPE + addresses in .env for real markets.');
  }

  const problems = await preflight(app);
  for (const p of problems) logger.error({ problem: p }, 'preflight problem');
  if (problems.length && cfg.mode !== 'paper') {
    logger.error('preflight failed — fix RPC/chain configuration before trading. Exiting.');
    process.exit(1);
  }

  app.positions.start();

  // in mock mode, tick synthetic prices so TP/SL logic has movement to react to
  if (app.adapter instanceof MockDexAdapter) {
    const mock = app.adapter;
    const t = setInterval(() => mock.tickPrices(), 2000);
    t.unref?.();
  }

  const stop = () => {
    logger.info('shutting down…');
    app.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('uncaughtException', (err) => {
    app.db.insertError('process', `uncaughtException: ${err.message}`);
    logger.error({ err: err.message }, 'uncaught exception — continuing unless fatal');
  });
  process.on('unhandledRejection', (reason) => {
    app.db.insertError('process', `unhandledRejection: ${String(reason)}`);
    logger.error({ reason: String(reason) }, 'unhandled rejection — continuing');
  });

  await app.scanner.watch(); // runs until SIGINT
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'fatal startup error');
  process.exit(1);
});
