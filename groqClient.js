import Groq from "groq-sdk";
import {
  GROQ_ENABLED,
  MODEL_CHAIN,
  REQUEST_TIMEOUT_MS,
  TOTAL_DEADLINE_MS,
} from "./config.js";
import {
  totalKeysAvailable,
  acquireKey,
  recordSuccess,
  recordFailure,
} from "./groqKeyManager.js";

// gpt-oss counts hidden reasoning tokens inside max_tokens, so give it headroom.
// max_tokens is only a cap, so unused headroom costs nothing.
const REASONING_HEADROOM = 300;
const MAX_BUDGET = 2400;
const MODEL_DEAD_MS = 10 * 60 * 1000;

const stats = { calls: {}, fallbacks: 0, rateLimits: 0, truncations: 0, errors: 0 };
export const clientStats = () => ({ ...stats, calls: { ...stats.calls } });

const clients = new Map();
function clientFor(index, key) {
  if (!clients.has(index)) {
    clients.set(index, new Groq({ apiKey: key, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS }));
  }
  return clients.get(index);
}

const deadModels = new Map(); // model -> timestamp until which we skip it
const isGptOss = (model) => model.startsWith("openai/gpt-oss");

function buildBody(model, messages, maxTokens) {
  const body = { model, messages, temperature: 0.1, max_tokens: maxTokens };
  if (isGptOss(model)) {
    body.reasoning_effort = "low";
    body.include_reasoning = false;
  }
  return body;
}

// rate_limit: wait / use another key   auth: key is bad   model_gone: skip model
// fatal: our request is wrong, retrying elsewhere will not help   transient: timeout, 5xx, network
function classify(err) {
  const s = err?.status;
  if (s === 429) return "rate_limit";
  if (s === 401 || s === 403) return "auth";
  if (s === 404 || err?.code === "model_decommissioned") return "model_gone";
  if (s && s >= 400 && s < 500) return "fatal";
  return "transient";
}

function retryAfterMs(err) {
  const h = err?.headers;
  const raw = typeof h?.get === "function" ? h.get("retry-after") : h?.["retry-after"];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 120000) : 0;
}

export async function callGroq(messages, maxTokens = 180) {
  if (!GROQ_ENABLED) {
    throw new Error("GROQ_DISABLED");
  }
  if (totalKeysAvailable() === 0) {
    throw new Error("No Groq API keys available.");
  }

  const started = Date.now();
  let lastError = null;
  let attempts = 0;
  let wastedTokens = 0; // tokens spent on attempts we threw away (cut-off outputs)

  for (let pos = 0; pos < MODEL_CHAIN.length; pos++) {
    const model = MODEL_CHAIN[pos];
    if ((deadModels.get(model) || 0) > Date.now()) continue;

    const tried = new Set();
    let budget = Math.min(MAX_BUDGET, maxTokens + (isGptOss(model) ? REASONING_HEADROOM : 0));
    let grew = false;

    while (true) {
      if (Date.now() - started > TOTAL_DEADLINE_MS) {
        throw lastError || new Error("Groq deadline exceeded");
      }

      const slot = acquireKey(model, tried);
      if (!slot) break; // every key is cooling down or already tried -> next model

      attempts++;

      try {
        const res = await clientFor(slot.index, slot.key).chat.completions.create(
          buildBody(model, messages, budget)
        );

        const tokens = res.usage?.total_tokens || 0;
        recordSuccess(slot.index, tokens);
        stats.calls[model] = (stats.calls[model] || 0) + 1;

        const choice = res.choices?.[0];
        const text = (choice?.message?.content || "").trim();
        const cutOff = choice?.finish_reason === "length" || !text;

        if (!cutOff) {
          if (pos > 0) stats.fallbacks++;
          res.usage = { ...(res.usage || {}), total_tokens: tokens + wastedTokens };
          res._meta = { model, keyIndex: slot.index, attempts, latencyMs: Date.now() - started };
          return res;
        }

        // Cut off (usually reasoning used up the budget). A truncated medical translation
        // must never be returned silently.
        stats.truncations++;
        wastedTokens += tokens;
        lastError = new Error(`Output cut off on ${model} (max_tokens ${budget})`);

        if (!grew && budget < MAX_BUDGET) {
          grew = true;
          budget = Math.min(MAX_BUDGET, budget * 2);
          continue; // same model again with a bigger budget
        }
        break; // still cut off -> next model
      } catch (err) {
        lastError = err;
        stats.errors++;
        const kind = classify(err);
        console.error(`[Groq ${model} key#${slot.index}] ${kind}: ${err.message}`);

        if (kind === "fatal") throw err;

        if (kind === "model_gone") {
          deadModels.set(model, Date.now() + MODEL_DEAD_MS);
          break;
        }

        tried.add(slot.index);

        if (kind === "rate_limit") {
          stats.rateLimits++;
          recordFailure(slot.index, { model, cooldownMs: retryAfterMs(err) || 20000 });
        } else if (kind === "auth") {
          recordFailure(slot.index, { model: "*", cooldownMs: 60 * 60 * 1000 });
        } else {
          recordFailure(slot.index, { model });
        }
      }
    }
  }

  throw lastError || new Error("All Groq keys and models are unavailable.");
}