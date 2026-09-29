import fs from "fs";
import crypto from "crypto";

const DIR = "./logs";
const FILE = `${DIR}/history.jsonl`;
const FEEDBACK_FILE = `${DIR}/feedback.jsonl`;
const MAX_IN_MEMORY = 500; // only the newest records stay in memory; older ones stay in the file
const LATENCY_BUCKETS = [250, 500, 1000, 2000, 4000, 8000, 16000]; // ms

fs.mkdirSync(DIR, { recursive: true });

const records = new Map();
const lastRating = new Map(); // translationId -> "up" | "down"

// Running totals. Updated once per finished request, so metrics never rescan the records.
const agg = {
  total: 0,
  ok: 0,
  errors: 0,
  tokens: 0,
  latencyMs: 0,
  groqCalls: 0,
  gatePassed: 0,
  refined: 0,
  up: 0,
  down: 0,
  byHour: {},
  steps: {}, // step -> { count, tokens, latencyMs }
  buckets: new Array(LATENCY_BUCKETS.length + 1).fill(0),
  recent: [], // last 30 requests, for the dashboard charts
  latWindow: [], // last 200 latencies, for p50 / p95
};

const stripEmpty = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

function addToAgg(r) {
  const latency = r.latencyMs || 0;
  const steps = r.steps || [];

  agg.total++;
  if (r.status === "error") agg.errors++;
  else agg.ok++;

  agg.tokens += r.tokensUsed || 0;
  agg.latencyMs += latency;
  agg.groqCalls += r.groqCalls || 0;
  if (r.safetyPassed) agg.gatePassed++;
  if (steps.some((s) => s.step === "refinement")) agg.refined++;

  for (const s of steps) {
    const a = (agg.steps[s.step] = agg.steps[s.step] || { count: 0, tokens: 0, latencyMs: 0 });
    a.count++;
    a.tokens += s.tokensUsed || 0;
    a.latencyMs += s.latencyMs || 0;
  }

  const hour = new Date(r.startedAt).getHours();
  agg.byHour[hour] = (agg.byHour[hour] || 0) + 1;

  const b = LATENCY_BUCKETS.findIndex((limit) => latency <= limit);
  agg.buckets[b === -1 ? LATENCY_BUCKETS.length : b]++;

  agg.recent.push({ t: r.startedAt, latency, tokens: r.tokensUsed || 0 });
  if (agg.recent.length > 30) agg.recent.shift();
  agg.latWindow.push(latency);
  if (agg.latWindow.length > 200) agg.latWindow.shift();
}

// ---------- Load existing history ----------
// Reads both the old pretty-printed blocks and the new one-record-per-line format.
function readRecords(contents) {
  const out = [];
  for (const block of contents.split(/\r?\n\s*\r?\n/).filter(Boolean)) {
    try {
      out.push(JSON.parse(block));
    } catch {
      for (const line of block.split(/\r?\n/).filter(Boolean)) {
        try {
          out.push(JSON.parse(line));
        } catch {}
      }
    }
  }
  return out;
}

if (fs.existsSync(FILE)) {
  const all = readRecords(fs.readFileSync(FILE, "utf-8"));
  for (const r of all) if (r.finishedAt) addToAgg(r);
  for (const r of all.slice(-MAX_IN_MEMORY)) records.set(r.id, r);
}

if (fs.existsSync(FEEDBACK_FILE)) {
  const merged = new Map();
  for (const line of fs.readFileSync(FEEDBACK_FILE, "utf-8").split(/\r?\n/).filter(Boolean)) {
    try {
      const { id, at, ...fb } = JSON.parse(line);
      merged.set(id, { ...(merged.get(id) || {}), ...stripEmpty(fb) });
    } catch {}
  }
  for (const [id, fb] of merged) {
    if (fb.rating === "up" || fb.rating === "down") {
      lastRating.set(id, fb.rating);
      agg[fb.rating]++;
    }
    const r = records.get(id);
    if (r) r.feedback = fb;
  }
}

// ---------- Async writers (do not block requests) ----------
const historyStream = fs.createWriteStream(FILE, { flags: "a" });
const feedbackStream = fs.createWriteStream(FEEDBACK_FILE, { flags: "a" });
historyStream.on("error", (e) => console.error("[history] write error:", e.message));
feedbackStream.on("error", (e) => console.error("[feedback] write error:", e.message));

export function flushHistory() {
  const end = (s) => new Promise((resolve) => s.end(resolve));
  return Promise.all([end(historyStream), end(feedbackStream)]);
}

function trim() {
  while (records.size > MAX_IN_MEMORY) records.delete(records.keys().next().value);
}

// ---------- API used by the pipeline and server ----------
export function createHistory(input) {
  const id = crypto.randomUUID();
  records.set(id, { id, input, startedAt: new Date().toISOString(), steps: [] });
  trim();
  return id;
}

export function logStep(id, step, data) {
  const r = records.get(id);
  if (r) r.steps.push({ step, at: new Date().toISOString(), ...data });
}

