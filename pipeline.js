import { preprocess } from "./normalize.js";
import { findMatches, findEnglishTermsToPreserve } from "./glossary.js";
import { qualityGate } from "./verifier.js";
import {
  groqTranslate,
  groqTransliterateToUrduScript,
  groqRefine,
} from "./groqTranslate.js";
import { extractMedicalTerms } from "./termExtractor.js";
import { logStep, finishHistory } from "./historyLogger.js";

// Only this many matched terms go into the prompt (keeps long research text cheap).
const MAX_PRESERVE_TERMS = 40;

export async function runPipeline(rawText, targetLang, context = "", options = {}) {
  const start = Date.now();
  const translationId = options.translationId;
  const toUrdu = targetLang.toLowerCase() === "urdu";

  // ---------- PREPROCESS ----------
  const preStart = Date.now();
  const pre = preprocess(rawText);
  const sourceText = pre.original;

  logStep(translationId, "preprocess", {
    status: "success",
    detectedLanguage: pre.detectedLanguage,
    normalizedInput: pre.normalizedText,
    latencyMs: Date.now() - preStart,
  });

  // ---------- GLOSSARY ----------
  const glossaryStart = Date.now();
  const glossaryMatches = findMatches(sourceText);
  const englishTermsToPreserve = findEnglishTermsToPreserve(sourceText).slice(
    0,
    MAX_PRESERVE_TERMS
  );

  logStep(translationId, "glossary", {
    status: "success",
    matches: glossaryMatches,
    termsToPreserve: englishTermsToPreserve,
    latencyMs: Date.now() - glossaryStart,
  });

  const sourceLangLabel =
    pre.detectedLanguage === "urdu"
      ? "Urdu"
      : pre.detectedLanguage === "roman_urdu"
        ? "Roman Urdu"
        : "English";

  let finalText = "";
  let tokensUsed = 0;
  let groqCalls = 0;
  let gate = { passed: true, issues: [] };
  let urduPreview = "";
  let groqDisabled = false;

  // ---------- URDU PREVIEW (starts now, runs in parallel with the translation) ----------
  // The preview only needs the source text, so it does not have to wait for anything else.
  let previewJob = null;
  if (options.generateUrduPreview === true && pre.detectedLanguage === "roman_urdu") {
    const previewStart = Date.now();
    groqCalls++;
    previewJob = groqTransliterateToUrduScript(sourceText).then(
      (text) => ({ text, latencyMs: Date.now() - previewStart }),
      (error) => ({ error, latencyMs: Date.now() - previewStart })
    );
  }

  try {
    // ---------- TERM EXTRACTION (optional, off by default) ----------
    if (toUrdu && options.useExtractor === true) {
      const extractStart = Date.now();
      const extracted = await extractMedicalTerms(sourceText, glossaryMatches);

      if (extracted.called) groqCalls++;
      tokensUsed += extracted.tokensUsed;

      // glossary + AI terms, duplicates removed
      const seen = new Set(englishTermsToPreserve.map((t) => t.toLowerCase()));
      for (const t of extracted.terms) {
        if (!seen.has(t.toLowerCase())) {
          seen.add(t.toLowerCase());
          englishTermsToPreserve.push(t);
        }
      }

      logStep(translationId, "term_extraction", {
        status: "success",
        called: extracted.called,
        terms: extracted.terms,
        tokensUsed: extracted.tokensUsed,
        latencyMs: Date.now() - extractStart,
      });
    }

    // ---------- MAIN TRANSLATION ----------
    const modelStart = Date.now();

    const first = await groqTranslate(
      sourceText,
      sourceLangLabel,
      targetLang,
      glossaryMatches,
      context,
      englishTermsToPreserve
    );

    finalText = first.text;
    tokensUsed += first.tokensUsed;
    groqCalls++;

    logStep(translationId, "translation_model", {
      status: "success",
      output: first.text,
      tokensUsed: first.tokensUsed,
      latencyMs: Date.now() - modelStart,
    });

    // ---------- QUALITY CHECK ----------
    const verifyStart = Date.now();
    gate = qualityGate(sourceText, finalText, englishTermsToPreserve);

    logStep(translationId, "verification", {
      status: gate.passed ? "passed" : "failed",
      passed: gate.passed,
      issues: gate.issues,
      latencyMs: Date.now() - verifyStart,
    });

    // ---------- REFINE ----------
    if (!gate.passed) {
      const refineStart = Date.now();

      const refined = await groqRefine(
        sourceText,
        finalText,
        targetLang,
        glossaryMatches,
        gate.issues,
        context,
        englishTermsToPreserve
      );

      finalText = refined.text;
      tokensUsed += refined.tokensUsed;
      groqCalls++;

      logStep(translationId, "refinement", {
        status: "success",
        output: refined.text,
        tokensUsed: refined.tokensUsed,
        latencyMs: Date.now() - refineStart,
        reason: gate.issues,
      });

      const reverifyStart = Date.now();
      gate = qualityGate(sourceText, finalText, englishTermsToPreserve);

      logStep(translationId, "verification_after_refinement", {
        status: gate.passed ? "passed" : "failed",
        passed: gate.passed,
        issues: gate.issues,
        latencyMs: Date.now() - reverifyStart,
      });
    }

    // ---------- URDU PREVIEW (collect the result) ----------
    if (previewJob) {
      const preview = await previewJob;

      if (preview.error) {
        // The preview is optional, so a failure here must not fail the translation.
        logStep(translationId, "urdu_preview", {
          status: "failed",
          error: preview.error.message,
          latencyMs: preview.latencyMs,
        });
      } else {
        urduPreview = preview.text;
        logStep(translationId, "urdu_preview", {
          status: "success",
          output: urduPreview,
          latencyMs: preview.latencyMs,
        });
      }
    } else if (pre.detectedLanguage === "urdu") {
      urduPreview = sourceText;

      logStep(translationId, "urdu_preview", {
        status: "success",
        output: urduPreview,
        source: "original_input",
      });
    }
  } catch (err) {
    if (err.message === "GROQ_DISABLED") {
      groqDisabled = true;
      finalText = "[Translation paused -- set GROQ_ENABLED = true in config.js]";

      logStep(translationId, "translation_error", {
        status: "groq_disabled",
        error: err.message,
      });
    } else {
      logStep(translationId, "translation_error", {
        status: "failed",
        error: err.message,
      });

      // Failed requests must show up in history and telemetry too.
      finishHistory(translationId, {
        status: "error",
        error: err.message,
        translation: "",
        safetyPassed: false,
        safetyIssues: [err.message],
        needsReview: true,
        tokensUsed,
        groqCalls,
        latencyMs: Date.now() - start,
      });

      throw err;
    }
  }

  // ---------- HISTORY ----------
  const totalLatency = Date.now() - start;
  const needsReview = !gate.passed; // still failing after refinement -> human review queue

  finishHistory(translationId, {
    status: groqDisabled ? "disabled" : "ok",
    translation: finalText,
    safetyPassed: gate.passed,
    safetyIssues: gate.issues,
    needsReview,
    tokensUsed,
    groqCalls,
    latencyMs: totalLatency,
    groqDisabled,
  });

  // ---------- RESPONSE ----------
  return {
    input: rawText,
    detectedLanguage: pre.detectedLanguage,
    normalizedInput: sourceText,
    urduPreview,
    translation: finalText,
    targetLang,
    textDirection: toUrdu ? "rtl" : "ltr",
    groqCalls,
    tokensUsed,
    latencyMs: totalLatency,
    safetyPassed: gate.passed,
    safetyIssues: gate.issues,
    needsReview,
    groqDisabled,
  };
}