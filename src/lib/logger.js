/**
 * Structured JSON logger.
 * Single-line JSON output for parseability; respects LOG_LEVEL env var.
 * Never logs secrets, tokens, or arbitrary message content (callers should
 * redact PII before passing in).
 */

'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const ACTIVE = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 2;

function emit(level, msg, fields) {
  if (LEVELS[level] > ACTIVE) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields || {}),
  };
  // Use stderr for warn/error, stdout for info/debug
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(entry) + '\n');
}

module.exports = {
  error: (msg, fields) => emit('error', msg, fields),
  warn:  (msg, fields) => emit('warn',  msg, fields),
  info:  (msg, fields) => emit('info',  msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),
};
