/**
 * Axiom-inspired trading-terminal dashboard as a single self-contained page
 * (no bundler, no CDN). Polls /api/state and renders a "Pulse" discovery feed
 * plus positions, trades and safety analytics for Robinhood Chain tokens.
 */
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Robinhood Sniper · Pulse</title>
<style>
  :root {
    --bg:#080a10; --bg2:#0d1019; --panel:#111624; --panel2:#161c2c; --line:#212a40;
    --text:#eaf0fb; --muted:#7f8db0; --dim:#5b6685;
    --green:#2fe08a; --red:#ff5a6a; --amber:#ffb454; --accent:#5b8cff; --violet:#a988ff;
    --a:#2fe08a; --b:#8ee06a; --c:#ffb454; --d:#ff8a5a; --f:#ff5a6a;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body { margin:0; background:radial-gradient(1200px 600px at 80% -10%, #12203f22, transparent), var(--bg);
    color:var(--text); font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  a { color:var(--accent); text-decoration:none; }

  header { display:flex; align-items:center; gap:14px; padding:12px 20px; border-bottom:1px solid var(--line);
    background:linear-gradient(180deg,#0e1220,#0b0e17); position:sticky; top:0; z-index:20; flex-wrap:wrap; }
  .logo { font-weight:700; letter-spacing:1px; font-size:15px; display:flex; align-items:center; gap:8px; }
  .logo .mark { color:var(--accent); }
  .pill { padding:2px 10px; border-radius:999px; font-size:11px; border:1px solid var(--line); background:var(--panel2); color:var(--muted); white-space:nowrap; }
  .pill.mode-paper { color:var(--accent); border-color:#2c4a8a; }
  .pill.mode-testnet { color:var(--amber); border-color:#6a4e1e; }
  .pill.mode-live { color:var(--red); border-color:#7a2630; }
  .pill.stop { color:var(--red); border-color:var(--red); background:#25121680; }
  .spacer { margin-left:auto; }
  .kpis { display:flex; gap:18px; align-items:center; flex-wrap:wrap; }
  .kpi .kv { font-size:15px; } .kpi .kl { font-size:10px; color:var(--dim); text-transform:uppercase; letter-spacing:.6px; }
  .pos { color:var(--green); } .neg { color:var(--red); }

  .pulse { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; padding:16px 20px; align-items:start; }
  @media (max-width:1080px){ .pulse{ grid-template-columns:1fr; } }
  .col { background:var(--bg2); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .col > h2 { margin:0; padding:11px 14px; font-size:12px; letter-spacing:.5px; display:flex; align-items:center; gap:8px;
    border-bottom:1px solid var(--line); background:var(--panel); }
  .col .dot { width:8px; height:8px; border-radius:50%; }
  .col .count { margin-left:auto; color:var(--dim); font-size:11px; }
  .list { max-height:calc(100vh - 230px); overflow:auto; }
  .list::-webkit-scrollbar { width:8px; } .list::-webkit-scrollbar-thumb { background:#1e2740; border-radius:8px; }

  .card { display:grid; grid-template-columns:34px 1fr auto; gap:10px; padding:10px 12px; border-bottom:1px solid #182036; cursor:default; transition:background .1s; }
  .card:hover { background:#121a2e; }
  .av { width:34px; height:34px; border-radius:9px; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px; color:#05070d; }
  .mid { min-width:0; }
  .row1 { display:flex; align-items:center; gap:8px; }
  .sym { font-weight:600; }
  .addr { color:var(--dim); font-size:11px; }
  .row2 { display:flex; gap:6px; flex-wrap:wrap; margin-top:5px; }
  .chip { font-size:10.5px; padding:1px 7px; border-radius:6px; border:1px solid var(--line); color:var(--muted); background:#0e1526; white-space:nowrap; }
  .chip.warnf { color:var(--amber); border-color:#5c451f; }
  .chip.critf { color:var(--red); border-color:#5c2029; background:#1c1013; }
  .grade { font-weight:700; padding:1px 7px; border-radius:6px; font-size:11px; color:#05070d; }
  .right { text-align:right; display:flex; flex-direction:column; align-items:flex-end; gap:5px; }
  .price { font-size:12px; }
  .chg { font-size:11px; }
  .spark { display:block; }
  .actions { display:flex; gap:5px; margin-top:4px; }
  button.act { font:inherit; font-size:10.5px; padding:2px 8px; border-radius:6px; border:1px solid var(--line); background:#12203f; color:var(--accent); cursor:pointer; }
  button.act:hover { background:#183056; }
  button.act.sell { color:var(--amber); background:#241a0e; border-color:#5c451f; }
  button.act:disabled { opacity:.4; cursor:not-allowed; }
  .empty { color:var(--dim); font-style:italic; padding:18px 14px; }

  .lower { display:grid; grid-template-columns:1.3fr 1fr; gap:14px; padding:0 20px 24px; }
  @media (max-width:1080px){ .lower{ grid-template-columns:1fr; } }
  .panel { background:var(--bg2); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .panel > h2 { margin:0; padding:11px 14px; font-size:12px; letter-spacing:.5px; border-bottom:1px solid var(--line); background:var(--panel); color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-size:11.5px; }
  th,td { text-align:left; padding:6px 12px; border-bottom:1px solid #182036; white-space:nowrap; }
  th { color:var(--dim); font-weight:500; position:sticky; top:0; background:var(--panel); }
  .tscroll { max-height:300px; overflow:auto; }
  .badge { padding:1px 6px; border-radius:5px; font-size:10.5px; border:1px solid var(--line); }
  .b-buy{ color:var(--green);} .b-sell{ color:var(--amber);} .b-failed{ color:var(--red);} .b-confirmed{ color:var(--green);} .b-simulated{ color:var(--accent);}
  .banner { margin:14px 20px 0; padding:9px 14px; border-radius:10px; background:#25121680; border:1px solid var(--red); color:var(--red); }
  .blockers { margin:6px 0 0; padding-left:18px; color:var(--amber); font-size:11.5px; }
  #toast { position:fixed; right:18px; bottom:18px; display:flex; flex-direction:column; gap:8px; z-index:50; }
  .toast { padding:9px 13px; border-radius:9px; border:1px solid var(--line); background:#121a2e; font-size:12px; box-shadow:0 6px 22px #0008; max-width:340px; }
  .toast.ok { border-color:#2c6a45; } .toast.err { border-color:#6a2630; color:var(--red); }
  footer { padding:12px 20px; color:var(--dim); font-size:11px; border-top:1px solid var(--line); }
</style>
</head>
<body>
<header>
  <div class="logo"><span class="mark">⌖</span> ROBINHOOD SNIPER <span style="color:var(--dim);font-weight:400">/ pulse</span></div>
  <span id="mode" class="pill">…</span>
  <span id="dex" class="pill">…</span>
  <span id="chain" class="pill">…</span>
  <span id="estop" class="pill stop" style="display:none">⛔ STOP</span>
  <span id="live" class="pill stop" style="display:none">🔴 LIVE</span>
  <div class="spacer"></div>
  <div class="kpis">
    <div class="kpi"><div id="k-bal" class="kv">—</div><div class="kl">balance</div></div>
    <div class="kpi"><div id="k-open" class="kv">—</div><div class="kl">open</div></div>
    <div class="kpi"><div id="k-pnl" class="kv">—</div><div class="kl">avg pnl</div></div>
    <div class="kpi"><div id="k-trades" class="kv">—</div><div class="kl">trades</div></div>
    <div class="kpi"><div id="k-upd" class="kv" style="font-size:12px;color:var(--muted)">—</div><div class="kl">updated</div></div>
  </div>
</header>

<div id="bannerHost"></div>

<section class="pulse">
  <div class="col"><h2><span class="dot" style="background:var(--accent)"></span> New Pairs <span id="c-new" class="count"></span></h2><div id="new" class="list"></div></div>
  <div class="col"><h2><span class="dot" style="background:var(--green)"></span> Passed Safety <span id="c-safe" class="count"></span></h2><div id="safe" class="list"></div></div>
  <div class="col"><h2><span class="dot" style="background:var(--violet)"></span> Holding <span id="c-hold" class="count"></span></h2><div id="hold" class="list"></div></div>
</section>

<section class="lower">
  <div class="panel"><h2>Recent trades</h2><div id="trades" class="tscroll"></div></div>
  <div class="panel"><h2>⚠ Flagged &amp; risk</h2><div id="flagged" class="tscroll"></div></div>
</section>

<footer id="foot">read-only unless quick-actions enabled · localhost · no keys ever sent to this page</footer>
<div id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const short = (a) => a ? a.slice(0,6)+'…'+a.slice(-4) : '—';
const pnlClass = (n)=> n>=0?'pos':'neg';
const fmtPnl = (n)=> (n>=0?'+':'')+Number(n).toFixed(1)+'%';
const gradeColor = { A:'var(--a)', B:'var(--b)', C:'var(--c)', D:'var(--d)', F:'var(--f)' };
let ACTIONS = false;
let MAXBUY = 0.01;

function age(s){ if(s<60)return s+'s'; if(s<3600)return Math.floor(s/60)+'m'; if(s<86400)return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
function fmtPrice(p){ if(p==null)return '—'; if(p===0)return '0'; return Number(p).toExponential(2); }

// deterministic color from address
function hue(addr){ let h=0; for(let i=2;i<Math.min(addr.length,12);i++) h=(h*31+addr.charCodeAt(i))%360; return h; }
function avatar(c){ const h=hue(c.token); const bg='hsl('+h+' 70% 62%)'; const label=(c.symbol||c.token.slice(2,4)).slice(0,3).toUpperCase();
  return '<div class="av" style="background:linear-gradient(135deg,'+bg+',hsl('+((h+40)%360)+' 70% 52%))">'+esc(label)+'</div>'; }

function sparkline(series, up){
  if(!series || series.length<2) return '<svg class="spark" width="72" height="22"></svg>';
  const w=72,h=22,min=Math.min(...series),max=Math.max(...series),rng=(max-min)||1;
  const pts=series.map((v,i)=>{ const x=(i/(series.length-1))*w; const y=h-2-((v-min)/rng)*(h-4); return x.toFixed(1)+','+y.toFixed(1); }).join(' ');
  const col=up>=0?'var(--green)':'var(--red)';
  return '<svg class="spark" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><polyline fill="none" stroke="'+col+'" stroke-width="1.4" points="'+pts+'"/></svg>';
}

function safetyChips(c){
  const chips=[];
  if(c.safety.checked){
    const g=c.safety.grade;
    chips.push('<span class="grade" style="background:'+gradeColor[g]+'" title="safety score '+c.safety.score+'/100">'+g+' '+c.safety.score+'</span>');
  } else {
    chips.push('<span class="chip">unchecked</span>');
  }
  chips.push('<span class="chip">⏳ '+age(c.ageSeconds)+'</span>');
  if(c.liquidityEth!=null) chips.push('<span class="chip">💧 '+Number(c.liquidityEth).toFixed(2)+'</span>');
  if(c.safety.taxBps!=null) chips.push('<span class="chip'+(c.safety.taxBps>1000?' warnf':'')+'">tax '+(c.safety.taxBps/100).toFixed(1)+'%</span>');
  for(const f of c.safety.criticalFlags.slice(0,2)) chips.push('<span class="chip critf">✖ '+esc(f)+'</span>');
  for(const f of c.safety.warnFlags.slice(0,1)) chips.push('<span class="chip warnf">⚠ '+esc(f)+'</span>');
  return chips.join('');
}

function actionsHtml(c, held){
  if(!ACTIONS) return '';
  if(held) return '<div class="actions"><button class="act sell" onclick="trade(\\'sell\\',\\''+c.token+'\\',{percent:50})">sell 50%</button><button class="act sell" onclick="trade(\\'sell\\',\\''+c.token+'\\',{percent:100})">sell all</button></div>';
  const dis = c.safety.checked && !c.safety.passed ? 'disabled title="failed safety"' : '';
  const half = +(MAXBUY/2).toFixed(4), full = +MAXBUY.toFixed(4);
  return '<div class="actions"><button class="act" '+dis+' onclick="trade(\\'buy\\',\\''+c.token+'\\',{amount:'+half+'})">buy '+half+'Ξ</button><button class="act" '+dis+' onclick="trade(\\'buy\\',\\''+c.token+'\\',{amount:'+full+'})">buy max</button></div>';
}

function cardHtml(c, opts){
  const held=!!opts.held;
  const chg = c.priceChangePct;
  const right = held
    ? '<div class="price">'+fmtPrice(c.price)+'</div><div class="chg '+pnlClass(c.pnlPercent||0)+'">'+fmtPnl(c.pnlPercent||0)+'</div>'+sparkline(c.sparkline, c.pnlPercent||0)+actionsHtml(c,true)
    : '<div class="price">'+fmtPrice(c.price)+'</div>'+(chg!=null?'<div class="chg '+pnlClass(chg)+'">'+fmtPnl(chg)+'</div>':'')+sparkline(c.sparkline, chg||0)+actionsHtml(c,false);
  return '<div class="card">'+avatar(c)+
    '<div class="mid"><div class="row1"><span class="sym">'+esc(c.symbol||'???')+'</span>'+
      '<span class="addr">'+short(c.token)+'</span><span class="chip">'+esc(c.dex)+'</span></div>'+
      '<div class="row2">'+safetyChips(c)+'</div></div>'+
    '<div class="right">'+right+'</div></div>';
}

function fill(id, cards, opts){
  const host=$(id);
  host.innerHTML = cards.length ? cards.map((c)=>cardHtml(c,opts)).join('') : '<div class="empty">nothing yet</div>';
}

async function trade(action, token, extra){
  try{
    const r = await fetch('/api/trade',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({action,token},extra))});
    const j = await r.json();
    toast(j.ok ? (j.message||'ok') : (j.error||'failed'), j.ok);
    tick();
  }catch(e){ toast(String(e), false); }
}

function toast(msg, ok){
  const el=document.createElement('div');
  el.className='toast '+(ok?'ok':'err');
  el.textContent=(ok?'✔ ':'✖ ')+msg;
  $('toast').appendChild(el);
  setTimeout(()=>el.remove(), 5200);
}

async function tick(){
  let d;
  try{ const r=await fetch('/api/state',{cache:'no-store'}); d=await r.json(); }
  catch(e){ $('k-upd').textContent='offline'; return; }
  const c=d.config, s=d.state, sum=d.summary;
  ACTIONS = d.actions.enabled;
  MAXBUY = c.maxBuyEth;

  const m=$('mode'); m.textContent='MODE '+c.mode.toUpperCase()+(c.simulationOnly?' · sim':''); m.className='pill mode-'+c.mode;
  $('dex').textContent='dex '+c.dex;
  $('chain').textContent='chain '+c.chainId;
  $('estop').style.display = s.emergencyStop?'':'none';
  $('live').style.display = (s.liveBlockers.length===0)?'':'none';

  $('k-bal').textContent = s.paperBalanceEth ? Number(s.paperBalanceEth).toFixed(3)+' Ξ' : (c.mode==='paper'?'—':'live');
  $('k-open').textContent = sum.openPositions+'/'+c.maxOpenPositions;
  $('k-pnl').innerHTML = '<span class="'+pnlClass(sum.unrealizedPnlPercentAvg)+'">'+fmtPnl(sum.unrealizedPnlPercentAvg)+'</span>';
  $('k-trades').textContent = sum.trades;
  $('k-upd').textContent = new Date(d.now).toLocaleTimeString();

  // banner
  let banner='';
  if(s.emergencyStop) banner+='<div class="banner">⛔ EMERGENCY STOP — all trading disabled. Run <code>bot resume</code> to clear.</div>';
  if(c.mode!=='paper' && s.liveBlockers.length){ banner+='<div class="banner" style="background:#1a1712;border-color:#5c451f;color:var(--amber)">live trading blocked: <ul class="blockers">'+s.liveBlockers.map((b)=>'<li>'+esc(b)+'</li>').join('')+'</ul></div>'; }
  $('bannerHost').innerHTML=banner;

  fill('new', d.feed.newPairs, {});
  fill('safe', d.feed.passedSafety, {});
  fill('hold', d.feed.holding, {held:true});
  $('c-new').textContent=d.feed.newPairs.length;
  $('c-safe').textContent=d.feed.passedSafety.length;
  $('c-hold').textContent=d.feed.holding.length;

  // trades table
  $('trades').innerHTML = d.trades.length ? '<table><tr><th>#</th><th>time</th><th>mode</th><th>side</th><th>status</th><th>token</th><th>in</th><th>out</th></tr>'+
    d.trades.map((t)=>'<tr><td>'+t.id+'</td><td style="color:var(--dim)">'+esc(t.createdAt)+'</td><td>'+esc(t.mode)+'</td>'+
      '<td><span class="badge b-'+t.side+'">'+t.side+'</span></td><td><span class="badge b-'+t.status+'">'+esc(t.status)+'</span></td>'+
      '<td class="addr">'+short(t.token)+'</td><td>'+esc(String(t.amountIn).slice(0,10))+'</td><td>'+esc(String(t.amountOut).slice(0,12))+'</td></tr>').join('')+'</table>'
    : '<div class="empty">no trades yet</div>';

  // flagged / risk
  const flg=d.feed.flagged;
  $('flagged').innerHTML = flg.length ? '<table><tr><th>token</th><th>grade</th><th>reason</th></tr>'+
    flg.map((c)=>'<tr><td><span class="sym">'+esc(c.symbol||'???')+'</span> <span class="addr">'+short(c.token)+'</span></td>'+
      '<td><span class="grade" style="background:'+gradeColor[c.safety.grade]+'">'+c.safety.grade+'</span></td>'+
      '<td class="neg">'+esc((c.safety.criticalFlags[0]||c.safety.warnFlags[0]||'flagged'))+'</td></tr>').join('')+'</table>'
    : '<div class="empty">nothing flagged — clean</div>';

  $('foot').textContent = ACTIONS
    ? 'quick-actions ENABLED ('+c.mode+' mode) · one-click buy/sell go through full risk gates · live is CLI-only'
    : 'read-only · start with --enable-actions for one-click buy/sell (paper/testnet only) · no keys ever sent to this page';
}

tick();
setInterval(tick, 3000);
</script>
</body>
</html>`;
