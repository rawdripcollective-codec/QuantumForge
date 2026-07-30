/* QuantumForge PWA – app.js */
'use strict';

// ── Service Worker registration ───────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── Tab navigation ────────────────────────────────────────────────────────────
const navBtns = document.querySelectorAll('nav button');
navBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    navBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    const target = document.getElementById(`panel-${btn.dataset.panel}`);
    if (target) target.classList.add('active');

    // Lazy-load panel data on first visit
    if (btn.dataset.panel === 'integrations') loadTools();
    if (btn.dataset.panel === 'memory') loadMemory();
    if (btn.dataset.panel === 'self-improve') loadSiStatus();
  });
});

// ── Streaming step accumulators ───────────────────────────────────────────────
// Maps step key → { el, text } for real-time token streaming per step.
const stepAccumulators = new Map();

function getStepKey(step) {
  return `${step?.step ?? '?'}`;
}

function startStep(step) {
  const key = getStepKey(step);
  if (stepAccumulators.has(key)) return stepAccumulators.get(key);
  const el = document.createElement('div');
  el.className = 'line streaming';
  el.innerHTML = `<span class="streaming-label">  Step ${step?.step ?? '?'}:</span> <span class="streaming-text"></span><span class="streaming-cursor">▍</span>`;
  agentLog.appendChild(el);
  const acc = { el, text: '' };
  stepAccumulators.set(key, acc);
  return acc;
}

function appendToken(step, token) {
  const key = getStepKey(step);
  const acc = stepAccumulators.get(key);
  if (!acc) return;
  acc.text += token;
  acc.el.querySelector('.streaming-text').textContent = acc.text;
  agentLog.scrollTop = agentLog.scrollHeight;
}

function finalizeStep(step, result, accepted) {
  const key = getStepKey(step);
  const acc = stepAccumulators.get(key);
  if (acc) {
    acc.el.querySelector('.streaming-cursor').remove();
    acc.el.classList.remove('streaming');
    const cls = accepted ? 'success' : 'warn';
    acc.el.classList.add(cls);
    acc.el.title = result;
    stepAccumulators.delete(key);
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wsUrl = `ws://${location.host}`;
let ws = null;
const statusDot = document.getElementById('statusDot');

function connectWS() {
  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    statusDot.classList.add('connected');
    statusDot.title = 'Connected';
  });

  ws.addEventListener('close', () => {
    statusDot.classList.remove('connected');
    statusDot.title = 'Disconnected – reconnecting…';
    setTimeout(connectWS, 3000);
  });

  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleWsMessage(msg);
    } catch {
      appendLog(ev.data, 'muted');
    }
  });
}

connectWS();

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'connected':
      appendLog(`Gateway connected at ${msg.ts}`, 'info');
      break;

    case 'planning':
      appendLog(`▶ Planning: "${msg.task}"`, 'info');
      break;

    case 'steps':
      appendLog(`  Steps (${msg.steps.length}): ${msg.steps.map((s) => s.action || 'unknown').join(' → ')}`, 'muted');
      break;

    case 'llm_call':
      // Solver is starting an LLM call — begin streaming accumulator for this step
      startStep(msg.step);
      break;

    case 'token': {
      // Real-time token from the LLM — stream into the step accumulator
      appendToken(msg.step, msg.token);
      break;
    }

    case 'tool_call':
      if (!stepAccumulators.has(getStepKey(msg.step))) startStep(msg.step);
      appendLog(`  ↳ Tool: ${msg.tool} ${msg.args ? JSON.stringify(msg.args).slice(0, 60) : ''}`, 'muted');
      break;

    case 'tool_result':
      appendLog(`  ↳ Tool result (${msg.truncated} chars)`, 'muted');
      break;

    case 'tool_error':
      appendLog(`  ⚠ Tool error: ${msg.err}`, 'warn');
      break;

    case 'tool_unknown':
      appendLog(`  ⚠ Unknown tool: ${msg.tool}`, 'warn');
      break;

    case 'solver_error':
      appendLog(`  ⚠ Solver error: ${msg.err}`, 'error');
      break;

    case 'solver_final':
      finalizeStep(msg.step, msg.result, true);
      break;

    case 'solving':
      appendLog(`  [Round ${msg.round}] Solving step ${msg.step.step}: ${msg.step.action}`, 'info');
      break;

    case 'critiquing':
      appendLog(`  Critiquing step ${msg.step.step}…`, 'muted');
      break;

    case 'verdict':
      appendLog(
        `  Verdict: ${msg.verdict.pass ? '✓ pass' : '✗ fail'} – ${msg.verdict.feedback}`,
        msg.verdict.pass ? 'success' : 'warn'
      );
      break;

    case 'done':
      appendLog('── Done ──', 'success');
      if (msg.result?.summary) appendLog(msg.result.summary, 'success');
      if (msg.result?.costUsd !== undefined) appendLog(`Cost: $${msg.result.costUsd.toFixed(4)} USD`, 'muted');
      setStatus('Done');
      setRunning(false);
      break;

    case 'error':
      appendLog(`Error: ${msg.error}`, 'error');
      setStatus('Error');
      setRunning(false);
      break;

    default:
      if (msg.type && msg !== msg.type) {
        // Has meaningful fields beyond type — log it minimally
        appendLog(`[${msg.type}]`, 'muted');
      }
  }
}