// Safe to call more than once: only the first call counts.
// summary.status: "ok" (default) | "error" | "disabled"
export function finishHistory(id, summary = {}) {
  const r = records.get(id);
  if (!r || r.finishedAt) return;

  Object.assign(r, { status: "ok" }, summary, { finishedAt: new Date().toISOString() });
  addToAgg(r);
  historyStream.write(JSON.stringify(r) + "\n");
}

export const getHistory = (id) => records.get(id);

export const listHistory = (limit = 50) =>
  [...records.values()].filter((r) => r.finishedAt).slice(-limit).reverse();

// Returns false if the id is unknown to this process (e.g. older than the in-memory window).
export function setFeedback(id, feedback) {
  const clean = stripEmpty(feedback || {});
  const r = records.get(id);

  if (clean.rating === "up" || clean.rating === "down") {
    const prev = lastRating.get(id);
    if (prev) agg[prev]--;
    agg[clean.rating]++;
    lastRating.set(id, clean.rating);
  }

  if (r) r.feedback = { ...(r.feedback || {}), ...clean };

  feedbackStream.write(JSON.stringify({ id, ...clean, at: new Date().toISOString() }) + "\n");
  return !!r;
}

// ---------- Metrics ----------
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export function computeMetrics() {
  const n = agg.total || 1;
  const okN = agg.ok || 1;
  const rated = agg.up + agg.down;

  const steps = {};
  for (const [name, a] of Object.entries(agg.steps)) {
    steps[name] = {
      count: a.count,
      avgTokens: Math.round(a.tokens / a.count),
      avgLatencyMs: Math.round(a.latencyMs / a.count),
      totalTokens: a.tokens,
    };
  }

  return {
    total: agg.total,
    errors: agg.errors,
    errorRate: +((100 * agg.errors) / n).toFixed(1),
    avgLatencyMs: Math.round(agg.latencyMs / n),
    p50LatencyMs: percentile(agg.latWindow, 0.5),
    p95LatencyMs: percentile(agg.latWindow, 0.95),
    avgTokens: Math.round(agg.tokens / n),
    totalTokens: agg.tokens,
    avgGroqCalls: +(agg.groqCalls / n).toFixed(2),
    safetyPassRate: +((100 * agg.gatePassed) / okN).toFixed(1),
    refinementRate: +((100 * agg.refined) / okN).toFixed(1),
    approvalRate: rated ? +((100 * agg.up) / rated).toFixed(1) : null,
    byHour: agg.byHour,
    steps,
    recent: agg.recent,
  };
}

// Prometheus text format, scraped by Grafana / Prometheus at /metrics
export function prometheusText() {
  const L = [];
  const metric = (name, type, help, samples) =>
    L.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);

  metric("translator_requests_total", "counter", "Finished requests by status", [
    `translator_requests_total{status="ok"} ${agg.ok}`,
    `translator_requests_total{status="error"} ${agg.errors}`,
  ]);
  metric("translator_tokens_total", "counter", "Total tokens used", [
    `translator_tokens_total ${agg.tokens}`,
  ]);
  metric("translator_request_llm_calls_total", "counter", "Model calls made for requests", [
    `translator_request_llm_calls_total ${agg.groqCalls}`,
  ]);
  metric("translator_gate_passed_total", "counter", "Requests that passed the quality gate", [
    `translator_gate_passed_total ${agg.gatePassed}`,
  ]);
  metric("translator_refinements_total", "counter", "Requests that needed a refine call", [
    `translator_refinements_total ${agg.refined}`,
  ]);
  metric("translator_feedback_total", "counter", "Thumbs feedback", [
    `translator_feedback_total{rating="up"} ${agg.up}`,
    `translator_feedback_total{rating="down"} ${agg.down}`,
  ]);

  let cumulative = 0;
  const hist = LATENCY_BUCKETS.map((le, i) => {
    cumulative += agg.buckets[i];
    return `translator_request_latency_ms_bucket{le="${le}"} ${cumulative}`;
  });
  cumulative += agg.buckets[LATENCY_BUCKETS.length];
  hist.push(
    `translator_request_latency_ms_bucket{le="+Inf"} ${cumulative}`,
    `translator_request_latency_ms_sum ${agg.latencyMs}`,
    `translator_request_latency_ms_count ${agg.total}`
  );
  metric("translator_request_latency_ms", "histogram", "End-to-end request latency", hist);

  const names = Object.keys(agg.steps);
  metric("translator_step_runs_total", "counter", "Runs per pipeline step",
    names.map((s) => `translator_step_runs_total{step="${s}"} ${agg.steps[s].count}`));
  metric("translator_step_tokens_total", "counter", "Tokens per pipeline step",
    names.map((s) => `translator_step_tokens_total{step="${s}"} ${agg.steps[s].tokens}`));
  metric("translator_step_latency_ms_total", "counter", "Summed latency per pipeline step",
    names.map((s) => `translator_step_latency_ms_total{step="${s}"} ${agg.steps[s].latencyMs}`));

  return L.join("\n") + "\n";
}