// Simple pause switch. Set to true once you have your API key(s) ready
// and want to actually call Groq again.
export const GROQ_ENABLED = true;

// How often (ms) the frontend checks if the text changed and needs
// re-translating. Increase this to save tokens/cost further.
export const CHECK_INTERVAL_MS = 60000; // 60 seconds

// Models tried in order. If the first is rate-limited on every key, times out,
// or is unavailable, the next one is used. Check these IDs are enabled in your
// Groq console and edit the list if not.
export const MODEL_CHAIN = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
];

// One request to Groq must finish within this time, otherwise it counts as a failure.
export const REQUEST_TIMEOUT_MS = 20000;

// Hard limit for one callGroq() including all retries and fallbacks.
export const TOTAL_DEADLINE_MS = 45000;