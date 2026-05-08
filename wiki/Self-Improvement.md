# Self-Improvement

QuantumForge includes a built-in self-improvement engine that periodically analyses past mistakes and usage patterns, then stores actionable insights in memory so future agent runs can benefit from them.

---

## How It Works

1. **Trigger** — A `node-cron` job fires on the configured schedule (default: every hour, `"0 * * * *"`).
2. **Load data** — The engine reads the last 20 mistakes and last 20 episodes from memory.
3. **Analyse** — Two rule-based checks run (no LLM required):
   - **Recurring errors** — any error message that appears ≥ `recurringErrorThreshold` (default 2) times generates an insight.
   - **Frequent task patterns** — any task prefix (first 50 characters) that appears ≥ `frequentTaskThreshold` (default 3) times generates an insight.
4. **Persist** — Insights are written to `memory` under the key `selfImprove.lastInsights`, alongside `selfImprove.lastRunTs`.

---

## Insight Shape

```json
[
  {
    "type": "recurring_error",
    "error": "Access denied: path is outside the allowed directory",
    "count": 3,
    "lesson": "Recurring error \"Access denied…\" – review handler logic"
  },
  {
    "type": "frequent_task",
    "pattern": "List JavaScript files",
    "count": 4,
    "lesson": "Frequent task pattern: \"List JavaScript files\" – consider caching"
  }
]
```

---

## Triggering Manually

You do not have to wait for the cron schedule — you can trigger a cycle instantly:

### Via REST

```bash
curl -s -X POST http://127.0.0.1:18789/api/self-improve/run | jq .
```

### Via the UI

1. Open [http://127.0.0.1:18789](http://127.0.0.1:18789).
2. Click the **Self-Improve** tab.
3. Click **Run Now**.

The Latest Insights list updates automatically.

---

## Checking the Scheduler Status

```bash
curl http://127.0.0.1:18789/api/self-improve/status | jq .
```

```json
{
  "enabled": true,
  "schedule": "0 * * * *",
  "lastRun": "2026-05-08T14:00:00.000Z",
  "lastReport": {
    "insights": [...],
    "mistakesAnalysed": 20,
    "episodesAnalysed": 20
  },
  "running": true
}
```

---

## Configuration

All self-improvement settings live in `config/default.json` under the `selfImprove` key:

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Set to `false` to disable the cron job entirely |
| `cronSchedule` | `"0 * * * *"` | Standard cron expression (every hour on the hour) |
| `recurringErrorThreshold` | `2` | Minimum occurrences before an error is flagged as recurring |
| `frequentTaskThreshold` | `3` | Minimum occurrences before a task pattern is flagged as frequent |

See [Configuration](Configuration) for the full reference.

---

## Programmatic API

```js
const selfImprove = require('./src/self-improve');

// Start the cron scheduler (called automatically by server.js)
selfImprove.start();

// Stop the scheduler
selfImprove.stop();

// Run one cycle immediately and get the report
const report = await selfImprove.run();
// report = { insights, mistakesAnalysed, episodesAnalysed }

// Get current scheduler state
const state = selfImprove.status();
// state = { enabled, schedule, lastRun, lastReport, running }
```

---

## How Agents Use Insights

The self-improve module stores insights under `selfImprove.lastInsights` using `memory.set`. Because the kernel enriches every task's context with recent episodes, insights indirectly influence future Solver and Critic behaviour when the LLM reads recent memory.

You can also pass insights explicitly as context:

```bash
curl -X POST http://127.0.0.1:18789/api/agent \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Fix the recurring access-denied errors in tool calls",
    "context": {
      "insights": [
        {
          "type": "recurring_error",
          "lesson": "Recurring error \"Access denied…\" – review handler logic"
        }
      ]
    }
  }'
```
