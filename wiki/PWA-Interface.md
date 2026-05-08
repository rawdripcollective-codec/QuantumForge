# PWA Interface

QuantumForge ships with a Progressive Web App (PWA) served at `http://127.0.0.1:18789`. Open it in any modern browser — including the browser built into Termux — to interact with the agent system without writing any code.

---

## Installing as a PWA

On Android (Termux browser or Chrome):
1. Open `http://127.0.0.1:18789`.
2. Tap the browser menu → **Add to Home Screen**.

On desktop Chrome/Edge:
1. Open `http://127.0.0.1:18789`.
2. Click the install icon in the address bar, or use the browser menu → **Install QuantumForge**.

The app works offline (service worker caches the shell) but agent tasks still require the server to be running.

---

## Navigation

The header shows the app name, version badge, and a **connection dot** (green when the WebSocket is active, grey when disconnected).

Four tabs are available:

| Tab | Purpose |
|---|---|
| **Playground** | Submit tasks and watch real-time agent progress |
| **Integrations** | Browse and test registered MCP tools |
| **Memory** | View episode history and mistakes |
| **Self-Improve** | Run and monitor the self-improvement engine |

---

## Playground

The main tab for submitting tasks to the agent.

### Usage

1. Type a task in the text area (e.g. `"Write a Python script that reverses a string"`).
2. Click **Run Agent**.
3. Watch the log pane fill with colour-coded progress lines:
   - 🔵 **Blue** — informational (planning, solving steps)
   - 🟢 **Green** — success (verdict passed, task done)
   - 🟠 **Orange** — warnings (retry round)
   - 🔴 **Red** — errors
   - ⚫ **Muted** — neutral / metadata

4. The final summary appears as a green `done` line when the pipeline completes.
5. Click **Clear** to reset the log.

### How It Works

The Playground connects to the server via WebSocket. Each streaming event emitted by the kernel is rendered as a log line in real time. If the WebSocket is disconnected the button is disabled until reconnection.

---

## Integrations

Displays all tools currently registered in the MCP Fabric.

### Usage

1. Click **↻ Refresh** to reload the tool list from `GET /api/tools`.
2. Each tool appears as a card showing its **name** and **description**.
3. Click **Test** on any card to invoke the tool with an empty `args` object (`POST /api/tools/:name`). The response is shown in a browser alert.

Use this panel to verify that custom tools you registered are available before running agent tasks that depend on them.

---

## Memory

Shows the content of the persistent memory stores.

### Sections

**Recent Episodes** — A table of the last completed tasks:

| Column | Contents |
|---|---|
| Time | ISO timestamp of when the episode was saved |
| Task | The original task string |
| Summary | The pipeline's text summary (one line per step) |

**Mistakes** — A table of failed tasks:

| Column | Contents |
|---|---|
| Time | ISO timestamp |
| Task | The task that failed |
| Error | The error message |

### Usage

Click **↻ Refresh** to reload from `GET /api/memory`. The page does not auto-refresh — click the button any time you want the latest data.

---

## Self-Improve

Shows the state of the self-improvement scheduler and lets you trigger it manually.

### Status Card

Displays:
- **Schedule** — the cron expression (e.g. `0 * * * *` = every hour).
- **Last run** — timestamp of the most recent completed cycle, or "—" if it has never run.

### Run Now

Click **Run Now** to trigger an immediate self-improvement cycle (equivalent to `POST /api/self-improve/run`). The button shows "Running…" while the cycle executes.

### Latest Insights

After the cycle completes the insights list updates with entries such as:

- **Recurring error** — `Recurring error "…" – review handler logic`
- **Frequent task** — `Frequent task pattern: "…" – consider caching`

If no patterns meet the thresholds the list shows "No insights found for this cycle."
