/**
 * LLM provider abstraction.
 * Creates an `llmCall(messages, opts)` function backed by one of four providers:
 *
 *   - openai      → OpenAI native (https://api.openai.com/v1)
 *   - openrouter  → OpenRouter (https://openrouter.ai/api/v1) — uses the
 *                   same SDK as OpenAI, just a different baseURL
 *   - anthropic   → Anthropic native (https://api.anthropic.com)
 *   - ollama      → local Ollama server (http://localhost:11434)
 *
 * The `llmCall` function:
 *   • Accepts an OpenAI-style messages array: [{role, content}, ...]
 *   • Returns the assistant's text content (string)
 *   • Supports `responseFormat: 'json'` for providers/models that can do JSON mode
 *   • Retries transient errors with exponential backoff
 *   • Records token usage for cost tracking
 *   • When no provider is configured (no API keys, Ollama not running),
 *     returns a deterministic offline stub so the system still runs locally
 *
 * All four providers are loaded lazily — only the SDK for the active provider
 * is required. Users who only want OpenAI don't need to install @anthropic-ai/sdk.
 */

'use strict';

const path = require('path');
const config = require(path.resolve(__dirname, '../../config/default.json'));
const { withRetry } = require('../lib/retry');
const cost = require('../lib/cost');
const log = require('../lib/logger');

// ── Provider implementations ───────────────────────────────────────────────────

/** OpenAI + OpenRouter share the same SDK. */
function makeOpenAIClient(providerConfig) {
  const { OpenAI } = require('openai');
  const opts = { apiKey: providerConfig.apiKey };
  if (providerConfig.baseURL) opts.baseURL = providerConfig.baseURL;
  if (Number.isFinite(providerConfig.timeoutMs) && providerConfig.timeoutMs > 0) {
    opts.timeout = providerConfig.timeoutMs;
  }
  return new OpenAI(opts);
}

async function callOpenAI(client, messages, opts, providerConfig) {
  const params = {
    model: opts.model || providerConfig.model,
    messages,
  };
  if (opts.responseFormat === 'json') {
    params.response_format = { type: 'json_object' };
  }
  // OpenAI temperature default 0.4 — enough variation for creativity,
  // low enough to be reproducible. Override via opts.temperature.
  if (typeof opts.temperature === 'number') params.temperature = opts.temperature;

  const completion = await client.chat.completions.create(params);
  const msg = completion.choices?.[0]?.message;
  if (!msg) throw new Error('OpenAI returned an empty completion');

  // Record cost if usage is reported (OpenAI always does).
  if (completion.usage) {
    cost.record({
      provider: 'openai',
      model: params.model,
      promptTokens: completion.usage.prompt_tokens,
      completionTokens: completion.usage.completion_tokens,
    });
  }

  return msg.content || '';
}

/** Anthropic uses a different SDK. */
function makeAnthropicClient(providerConfig) {
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  const opts = { apiKey: providerConfig.apiKey };
  if (providerConfig.baseURL) opts.baseURL = providerConfig.baseURL;
  if (Number.isFinite(providerConfig.timeoutMs) && providerConfig.timeoutMs > 0) {
    opts.timeout = providerConfig.timeoutMs;
  }
  return new Anthropic(opts);
}

