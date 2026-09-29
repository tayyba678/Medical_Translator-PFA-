import express from "express";
import { runPipeline } from "./pipeline.js";
import {
  createHistory,
  getHistory,
  listHistory,
  setFeedback,
  computeMetrics,
  prometheusText,
  finishHistory,
  flushHistory,
} from "./historyLogger.js";
import { addGlossaryEntry, glossaryStats } from "./glossary.js";
import { clientStats } from "./groqClient.js";
import { keyStats } from "./groqKeyManager.js";

const MAX_INPUT_CHARS = 4000; // protects tokens and latency from huge pastes

const app = express();

app.use(express.json());
app.use(express.static("public"));

app.post("/translate", async (req, res) => {
  let translationId;

  try {
    const { text, targetLang, context, generateUrduPreview } = req.body;

    if (!text || !text.trim()) {
      return res.json({ translation: "", urduPreview: "" });
    }

    if (text.length > MAX_INPUT_CHARS) {
      return res
        .status(413)
        .json({ error: `Text is too long (max ${MAX_INPUT_CHARS} characters).` });
    }

    translationId = createHistory(text);

    const result = await runPipeline(text, targetLang || "Urdu", context || "", {
      generateUrduPreview: generateUrduPreview === true,
      translationId,
    });

    res.json({ ...result, translationId });
  } catch (e) {
    console.error(e);
    // The pipeline already closes the record on its own errors; this covers anything else.
    if (translationId) finishHistory(translationId, { status: "error", error: e.message });
    res.status(500).json({ error: "Translation failed", translationId });
  }
});

// ---------- History ----------
app.get("/api/history", (req, res) => res.json(listHistory()));
app.get("/api/history/:id", (req, res) => res.json(getHistory(req.params.id) || {}));

// ---------- Telemetry ----------
app.get("/api/metrics", (req, res) =>
  res.json({ ...computeMetrics(), groq: clientStats(), keys: keyStats(), glossary: glossaryStats() })
);

// Prometheus endpoint: point Prometheus / Grafana at http://localhost:3000/metrics
app.get("/metrics", (req, res) => {
  const c = clientStats();
  const g = glossaryStats();
  const L = [];

  L.push("# TYPE translator_groq_calls_total counter");
  for (const [model, n] of Object.entries(c.calls)) {
    L.push(`translator_groq_calls_total{model="${model}"} ${n}`);
  }

  L.push("# TYPE translator_groq_events_total counter");
  for (const k of ["fallbacks", "rateLimits", "truncations", "errors"]) {
    L.push(`translator_groq_events_total{event="${k}"} ${c[k]}`);
  }

  L.push("# TYPE translator_key_tokens_total counter");
  for (const k of keyStats()) {
    L.push(`translator_key_tokens_total{key="${k.index}"} ${k.totalTokens}`);
  }

  L.push(
    "# TYPE translator_glossary_terms gauge",
    `translator_glossary_terms{list="curated"} ${g.translateTerms}`,
    `translator_glossary_terms{list="keep_english"} ${g.keepEnglishTerms}`
  );

  res.type("text/plain; version=0.0.4").send(prometheusText() + L.join("\n") + "\n");
});

// ---------- Human in the loop ----------
app.post("/api/feedback", (req, res) => {
  const { translationId, rating, correctedTranslation, glossaryEntry } = req.body;

  if (!translationId) return res.status(400).json({ error: "translationId is required" });

  setFeedback(translationId, { rating, correctedTranslation, glossaryEntry });

  if (glossaryEntry?.en && glossaryEntry?.ur) {
    addGlossaryEntry(glossaryEntry.category || "symptoms", {
      en: glossaryEntry.en,
      ur: glossaryEntry.ur,
      keepEnglish: !!glossaryEntry.keepEnglish,
    });
  }

  res.json({ ok: true });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// Flush log files before exiting (Ctrl+C or a stop signal)
async function shutdown() {
  await flushHistory();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);