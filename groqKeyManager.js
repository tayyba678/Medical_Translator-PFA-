import fs from "fs";

const USAGE_FILE = "./logs/groq_keys_usage.json";
const KEYS_FILE = "./groq_keys.json";
const SAVE_EVERY_MS = 5000;

function loadKeys() {
  // Primary source: groq_keys.json file
  let keys = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8"));
    keys = (parsed.keys || []).filter(Boolean);
  } catch (e) {
    console.warn(`[groqKeyManager] Could not read ${KEYS_FILE}: ${e.message}`);
  }

  // Extra: env vars, without duplicating a key that's already in the file.
  const envKeys = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3]
    .filter(Boolean)
    .filter((k) => !keys.includes(k));

  return [...keys, ...envKeys];
}

function loadUsage() {
  try {
    const u = JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8"));
    u.keys = u.keys || {};
    return u;
  } catch {
    return { keys: {} };
  }
}

const KEYS = loadKeys();

// Usage lives in memory. It is loaded once at startup and written to disk
// at most every SAVE_EVERY_MS (and once more when the process exits).
const usage = loadUsage();
let dirty = false;
let saveTimer = null;

export function flushKeyUsage() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync("./logs", { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
  } catch (e) {
    console.warn(`[groqKeyManager] Could not save usage: ${e.message}`);
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushKeyUsage();
  }, SAVE_EVERY_MS);
  saveTimer.unref?.();
}

process.on("exit", flushKeyUsage);

// Cooldowns are in memory only: "keyIndex|model" -> timestamp until which the key is skipped.
// model "*" means the key is unusable for every model (e.g. invalid key).
const cooldowns = new Map();
let cursor = 0;

function isCooling(index, model, now) {
  return (
    (cooldowns.get(`${index}|${model}`) || 0) > now ||
    (cooldowns.get(`${index}|*`) || 0) > now
  );
}

export function totalKeysAvailable() {
  return KEYS.length;
}

// Round-robin over keys that are not cooling down for this model and were not already tried.
// Returns { index, key } or null when nothing is usable.
export function acquireKey(model, exclude = new Set()) {
  const now = Date.now();

  for (let i = 0; i < KEYS.length; i++) {
    const index = (cursor + i) % KEYS.length;
    if (exclude.has(index) || isCooling(index, model, now)) continue;

    cursor = (index + 1) % KEYS.length;
    return { index, key: KEYS[index] };
  }

  return null;
}

function slot(index) {
  if (!usage.keys[index]) usage.keys[index] = { totalTokens: 0, failures: 0 };
  return usage.keys[index];
}

export function recordSuccess(index, tokens) {
  const u = slot(index);
  u.totalTokens += tokens || 0;
  u.lastUsed = new Date().toISOString();
  scheduleSave();
}

export function recordFailure(index, { model = "*", cooldownMs = 0 } = {}) {
  const u = slot(index);
  u.failures += 1;
  u.lastFailure = new Date().toISOString();
  if (cooldownMs > 0) cooldowns.set(`${index}|${model}`, Date.now() + cooldownMs);
  scheduleSave();
}

export function keyStats() {
  return KEYS.map((_, index) => ({
    index,
    totalTokens: usage.keys[index]?.totalTokens || 0,
    failures: usage.keys[index]?.failures || 0,
  }));
}