async function callAnthropic(client, messages, opts, providerConfig) {
  // Anthropic separates the system message from the rest. Convert.
  const system = [];
  const rest = [];
  for (const m of messages) {
    if (m.role === 'system') system.push(m.content);
    else rest.push(m);
  }
  const params = {
    model: opts.model || providerConfig.model,
    max_tokens: opts.maxTokens || 4096,
    system: system.join('\n\n') || undefined,
    messages: rest.map((m) => ({ role: m.role, content: m.content })),
  };
  if (typeof opts.temperature === 'number') params.temperature = opts.temperature;

  const completion = await client.messages.create(params);
  // Concatenate text blocks; ignore tool_use blocks for now (we use text-based tools).
  const text = (completion.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  if (completion.usage) {
    cost.record({
      provider: 'anthropic',
      model: params.model,
      promptTokens: completion.usage.input_tokens,
      completionTokens: completion.usage.output_tokens,
    });
  }

  return text;
}

/** Ollama uses a simple HTTP API. No SDK needed. */
async function callOllama(messages, opts, providerConfig) {
  const baseURL = (providerConfig.baseURL || 'http://localhost:11434').replace(/\/$/, '');
  const params = {
    model: opts.model || providerConfig.model,
    messages,
    stream: false,
  };
  if (opts.responseFormat === 'json') params.format = 'json';
  if (typeof opts.temperature === 'number') params.options = { ...(params.options || {}), temperature: opts.temperature };

  const res = await fetch(`${baseURL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(providerConfig.timeoutMs || config.agents.timeoutMs || 30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data.message?.content || '';
  if (data.prompt_eval_count != null || data.eval_count != null) {
    cost.record({
      provider: 'ollama',
      model: params.model,
      promptTokens: data.prompt_eval_count || 0,
      completionTokens: data.eval_count || 0,
    });
  }
  return content;
}

// ── Provider router ────────────────────────────────────────────────────────────

/** Map provider name → (factory, call) tuple. Lazy-loaded. */
const PROVIDERS = {
  openai:     { make: makeOpenAIClient,   call: callOpenAI },
  openrouter: { make: makeOpenAIClient,   call: callOpenAI },
  anthropic:  { make: makeAnthropicClient, call: callAnthropic },
  ollama:     { make: null,               call: callOllama },  // no client needed
};

/** Which errors are retriable. */
function isRetriable(err) {
  const msg = String(err?.message || '');
  // Network errors and 5xx are retriable. 4xx is not (client error).
  if (err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT' || err?.code === 'ENOTFOUND') return true;
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  if (msg.includes('rate limit') || msg.includes('timeout') || msg.includes('overloaded')) return true;
  return false;
}

// ── API key resolution ────────────────────────────────────────────────────────

/** Resolve the API key for a provider. Returns null if not set. */
function resolveApiKey(provider) {
  switch (provider) {
    case 'openai':     return process.env.OPENAI_API_KEY     || null;
    case 'openrouter': return process.env.OPENROUTER_API_KEY || null;
    case 'anthropic':  return process.env.ANTHROPIC_API_KEY  || null;
    case 'ollama':     return null;  // local, no key
    default: return null;
  }
}

// ── Offline stub (no provider configured) ─────────────────────────────────────

function offlineStub(messages, opts) {
  const last = messages[messages.length - 1]?.content || '';
  const promptText = messages.map((m) => String(m?.content || '')).join('\n').toLowerCase();

  if (opts.responseFormat === 'json') {
    // Detect which agent we are by inspecting the SYSTEM message.
    // This is more reliable than keyword matching the user message,
    // which may contain words like "plan", "step", "result" that overlap
    // with multiple agents.
    const sys = (messages[0]?.content || '').toLowerCase();

    if (/\bcritic\b|\bcritique\b|\bverdict\b/.test(sys)) {
      return JSON.stringify({ pass: true, feedback: '' });
    }
    if (/\bplanner\b/.test(sys) || /decompose/i.test(sys)) {
      const taskMatch = last.match(/Task:\s*([^\n]+)/i);
      const taskText = taskMatch ? taskMatch[1].trim() : (last || 'Execute the task');
      return JSON.stringify([{ step: 1, action: taskText }]);
    }
    if (/\bsolver\b/.test(sys) || /execute exactly one step/i.test(sys)) {
      const stepMatch = last.match(/Step\s+\d+:\s*([^\n]+)/i);
      const stepText = stepMatch ? stepMatch[1].trim() : last;
      return JSON.stringify({ type: 'final', result: `[offline] ${stepText}`, toolsUsed: [] });
    }

    return JSON.stringify({ result: `[offline] ${last}`, toolsUsed: [] });
  }
  return `[offline] ${last}`;
}

// ── Public factory ─────────────────────────────────────────────────────────────

/**
 * Create an `llmCall` function bound to a chosen provider.
 *
 * @param {object} [overrides] - { provider?, model?, apiKey?, baseURL? }
 *                               Any field not set falls back to config/default.json.
 * @returns {{ call: Function, provider: string }}
 *   call:    (messages, opts) => Promise<string>
 *   provider: the *resolved* provider name ('offline' if no key, etc.)
 *
 * Behavior:
 *   • If no provider is configured AND no key is set, returns the offline stub
 *     (so the system runs without network access).
 *   • If a provider is named but no API key is available, falls back to the
 *     offline stub and reports the requested provider name (so users know
 *     what they need to configure).
 *   • If the active provider errors, retriable errors are retried (4x, expo backoff).
 *   • Non-retriable errors bubble up; the caller (kernel) saves them as mistakes.
 */
function createLlmCall(overrides = {}) {
  const requested = overrides.provider
    || process.env.QFORGE_PROVIDER
    || config.llm?.provider
    || null;

  // Explicit 'offline' or no provider → offline stub
  if (!requested || requested === 'offline') {
    log.info('llm: using offline stub', { requested: requested || 'none' });
    return {
      provider: 'offline',
      call: async (messages, opts = {}) => offlineStub(messages, opts),
    };
  }

  if (!PROVIDERS[requested]) {
    throw new Error(`Unknown LLM provider: ${requested}. Valid: ${Object.keys(PROVIDERS).join(', ')}, offline`);
  }

  // For non-ollama providers, an API key is required. If missing, fall back
  // to the offline stub but report the *requested* provider so the user
  // sees they need to set the env var.
  const apiKey = overrides.apiKey || resolveApiKey(requested);
  if (requested !== 'ollama' && !apiKey) {
    log.warn('llm: provider requested but no API key set, falling back to offline stub', {
      provider: requested,
      envVar: { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' }[requested],
    });
    return {
      provider: 'offline',
      call: async (messages, opts = {}) => offlineStub(messages, opts),
    };
  }

  const providerConfig = {
    ...(config.llm?.[requested] || {}),
    ...overrides,
    apiKey,
  };

  // Ollama: just needs the baseURL; no key.
  if (requested === 'ollama' && !providerConfig.baseURL) {
    providerConfig.baseURL = config.llm?.ollama?.baseURL || 'http://localhost:11434';
  }

  // Build client (or skip for Ollama)
  const { make, call } = PROVIDERS[requested];
  const client = make ? make(providerConfig) : null;

  log.info('llm: provider ready', { provider: requested, model: providerConfig.model });

  return {
    provider: requested,
    call: async function llmCall(messages, opts = {}) {
      return withRetry(
        () => call(client, messages, opts, providerConfig),
        isRetriable,
        { maxAttempts: 4, onRetry: (err, n, d) => log.warn('llm: retry', { provider: requested, attempt: n, delayMs: d, err: err.message }) }
      );
    },
  };
}

/** List all available providers (for /api/providers introspection). */
function listProviders() {
  return Object.keys(PROVIDERS).map((name) => ({
    name,
    configured: name === 'ollama' ? true : !!resolveApiKey(name),
    model: config.llm?.[name]?.model || null,
  }));
}

module.exports = { createLlmCall, listProviders, offlineStub };
