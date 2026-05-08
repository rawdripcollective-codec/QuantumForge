# QuantumForge Wiki

**QuantumForge** is a locally-hosted super-agent designed for full-stack development, AI orchestration, and self-improving workflows. It runs entirely on your device — including Android via Termux — and works offline without an OpenAI API key (using stub responses in that case).

---

## What Is QuantumForge?

QuantumForge is a Node.js gateway that wires together a multi-agent AI pipeline, a file-system-safe tool registry (the MCP Fabric), persistent memory, and a built-in self-improvement engine — all exposed through a REST/WebSocket API and a Progressive Web App (PWA) UI you can open in any browser.

You describe a task in plain language; QuantumForge decomposes it into steps, executes each step (calling tools when needed), critiques the results, and retries automatically if the output is not good enough.

---

## Key Features

| Feature | Description |
|---|---|
| **Multi-agent pipeline** | Planner → Solver → Critic loop with configurable retry rounds |
| **MCP Fabric** | Built-in filesystem and memory tools; custom server auto-generation |
| **Persistent memory** | File-backed episodes, mistakes, and key-value store |
| **Self-improvement** | Hourly cron job that analyses errors and usage patterns |
| **PWA UI** | Playground, Integrations, Memory, and Self-Improve panels |
| **WebSocket streaming** | Real-time step-by-step agent progress |
| **Offline-capable** | Works without `OPENAI_API_KEY`; falls back to stub responses |
| **Runs on Termux** | Lightweight enough for Android via Termux or proot Ubuntu |

---

## Wiki Pages

| Page | Contents |
|---|---|
| [Getting Started](Getting-Started) | Installation, quick start, offline mode |
| [Architecture](Architecture) | Component overview and Planner→Solver→Critic pipeline |
| [API Reference](API-Reference) | All REST endpoints and the WebSocket protocol |
| [MCP Tools](MCP-Tools) | Built-in tools, registering custom tools, server auto-generation |
| [Memory System](Memory-System) | Episodes, mistakes, key-value store |
| [Self-Improvement](Self-Improvement) | Cron-based insight loop and how to trigger it manually |
| [Configuration](Configuration) | Every option in `config/default.json` explained |
| [PWA Interface](PWA-Interface) | Guide to the four UI panels |

---

## Quick Links

- **Start the server:** `npm start`
- **Open the UI:** [http://127.0.0.1:18789](http://127.0.0.1:18789)
- **Health check:** `GET /health`
- **Run a task (curl):**
  ```bash
  curl -s -X POST http://127.0.0.1:18789/api/agent \
    -H "Content-Type: application/json" \
    -d '{"task": "Write a hello-world Python script"}'
  ```

---

MIT © 2026 rawdripcollective-codec
