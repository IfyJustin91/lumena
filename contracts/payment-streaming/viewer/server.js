/**
 * Payment Streaming Contract – Web Viewer
 *
 * A minimal Express server that simulates the on-chain stream state in
 * memory and exposes it via a REST API consumed by the browser dashboard.
 *
 * This is a *simulator* – it mirrors the exact contract logic so the UI
 * shows the same numbers you'd get from invoking the Soroban contract on
 * Stellar Testnet.
 *
 * Run:  node server.js
 * Open: http://localhost:3420
 */

"use strict";

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());

// ─── In-memory stream store ────────────────────────────────────────────────

let nextId = 0;
const streams = {}; // id (number) → Stream object

const StreamState = {
  Active: "Active",
  Paused: "Paused",
  Cancelled: "Cancelled",
  Completed: "Completed",
};

/**
 * Mirror of the contract's accrued_amount helper.
 * claimable = min(deposit, (now - start_time) * rate_per_second)
 */
function accrued(stream, nowSec) {
  if (
    stream.state === StreamState.Paused ||
    stream.state === StreamState.Cancelled ||
    stream.state === StreamState.Completed
  ) {
    return 0;
  }
  const elapsed = Math.max(0, nowSec - stream.start_time);
  const acc = elapsed * stream.rate_per_second;
  return Math.min(stream.deposit, acc);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// ─── API routes ────────────────────────────────────────────────────────────

// List all streams.
app.get("/api/streams", (_req, res) => {
  const now = nowSec();
  const list = Object.values(streams).map((s) => ({
    ...s,
    claimable: accrued(s, now),
  }));
  res.json(list);
});

// Get a single stream.
app.get("/api/streams/:id", (req, res) => {
  const s = streams[Number(req.params.id)];
  if (!s) return res.status(404).json({ error: "NotFound" });
  const now = nowSec();
  res.json({ ...s, claimable: accrued(s, now) });
});

// Create a new stream.
// Body: { sender, recipient, token, deposit, rate_per_second }
app.post("/api/streams", (req, res) => {
  const { sender, recipient, token, deposit, rate_per_second } = req.body;
  if (!sender || !recipient || !token)
    return res.status(400).json({ error: "Missing required fields" });
  if (Number(deposit) <= 0)
    return res.status(400).json({ error: "InvalidAmount: deposit must be > 0" });
  if (Number(rate_per_second) <= 0)
    return res.status(400).json({ error: "InvalidAmount: rate_per_second must be > 0" });

  const id = nextId++;
  const now = nowSec();
  streams[id] = {
    id,
    sender,
    recipient,
    token: token || "XLM",
    deposit: Number(deposit),
    rate_per_second: Number(rate_per_second),
    start_time: now,
    withdrawn: 0,
    state: StreamState.Active,
    paused_at: 0,
    created_at: now,
  };
  res.status(201).json({ ...streams[id], claimable: 0 });
});

// Top up an existing stream.
// Body: { amount }
app.post("/api/streams/:id/top_up", (req, res) => {
  const s = streams[Number(req.params.id)];
  if (!s) return res.status(404).json({ error: "NotFound" });
  const amount = Number(req.body.amount);
  if (amount <= 0) return res.status(400).json({ error: "InvalidAmount" });
  if (s.state === StreamState.Cancelled || s.state === StreamState.Completed)
    return res.status(400).json({ error: "InvalidState" });

  s.deposit += amount;
  const now = nowSec();
  res.json({ ...s, claimable: accrued(s, now) });
});

// Pause a stream.
app.post("/api/streams/:id/pause", (req, res) => {
  const s = streams[Number(req.params.id)];
  if (!s) return res.status(404).json({ error: "NotFound" });
  if (s.state !== StreamState.Active)
    return res.status(400).json({ error: "InvalidState: stream must be Active to pause" });

  const now = nowSec();
  // Settle accrual: advance start_time to now so pause doesn't lose accrued tokens.
  s.start_time = now;
  s.paused_at = now;
  s.state = StreamState.Paused;
  res.json({ ...s, claimable: accrued(s, now) });
});

// Resume a paused stream.
app.post("/api/streams/:id/resume", (req, res) => {
  const s = streams[Number(req.params.id)];
  if (!s) return res.status(404).json({ error: "NotFound" });
  if (s.state !== StreamState.Paused)
    return res.status(400).json({ error: "InvalidState: stream must be Paused to resume" });

  const now = nowSec();
  s.start_time = now;
  s.paused_at = 0;
  s.state = StreamState.Active;
  res.json({ ...s, claimable: accrued(s, now) });
});

// Cancel a stream – sends accrued to recipient, refunds remainder to sender.
app.post("/api/streams/:id/cancel", (req, res) => {
  const s = streams[Number(req.params.id)];
  if (!s) return res.status(404).json({ error: "NotFound" });
  if (s.state === StreamState.Cancelled || s.state === StreamState.Completed)
    return res.status(400).json({ error: "InvalidState" });

  const now = nowSec();
  const acc = accrued(s, now);
  const refund = s.deposit - acc;

  s.state = StreamState.Cancelled;
  s.deposit = 0;

  res.json({
    ...s,
    claimable: 0,
    accrued_paid_to_recipient: acc,
    refunded_to_sender: refund,
  });
});

// Withdraw accrued tokens.
app.post("/api/streams/:id/withdraw", (req, res) => {
  const s = streams[Number(req.params.id)];
  if (!s) return res.status(404).json({ error: "NotFound" });
  if (s.state === StreamState.Cancelled)
    return res.status(400).json({ error: "InvalidState" });

  const now = nowSec();
  const amount = accrued(s, now);
  if (amount === 0)
    return res.status(400).json({ error: "NothingToWithdraw" });

  s.deposit -= amount;
  s.withdrawn += amount;
  if (s.state === StreamState.Active) {
    s.start_time = now;
  }
  if (s.deposit <= 0) {
    s.deposit = 0;
    s.state = StreamState.Completed;
  }

  res.json({ ...s, withdrawn_now: amount, claimable: 0 });
});

// Delete all streams (reset for demo).
app.delete("/api/streams", (_req, res) => {
  Object.keys(streams).forEach((k) => delete streams[k]);
  nextId = 0;
  res.json({ ok: true });
});

// ─── HTML dashboard ─────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.send(HTML);
});

