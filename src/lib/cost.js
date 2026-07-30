/**
 * Token-cost tracking.
 * Each provider has a per-model price (USD per 1K tokens, input + output).
 * Costs are approximations — always confirm against the provider's current
 * pricing page. Set COST_BUDGET_USD env var to enforce a per-process cap;
 * once exceeded, calls throw a BudgetExceeded error.
 *
 * Pricing data is intentionally conservative; users can override per model.
 */

'use strict';

// Prices are USD per 1,000 tokens (input, output). Update as providers change them.
const PRICES = {
  // OpenAI (https://openai.com/api/pricing)
  'gpt-4o':          { in: 0.0025,  out: 0.01   },
  'gpt-4o-mini':     { in: 0.00015, out: 0.0006 },
  'gpt-4-turbo':     { in: 0.01,    out: 0.03   },
  'o1':              { in: 0.015,   out: 0.06   },
  'o1-mini':         { in: 0.003,   out: 0.012  },
  // Anthropic
  'claude-3-5-sonnet-latest': { in: 0.003, out: 0.015 },
  'claude-3-5-haiku-latest':  { in: 0.0008, out: 0.004 },
  'claude-3-opus-latest':     { in: 0.015, out: 0.075 },
  // OpenRouter models use the same id as the underlying model, e.g.
  // "anthropic/claude-3.5-sonnet" — we strip the vendor prefix.
  // Ollama is local and free.
};

const DEFAULT_PRICE = { in: 0, out: 0 };

let spent = 0;            // running total in USD
let budget = Number(process.env.COST_BUDGET_USD) || Infinity;

function normalizeModel(model) {
  if (!model) return model;
  // OpenRouter: "anthropic/claude-3.5-sonnet" → "claude-3-5-sonnet-latest"-ish
  // Best effort: drop the vendor prefix and try both forms.
  if (model.includes('/')) {
    const tail = model.split('/').pop();
    return tail.replace('claude-3-5-sonnet', 'claude-3-5-sonnet-latest')
               .replace('claude-3-5-haiku',  'claude-3-5-haiku-latest')
               .replace('claude-3-opus',     'claude-3-opus-latest');
  }
  return model;
}

function priceFor(model) {
  return PRICES[model] || PRICES[normalizeModel(model)] || DEFAULT_PRICE;
}

/**
 * Record a call's usage and return the estimated USD cost.
 * Throws if the running total would exceed COST_BUDGET_USD.
 */
function record({ provider, model, promptTokens = 0, completionTokens = 0 }) {
  const p = priceFor(model);
  const cost = (promptTokens / 1000) * p.in + (completionTokens / 1000) * p.out;
  spent += cost;
  if (spent > budget) {
    const err = new Error(
      `LLM cost budget exceeded: spent $${spent.toFixed(4)} > budget $${budget}. ` +
      `Set COST_BUDGET_USD higher or call cost.reset().`
    );
    err.code = 'BUDGET_EXCEEDED';
    throw err;
  }
  return cost;
}

function reset() { spent = 0; }
function total() { return spent; }
function setBudget(usd) { budget = Number(usd) || Infinity; }
function getBudget() { return budget; }

module.exports = { record, reset, total, setBudget, getBudget, priceFor, PRICES };
