# Configuration

All runtime configuration lives in a single file: **`config/default.json`**.

Edit this file and restart the server (`npm start`) for changes to take effect.

---

## Full Default Configuration

```json
{
  "gateway": {
    "host": "127.0.0.1",
    "port": 18789
  },
  "agents": {
    "maxRounds": 5,
    "timeoutMs": 30000
  },
  "mcp": {
    "registryPath": "./data/mcp-registry.json"
  },
  "memory": {
    "path": "./data/memory.json",
    "episodesPath": "./data/episodes.json",
    "mistakesPath": "./data/mistakes.json",
    "maxEpisodes": 1000
  },
  "selfImprove": {
    "cronSchedule": "0 * * * *",
    "enabled": true,
    "recurringErrorThreshold": 2,
    "frequentTaskThreshold": 3
  },
  "openai": {
    "model": "gpt-4o",
    "baseURL": "https://api.openai.com/v1"
  }
}
```

---

## Reference

### `gateway`

| Key | Default | Description |
|---|---|---|
| `host` | `"127.0.0.1"` | Interface the HTTP server binds to. Use `"0.0.0.0"` to expose on all interfaces (not recommended on untrusted networks). |
| `port` | `18789` | TCP port for the HTTP and WebSocket server. |

---

### `agents`

| Key | Default | Description |
|---|---|---|
| `maxRounds` | `5` | Maximum Solver→Critic retry loops per step. If the Critic never passes after this many rounds, the last result is kept and the pipeline moves on. |
| `timeoutMs` | `30000` | OpenAI API request timeout in milliseconds. Set to `0` to use the client's default (no explicit timeout). |

---

### `mcp`

| Key | Default | Description |
|---|---|---|
| `registryPath` | `"./data/mcp-registry.json"` | Path to the persisted tool registry. Relative to the project root. |

---

### `memory`

| Key | Default | Description |
|---|---|---|
| `path` | `"./data/memory.json"` | Key-value memory store file. |
| `episodesPath` | `"./data/episodes.json"` | Completed-task history file. |
| `mistakesPath` | `"./data/mistakes.json"` | Failed-task history file. |
| `maxEpisodes` | `1000` | Maximum number of episodes to retain. Older entries are dropped when the limit is exceeded. |

---

### `selfImprove`

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Set to `false` to disable the cron scheduler entirely. |
| `cronSchedule` | `"0 * * * *"` | Standard 5-field cron expression. Default fires every hour on the hour. |
| `recurringErrorThreshold` | `2` | Minimum occurrences in the last 20 mistakes before an error is flagged. |
| `frequentTaskThreshold` | `3` | Minimum occurrences in the last 20 episodes before a task pattern is flagged. |

---

### `openai`

| Key | Default | Description |
|---|---|---|
| `model` | `"gpt-4o"` | OpenAI model name passed to all three agents. Change to `"gpt-4o-mini"` for lower cost, or any compatible model. |
| `baseURL` | `"https://api.openai.com/v1"` | API base URL. Point this at a compatible local server (e.g. Ollama with an OpenAI-compatible endpoint) to run fully offline with a real LLM. |

---

## Using a Local LLM (e.g. Ollama)

1. Start Ollama with an OpenAI-compatible endpoint:
   ```bash
   ollama serve
   # Ollama exposes http://localhost:11434 with an /v1 compatible layer
   ```
2. Update `config/default.json`:
   ```json
   {
     "openai": {
       "model": "llama3",
       "baseURL": "http://localhost:11434/v1"
     }
   }
   ```
3. Set a dummy API key (the OpenAI client requires a non-empty key even for local servers):
   ```bash
   export OPENAI_API_KEY=ollama
   npm start
   ```

---

## Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI (or compatible) API key. If absent, the server runs in offline stub mode. |

No other environment variables are read by QuantumForge itself.