// ─── Start ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3420;
app.listen(PORT, () => {
  console.log(`\n🚀  Payment Streaming Viewer`);
  console.log(`   Open http://localhost:${PORT}\n`);
});

// ─── Inline HTML ────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Payment Streaming — Stellar Soroban</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --border: #30363d;
      --primary: #58a6ff;
      --green: #3fb950;
      --yellow: #d29922;
      --red: #f85149;
      --purple: #bc8cff;
      --text: #c9d1d9;
      --muted: #8b949e;
      --radius: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      min-height: 100vh;
    }
    header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 12px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    header h1 { font-size: 18px; color: var(--primary); }
    header span { color: var(--muted); font-size: 12px; }
    .badge {
      background: #1f2937;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2px 8px;
      font-size: 11px;
      color: var(--muted);
    }
    main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      grid-template-columns: 340px 1fr;
      gap: 24px;
    }
    @media(max-width: 768px) { main { grid-template-columns: 1fr; } }
    section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
    h2 { font-size: 14px; font-weight: 600; margin-bottom: 16px; color: var(--text); border-bottom: 1px solid var(--border); padding-bottom: 10px; }
    label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; margin-top: 12px; }
    input, select {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      padding: 7px 10px;
      font-size: 13px;
      outline: none;
    }
    input:focus, select:focus { border-color: var(--primary); }
    button {
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      padding: 8px 14px;
      font-weight: 500;
      transition: opacity .15s;
    }
    button:hover { opacity: .85; }
    .btn-primary { background: var(--primary); color: #000; }
    .btn-green   { background: var(--green);   color: #000; }
    .btn-yellow  { background: var(--yellow);  color: #000; }
    .btn-red     { background: var(--red);     color: #fff; }
    .btn-purple  { background: var(--purple);  color: #000; }
    .btn-ghost   { background: #21262d; color: var(--text); border: 1px solid var(--border); }
    .row { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
    .stream-list { display: flex; flex-direction: column; gap: 14px; }
    .stream-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
    }
    .stream-card.active   { border-left: 3px solid var(--green);  }
    .stream-card.paused   { border-left: 3px solid var(--yellow); }
    .stream-card.cancelled{ border-left: 3px solid var(--red);    }
    .stream-card.completed{ border-left: 3px solid var(--purple); }
    .stream-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .stream-id { font-weight: 700; color: var(--primary); }
    .state-badge {
      font-size: 11px; font-weight: 600; border-radius: 10px; padding: 2px 8px;
    }
    .state-Active    { background: #1a3a1a; color: var(--green);  }
    .state-Paused    { background: #3a2e00; color: var(--yellow); }
    .state-Cancelled { background: #3a1a1a; color: var(--red);    }
    .state-Completed { background: #2a1a3a; color: var(--purple); }
    .stream-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; font-size: 12px;
    }
    .kv { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #1e242c; }
    .kv .k { color: var(--muted); }
    .kv .v { color: var(--text); font-family: monospace; }
    .progress-bar-wrap {
      margin-top: 10px;
      background: #1e242c;
      border-radius: 4px;
      height: 8px;
      overflow: hidden;
    }
    .progress-bar { height: 100%; border-radius: 4px; transition: width .5s ease; background: var(--green); }
    .progress-bar.paused   { background: var(--yellow); }
    .progress-bar.cancelled{ background: var(--red);    }
    .stream-actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
    .claimable-row { 
      display: flex; justify-content: space-between; align-items: center; 
      background: #1a2e1a; border-radius: 6px; padding: 6px 10px; margin-top: 10px;
    }
    .claimable-label { font-size: 11px; color: var(--muted); }
    .claimable-val { font-size: 16px; font-weight: 700; color: var(--green); font-family: monospace; }
    #toast {
      position: fixed; bottom: 24px; right: 24px;
      background: #2ea043; color: #fff;
      border-radius: 8px; padding: 10px 18px;
      font-size: 13px; font-weight: 500;
      opacity: 0; transition: opacity .3s;
      pointer-events: none;
      max-width: 340px;
    }
    #toast.error { background: #da3633; }
    #toast.show { opacity: 1; }
    .empty-state { text-align: center; color: var(--muted); padding: 40px 0; font-size: 13px; }
    .reset-row { text-align: right; margin-bottom: 8px; }
    .formula {
      background: #0d1117;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 14px;
      font-family: monospace;
      font-size: 12px;
      color: var(--yellow);
      margin-bottom: 14px;
    }
  </style>
</head>
<body>
<header>
  <h1>⚡ Payment Streaming</h1>
  <span>Stellar Soroban Contract Viewer</span>
  <span class="badge">Issue #228</span>
</header>

<main>
  <!-- ── Create Stream form ── -->
  <section>
    <h2>Create Stream</h2>
    <div class="formula">claimable = (now − start) × rate_per_second</div>
    <label>Sender Address</label>
    <input id="f-sender" placeholder="G… or Alice" value="Alice" />
    <label>Recipient Address</label>
    <input id="f-recipient" placeholder="G… or Bob" value="Bob" />
    <label>Token</label>
    <input id="f-token" placeholder="XLM, USDC, …" value="USDC" />
    <label>Deposit (tokens)</label>
    <input id="f-deposit" type="number" min="1" value="3600" />
    <label>Rate per Second</label>
    <input id="f-rate" type="number" min="1" value="1" />
    <div class="row">
      <button class="btn-primary" onclick="createStream()">Create Stream</button>
    </div>

    <hr style="border-color:var(--border);margin:20px 0 14px" />
    <h2 style="margin-bottom:8px">Top-up Selected Stream</h2>
    <label>Stream ID</label>
    <input id="topup-id" type="number" min="0" value="0" />
    <label>Amount to Add</label>
    <input id="topup-amount" type="number" min="1" value="1000" />
    <div class="row">
      <button class="btn-green" onclick="topUp()">Top Up</button>
    </div>
  </section>

  <!-- ── Stream list ── -->
  <section>
    <div class="reset-row">
      <button class="btn-ghost" onclick="resetAll()">Reset All</button>
    </div>
    <h2>Active Streams</h2>
    <div id="stream-list" class="stream-list">
      <div class="empty-state">No streams yet. Create one on the left.</div>
    </div>
  </section>
</main>

<div id="toast"></div>

<script>
const API = '';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n) { return Number(n).toLocaleString(undefined, {maximumFractionDigits:4}); }
function addr(a) { return a.length > 20 ? a.slice(0,8)+'…'+a.slice(-6) : a; }

function toast(msg, isError=false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = '', 3200);
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(API + path, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// ── CRUD wrappers ─────────────────────────────────────────────────────────────

async function createStream() {
  try {
    const s = await api('POST', '/api/streams', {
      sender:         document.getElementById('f-sender').value.trim(),
      recipient:      document.getElementById('f-recipient').value.trim(),
      token:          document.getElementById('f-token').value.trim(),
      deposit:        Number(document.getElementById('f-deposit').value),
      rate_per_second:Number(document.getElementById('f-rate').value),
    });
    toast('Stream #' + s.id + ' created ✓');
    render();
  } catch(e) { toast(e.message, true); }
}

async function topUp() {
  try {
    const id     = Number(document.getElementById('topup-id').value);
    const amount = Number(document.getElementById('topup-amount').value);
    await api('POST', '/api/streams/'+id+'/top_up', { amount });
    toast('Topped up stream #'+id+' ✓');
    render();
  } catch(e) { toast(e.message, true); }
}

async function pause(id) {
  try { await api('POST','/api/streams/'+id+'/pause'); toast('Stream #'+id+' paused'); render(); }
  catch(e) { toast(e.message, true); }
}

async function resume(id) {
  try { await api('POST','/api/streams/'+id+'/resume'); toast('Stream #'+id+' resumed ▶'); render(); }
  catch(e) { toast(e.message, true); }
}

async function cancel(id) {
  if (!confirm('Cancel stream #'+id+'? Accrued tokens go to recipient; remainder is refunded.')) return;
  try {
    const r = await api('POST','/api/streams/'+id+'/cancel');
    toast('Cancelled. Accrued: '+fmt(r.accrued_paid_to_recipient)+' | Refunded: '+fmt(r.refunded_to_sender));
    render();
  } catch(e) { toast(e.message, true); }
}

async function withdraw(id) {
  try {
    const r = await api('POST','/api/streams/'+id+'/withdraw');
    toast('Withdrew '+fmt(r.withdrawn_now)+' tokens from stream #'+id+' ✓');
    render();
  } catch(e) { toast(e.message, true); }
}

async function resetAll() {
  if (!confirm('Delete all streams?')) return;
  await api('DELETE','/api/streams');
  toast('Reset ✓');
  render();
}

// ── Render ────────────────────────────────────────────────────────────────────

async function render() {
  const list = await api('GET','/api/streams');
  const el   = document.getElementById('stream-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty-state">No streams yet. Create one on the left.</div>';
    return;
  }

  el.innerHTML = list.map(s => {
    const total     = s.deposit + s.withdrawn;
    const pct       = total > 0 ? Math.min(100, (s.withdrawn / total) * 100) : 0;
    const claimPct  = total > 0 ? Math.min(100 - pct, (s.claimable / total) * 100) : 0;
    const stateClass = s.state.toLowerCase();
    const elapsed   = Math.floor(Date.now()/1000) - s.start_time;

    let actions = '';
    if (s.state === 'Active') {
      actions = \`
        <button class="btn-green" onclick="withdraw(\${s.id})">Withdraw</button>
        <button class="btn-yellow" onclick="pause(\${s.id})">Pause</button>
        <button class="btn-red" onclick="cancel(\${s.id})">Cancel</button>
      \`;
    } else if (s.state === 'Paused') {
      actions = \`
        <button class="btn-primary" onclick="resume(\${s.id})">Resume</button>
        <button class="btn-red" onclick="cancel(\${s.id})">Cancel</button>
      \`;
    }

    return \`
    <div class="stream-card \${stateClass}">
      <div class="stream-header">
        <span class="stream-id">Stream #\${s.id}</span>
        <span class="state-badge state-\${s.state}">\${s.state}</span>
      </div>

      <div class="stream-grid">
        <div class="kv"><span class="k">Sender</span>    <span class="v">\${addr(s.sender)}</span></div>
        <div class="kv"><span class="k">Recipient</span> <span class="v">\${addr(s.recipient)}</span></div>
        <div class="kv"><span class="k">Token</span>     <span class="v">\${s.token}</span></div>
        <div class="kv"><span class="k">Rate</span>      <span class="v">\${fmt(s.rate_per_second)}/sec</span></div>
        <div class="kv"><span class="k">Deposit</span>   <span class="v">\${fmt(s.deposit)}</span></div>
        <div class="kv"><span class="k">Withdrawn</span> <span class="v">\${fmt(s.withdrawn)}</span></div>
      </div>

      \${s.state === 'Active' ? \`
      <div class="claimable-row">
        <span class="claimable-label">⚡ Claimable now</span>
        <span class="claimable-val">\${fmt(s.claimable)} \${s.token}</span>
      </div>
      \` : ''}

      <div class="progress-bar-wrap" title="Streamed \${pct.toFixed(1)}%">
        <div class="progress-bar \${stateClass}" style="width:\${pct + claimPct}%"></div>
      </div>

      \${actions ? \`<div class="stream-actions">\${actions}</div>\` : ''}
    </div>\`;
  }).join('');
}

// Poll every second to update claimable amounts live.
render();
setInterval(render, 1000);
</script>
</body>
</html>`;
