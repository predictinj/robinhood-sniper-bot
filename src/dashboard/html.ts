/**
 * The dashboard page as a single self-contained string (no bundler, no CDN).
 * It polls /api/state every few seconds and renders read-only bot state.
 */
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Robinhood Sniper Bot</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #131823; --panel2: #1a2030; --line: #26304a;
    --text: #e6ebf5; --muted: #8b98b5; --green: #35d07f; --red: #ff5c6c;
    --amber: #ffb454; --accent: #4c8dff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { padding: 16px 24px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; letter-spacing: .5px; }
  .pill { padding: 2px 10px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); background: var(--panel2); }
  .pill.mode-paper { color: var(--accent); border-color: var(--accent); }
  .pill.mode-testnet { color: var(--amber); border-color: var(--amber); }
  .pill.mode-live { color: var(--red); border-color: var(--red); }
  .pill.ok { color: var(--green); border-color: var(--green); }
  .pill.stop { color: var(--red); border-color: var(--red); background: #2a1418; }
  main { padding: 24px; display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); max-width: 1400px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .panel h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin: 0; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .panel .body { padding: 12px 16px; }
  .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; }
  .stat .k { color: var(--muted); font-size: 12px; }
  .stat .v { font-size: 18px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 7px 16px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; position: sticky; top: 0; background: var(--panel); }
  td.addr { font-family: ui-monospace; color: var(--muted); }
  .scroll { max-height: 320px; overflow: auto; }
  .pos { color: var(--green); } .neg { color: var(--red); }
  .badge { padding: 1px 7px; border-radius: 6px; font-size: 11px; border: 1px solid var(--line); }
  .b-open { color: var(--accent); } .b-closed { color: var(--muted); }
  .b-buy { color: var(--green); } .b-sell { color: var(--amber); }
  .b-failed { color: var(--red); }
  .full { grid-column: 1 / -1; }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); padding: 16px; font-style: italic; }
  .blockers li { color: var(--amber); }
  .warn-banner { background: #2a1418; border: 1px solid var(--red); color: var(--red); border-radius: 10px; padding: 10px 16px; grid-column: 1/-1; }
  a { color: var(--accent); }
  footer { padding: 12px 24px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<header>
  <h1>⌖ ROBINHOOD SNIPER BOT</h1>
  <span id="mode" class="pill">…</span>
  <span id="dex" class="pill">…</span>
  <span id="chain" class="pill">…</span>
  <span id="estop" class="pill" style="display:none">⛔ EMERGENCY STOP</span>
  <span id="live" class="pill" style="display:none">LIVE ARMED</span>
  <span style="margin-left:auto" class="muted">updated <span id="updated">—</span></span>
</header>
<main id="root">
  <div class="panel"><h2>loading…</h2><div class="body">connecting to /api/state</div></div>
</main>
<footer>Read-only view · data from local SQLite · no keys are ever sent to this page · refreshes every 4s</footer>

<script>
const $ = (id) => document.getElementById(id);
const short = (a) => a ? a.slice(0, 8) + '…' + a.slice(-6) : '—';
const pnlClass = (n) => n >= 0 ? 'pos' : 'neg';
const fmtPnl = (n) => (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%';
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function tick() {
  let d;
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    d = await r.json();
  } catch (e) {
    $('updated').textContent = 'connection lost — retrying';
    return;
  }
  const c = d.config, s = d.state, sum = d.summary;

  const modeEl = $('mode');
  modeEl.textContent = 'MODE: ' + c.mode.toUpperCase() + (c.simulationOnly ? ' (sim)' : '');
  modeEl.className = 'pill mode-' + c.mode;
  $('dex').textContent = 'DEX: ' + c.dex;
  $('chain').textContent = 'chain ' + c.chainId;
  $('estop').style.display = s.emergencyStop ? '' : 'none';
  $('estop').className = 'pill stop';
  const liveEl = $('live');
  if (s.liveBlockers.length === 0) { liveEl.style.display = ''; liveEl.className = 'pill stop'; liveEl.textContent = '🔴 LIVE ARMED'; }
  else { liveEl.style.display = 'none'; }
  $('updated').textContent = new Date(d.now).toLocaleTimeString();

  const panels = [];

  if (s.emergencyStop) {
    panels.push('<div class="warn-banner">⛔ EMERGENCY STOP ACTIVE — all trading is disabled. Run <code>bot resume</code> to clear it.</div>');
  }

  // overview
  panels.push(panel('Overview', \`
    <div class="stat-grid">
      \${stat('Open positions', sum.openPositions)}
      \${stat('Closed', sum.closedPositions)}
      \${stat('Avg unrealized PnL', '<span class="' + pnlClass(sum.unrealizedPnlPercentAvg) + '">' + fmtPnl(sum.unrealizedPnlPercentAvg) + '</span>')}
      \${stat('Open cost', sum.totalCostOpenEth + ' ETH')}
      \${stat('Trades', sum.trades)}
      \${stat(c.mode === 'paper' ? 'Paper balance' : 'Wallet', s.paperBalanceEth ? s.paperBalanceEth + ' ETH' : '—')}
    </div>\`));

  // live readiness
  const readiness = s.liveBlockers.length === 0
    ? '<span class="pos">✔ live trading fully armed</span>'
    : '<div class="muted">live trading blocked by:</div><ul class="blockers">' + s.liveBlockers.map((b) => '<li>' + esc(b) + '</li>').join('') + '</ul>';
  panels.push(panel('Live readiness', readiness));

  // risk config
  panels.push(panel('Risk limits', \`
    <div class="stat-grid">
      \${stat('Max buy', c.maxBuyEth + ' ETH')}
      \${stat('Max slippage', c.maxSlippageBps + ' bps')}
      \${stat('Gas cap', c.maxGasGwei + ' gwei')}
      \${stat('Min liquidity', c.minLiquidityEth + ' ETH')}
      \${stat('Max tax', c.maxTokenTaxBps + ' bps')}
      \${stat('Max positions', c.maxOpenPositions)}
      \${stat('Take profit', c.takeProfitPercent + '%')}
      \${stat('Stop loss', c.stopLossPercent + '%')}
      \${stat('Trailing', c.trailingStopPercent != null ? c.trailingStopPercent + '%' : 'off')}
      \${stat('Cooldown', c.cooldownSeconds + 's')}
    </div>\`));

  // positions
  panels.push(tablePanel('Positions', ['#', 'Token', 'Status', 'Entry', 'Current', 'PnL', 'Cost'],
    d.positions.map((p) => \`<tr>
      <td>\${p.id}</td>
      <td class="addr">\${short(p.token)}</td>
      <td><span class="badge b-\${p.status}">\${p.status}</span>\${p.closeReason ? ' <span class="muted">' + esc(p.closeReason) + '</span>' : ''}</td>
      <td>\${Number(p.entryPrice).toExponential(3)}</td>
      <td>\${Number(p.currentPrice).toExponential(3)}</td>
      <td class="\${pnlClass(p.pnlPercent)}">\${fmtPnl(p.pnlPercent)}</td>
      <td>\${p.costEth}</td></tr>\`), 'full'));

  // trades
  panels.push(tablePanel('Recent trades', ['#', 'Time', 'Mode', 'Side', 'Status', 'Token', 'In', 'Out'],
    d.trades.map((t) => \`<tr>
      <td>\${t.id}</td>
      <td class="muted">\${esc(t.createdAt)}</td>
      <td>\${esc(t.mode)}</td>
      <td><span class="badge b-\${t.side}">\${t.side}</span></td>
      <td><span class="badge \${t.status === 'failed' ? 'b-failed' : ''}">\${esc(t.status)}</span></td>
      <td class="addr">\${short(t.token)}</td>
      <td>\${esc(t.amountIn)}</td>
      <td>\${esc(t.amountOut)}</td></tr>\`), 'full'));

  // discovered pools
  panels.push(tablePanel('Discovered pools', ['Pool', 'Token', 'DEX', 'Liquidity', 'Found'],
    d.pools.map((p) => \`<tr>
      <td class="addr">\${short(p.address)}</td>
      <td class="addr">\${short(p.token)}</td>
      <td>\${esc(p.dex)}</td>
      <td>\${p.liquidityBase ?? '—'}</td>
      <td class="muted">\${esc(p.discoveredAt)}</td></tr>\`)));

  // flagged tokens
  panels.push(tablePanel('⚠ Flagged tokens', ['Token', 'Symbol', 'Reason'],
    d.flaggedTokens.map((f) => \`<tr>
      <td class="addr">\${short(f.address)}</td>
      <td>\${esc(f.symbol)}</td>
      <td class="neg">\${esc(f.notes)}</td></tr>\`)));

  // errors
  if (d.errors.length) {
    panels.push(tablePanel('Recent errors', ['Scope', 'Message', 'Time'],
      d.errors.map((e) => \`<tr>
        <td>\${esc(e.scope)}</td>
        <td class="neg">\${esc(e.message)}</td>
        <td class="muted">\${esc(e.created_at)}</td></tr>\`)));
  }

  $('root').innerHTML = panels.join('');
}

function panel(title, bodyHtml) {
  return '<div class="panel"><h2>' + esc(title) + '</h2><div class="body">' + bodyHtml + '</div></div>';
}
function stat(k, v) {
  return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
}
function tablePanel(title, cols, rows, extraClass) {
  const head = '<tr>' + cols.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr>';
  const body = rows.length ? rows.join('') : '';
  const inner = rows.length
    ? '<div class="scroll"><table>' + head + body + '</table></div>'
    : '<div class="empty">none yet</div>';
  return '<div class="panel ' + (extraClass || '') + '"><h2>' + esc(title) + '</h2>' + inner + '</div>';
}

tick();
setInterval(tick, 4000);
</script>
</body>
</html>`;