// ── Playground ────────────────────────────────────────────────────────────────
const taskInput = document.getElementById('taskInput');
const runBtn = document.getElementById('runBtn');
const clearBtn = document.getElementById('clearBtn');
const agentLog = document.getElementById('agentLog');
const statusLabel = document.getElementById('statusLabel');

runBtn.addEventListener('click', runAgent);
clearBtn.addEventListener('click', () => {
  agentLog.innerHTML = '<div class="line muted">Agent output will appear here…</div>';
  setStatus('Ready');
});

taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runAgent();
});

function runAgent() {
  const task = taskInput.value.trim();
  if (!task) return;

  clearLog();
  setRunning(true);
  setStatus('Running…');
  appendLog(`Task: ${task}`, 'info');

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'agent', task }));
  } else {
    // Fallback: SSE streaming endpoint
    fetch('/api/agent/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task })
    }).then((r) => {
      if (!r.ok) return Promise.reject(new Error(`HTTP ${r.status}`));
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let curEvent = '';
      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('event: ')) { curEvent = line.slice(7).trim(); continue; }
            if (line.startsWith('data: ') && curEvent) {
              try { handleWsMessage(JSON.parse(line.slice(6))); } catch { handleWsMessage({ type: curEvent }); }
              curEvent = null;
            }
          }
          if (!r.body.locked) pump();
        });
      }
      pump();
    }).catch((err) => {
      appendLog(`Error: ${err.message}`, 'error');
      setStatus('Error');
      setRunning(false);
    });
  }
}

function appendLog(text, cls = '') {
  const div = document.createElement('div');
  div.className = `line${cls ? ' ' + cls : ''}`;
  div.textContent = text;
  agentLog.appendChild(div);
  agentLog.scrollTop = agentLog.scrollHeight;
}

function clearLog() {
  agentLog.innerHTML = '';
}

function setRunning(running) {
  runBtn.disabled = running;
}

function setStatus(text) {
  statusLabel.textContent = text;
}

// ── Integrations ──────────────────────────────────────────────────────────────
const toolsGrid = document.getElementById('toolsGrid');
document.getElementById('refreshToolsBtn').addEventListener('click', loadTools);

async function loadTools() {
  toolsGrid.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">Loading…</div>';
  try {
    const response = await fetch('/api/tools');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    const tools = await response.json();
    if (!tools.length) {
      toolsGrid.innerHTML = '<div style="color:var(--muted)">No tools registered.</div>';
      return;
    }
    toolsGrid.innerHTML = '';
    tools.forEach((t) => {
      const card = document.createElement('div');
      card.className = 'tool-card';
      card.innerHTML = `
        <h3>${esc(t.name)}</h3>
        <p>${esc(t.description || 'No description')}</p>
        <button class="tool-test-btn" data-tool="${esc(t.name)}">Test ↗</button>
      `;
      card.querySelector('.tool-test-btn').addEventListener('click', () => testTool(t.name));
      toolsGrid.appendChild(card);
    });
  } catch (err) {
    toolsGrid.innerHTML = `<div style="color:#ff7b72">Failed to load tools: ${esc(err.message)}</div>`;
  }
}

