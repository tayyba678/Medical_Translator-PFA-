import fs from "fs";

const USAGE_FILE = "./logs/groq_keys_usage.json";
const KEYS_FILE = "./groq_keys.json";

function loadKeys() {
  // Primary source: groq_keys.json file
  let keys = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8"));
    keys = (parsed.keys || []).filter(Boolean);
  } catch (e) {
    console.warn(`[groqKeyManager] Could not read ${KEYS_FILE}: ${e.message}`);
  }

  // Fallback / extra: still honor env vars if someone sets them too,
  // without duplicating a key that's already in the file.
  const envKeys = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3]
    .filter(Boolean)
    .filter((k) => !keys.includes(k));

  return [...keys, ...envKeys];
}

function loadUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8"));
  } catch {
    return { currentIndex: 0, keys: {} };
  }
}

function saveUsage(usage) {
  fs.mkdirSync("./logs", { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
}

const KEYS = loadKeys();

export function totalKeysAvailable() {
  return KEYS.length;
}

export function getActiveKeyIndex() {
  const usage = loadUsage();
  if (usage.currentIndex >= KEYS.length) usage.currentIndex = 0;
  return usage.currentIndex;
}

export function getActiveKey() {
  if (KEYS.length === 0) {
    throw new Error(
      `No Groq API keys found. Add them to ${KEYS_FILE} (see groq_keys.example.json for the format).`
    );
  }
  return KEYS[getActiveKeyIndex()];
}

export function recordSuccess(index, tokens) {
  const usage = loadUsage();
  if (!usage.keys[index]) usage.keys[index] = { totalTokens: 0, failures: 0 };
  usage.keys[index].totalTokens += tokens;
  usage.keys[index].lastUsed = new Date().toISOString();
  saveUsage(usage);
}

export function recordFailureAndRotate(index) {
  const usage = loadUsage();
  if (!usage.keys[index]) usage.keys[index] = { totalTokens: 0, failures: 0 };
  usage.keys[index].failures += 1;
  usage.keys[index].lastFailure = new Date().toISOString();
  usage.currentIndex = (index + 1) % KEYS.length;
  saveUsage(usage);
  return usage.currentIndex;
}