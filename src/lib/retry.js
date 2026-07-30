/**
 * Exponential-backoff retry with jitter.
 * Used by the LLM provider abstraction to survive transient failures
 * (rate limits, network blips, 502/503 from upstream providers).
 *
 * Only retries on errors marked as retriable by the caller.
 */

'use strict';

const DEFAULT_OPTS = {
  maxAttempts: 4,
  baseMs: 250,
  maxMs: 8000,
  factor: 2,
  jitter: 0.25,        // ±25% randomization to avoid thundering herd
  onRetry: null,       // (err, attempt, delayMs) => void
};

/** Sleep helper. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` with retry. `isRetriable(err)` decides whether to retry.
 * Throws the last error if all attempts fail.
 */
async function withRetry(fn, isRetriable, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  let attempt = 0;
  let lastErr;
  while (attempt < o.maxAttempts) {
    attempt++;
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= o.maxAttempts) break;
      if (typeof isRetriable === 'function' && !isRetriable(err)) break;
      const expo = Math.min(o.maxMs, o.baseMs * Math.pow(o.factor, attempt - 1));
      const jitter = expo * o.jitter * (Math.random() * 2 - 1);
      const delay = Math.max(0, Math.floor(expo + jitter));
      if (typeof o.onRetry === 'function') {
        try { o.onRetry(err, attempt, delay); } catch { /* never throw from hook */ }
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, sleep };