async function testTool(name) {
  const args = {};
  if (name === 'fs.read') args.path = './README.md';
  if (name === 'fs.list') args.path = '.';
  if (name === 'memory.get') args.key = 'test';

  try {
    const response = await fetch(`/api/tools/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args })
    });
    const res = await response.json();

    if (!response.ok) {
      throw new Error(res.error || res.message || `Request failed with status ${response.status}`);
    }

    if (!('result' in res)) {
      throw new Error('Tool response did not include a result.');
    }

    alert(`Tool "${name}" result:\n${JSON.stringify(res.result, null, 2)}`);
  } catch (err) {
    alert(`Tool "${name}" error: ${err.message}`);
  }
}

// ── Memory ────────────────────────────────────────────────────────────────────
document.getElementById('refreshMemoryBtn').addEventListener('click', loadMemory);

async function loadMemory() {
  try {
    const data = await fetch('/api/memory').then((r) => r.json());

    const epsTbody = document.querySelector('#episodesTable tbody');
    epsTbody.innerHTML = '';
    (data.episodes || []).slice(-20).reverse().forEach((ep) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(ep.ts?.slice(0, 19).replace('T', ' ') || '')}</td>
        <td>${esc((ep.task || '').slice(0, 60))}</td>
        <td>${esc((ep.result?.summary || '').slice(0, 80))}</td>
      `;
      epsTbody.appendChild(tr);
    });

    const misTbody = document.querySelector('#mistakesTable tbody');
    misTbody.innerHTML = '';
    (data.mistakes || []).slice(-20).reverse().forEach((m) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(m.ts?.slice(0, 19).replace('T', ' ') || '')}</td>
        <td>${esc((m.task || '').slice(0, 60))}</td>
        <td style="color:#ff7b72">${esc((m.error || '').slice(0, 80))}</td>
      `;
      misTbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Failed to load memory:', err);
  }
}

// ── Self-Improve ──────────────────────────────────────────────────────────────
document.getElementById('siRunBtn').addEventListener('click', async () => {
  document.getElementById('siRunBtn').disabled = true;
  try {
    const response = await fetch('/api/self-improve/run', { method: 'POST' });
    const report = await response.json();
    if (!response.ok) {
      throw new Error(report?.error || `Failed to run self-improve: HTTP ${response.status}`);
    }
    renderSiReport(report);
  } catch (err) {
    alert('Self-improve error: ' + err.message);
  } finally {
    document.getElementById('siRunBtn').disabled = false;
  }
});

async function loadSiStatus() {
  try {
    const response = await fetch('/api/self-improve/status');
    if (!response.ok) {
      throw new Error(`Failed to load self-improve status: HTTP ${response.status}`);
    }
    const s = await response.json();
    document.getElementById('siSchedule').textContent = `Schedule: ${s.schedule}`;
    document.getElementById('siLastRun').textContent = `Last run: ${s.lastRun || 'never'}`;
    if (s.lastReport) renderSiReport(s.lastReport);
  } catch (err) {
    console.error('Failed to load self-improve status:', err);
  }
}

function renderSiReport(report) {
  const list = document.getElementById('insightList');
  if (!report?.insights?.length) {
    list.innerHTML = '<li style="color:var(--muted)">No insights found.</li>';
    return;
  }
  list.innerHTML = '';
  report.insights.forEach((ins) => {
    const li = document.createElement('li');
    li.innerHTML = `<span style="color:var(--warn)">[${esc(ins.type)}]</span> <span class="lesson">${esc(ins.lesson)}</span>`;
    list.appendChild(li);
  });
}

// ── Util ──────────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
