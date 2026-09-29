import fs from "fs";

const romanMap = JSON.parse(
  fs.readFileSync(
    "./data/roman_urdu_normalize.json",
    "utf-8"
  )
);

const URDU_SCRIPT_RE =
  /[\u0600-\u06FF]/;

const UR_SIGNAL_WORDS = new Set([
  "hai",
  "hain",
  "ka",
  "ki",
  "ke",
  "ko",
  "mein",
  "me",
  "se",
  "ne",
  "nahi",
  "nahin",
  "nahiin",
  "raha",
  "rahi",
  "rahe",
  "ho",
  "aur",
  "aap",
  "ap",
  "mera",
  "meri",
  "mere",
  "hamara",
  "hamari",
  "kya",
  "kyun",
  "kyu",
  "tha",
  "thi",
  "the",
  "ye",
  "woh",
  "is",
  "us",
  "ko",
  "par",
  "liye",
  "karna",
  "karni",
  "karne",
  "chahiye",
  "sakta",
  "sakti",
  "sakte",
]);

const AMBIGUOUS_ROMAN_WORDS =
  new Set([
    "ha",
    "hay",
    "he",
  ]);

function getLatinWords(text) {
  return (
    text
      .toLowerCase()
      .match(/[a-z]+/g) || []
  );
}

export function detectLanguage(text) {
  const hasUrduScript =
    URDU_SCRIPT_RE.test(text);

  const words =
    getLatinWords(text);

  // --------------------------------------------
  // ONLY URDU SCRIPT
  // --------------------------------------------
  if (words.length === 0) {
    return hasUrduScript
      ? "urdu"
      : "english";
  }

  // --------------------------------------------
  // ROMAN URDU SIGNALS
  // --------------------------------------------
  const romanHits =
    words.filter(
      (word) =>
        romanMap[word] &&
        !AMBIGUOUS_ROMAN_WORDS.has(word)
    ).length;

  const signalHits =
    words.filter(
      (word) =>
        UR_SIGNAL_WORDS.has(word)
    ).length;

  const validWords =
    words.filter(
      (word) =>
        !AMBIGUOUS_ROMAN_WORDS.has(word)
    ).length;

  const romanRatio =
    validWords > 0
      ? romanHits / validWords
      : 0;

  // --------------------------------------------
  // ROMAN URDU DETECTION
  // --------------------------------------------
  const looksLikeRomanUrdu =
    signalHits >= 2 ||
    romanRatio >= 0.20 ||
    (romanHits >= 1 &&
      words.length <= 3);

  // --------------------------------------------
  // MIXED URDU SCRIPT + ROMAN URDU
  // --------------------------------------------
  if (
    hasUrduScript &&
    looksLikeRomanUrdu
  ) {
    return "roman_urdu";
  }

  // --------------------------------------------
  // URDU SCRIPT
  // --------------------------------------------
  if (hasUrduScript) {
    return "urdu";
  }

  // --------------------------------------------
  // ROMAN URDU
  // --------------------------------------------
  if (looksLikeRomanUrdu) {
    return "roman_urdu";
  }

  // --------------------------------------------
  // OTHERWISE ENGLISH
  // --------------------------------------------
  return "english";
}

export function normalizeRomanUrdu(text) {
  return text.replace(
    /[\p{L}\p{M}]+/gu,
    (word) =>
      romanMap[
        word.toLowerCase()
      ] || word
  );
}

export function preprocess(text) {
  const detectedLanguage =
    detectLanguage(text);

  /*
   * IMPORTANT:
   *
   * Do not replace the original input
   * with dictionary-normalized Roman Urdu.
   *
   * The translation model needs the
   * complete original context, including:
   *
   * - medical terminology
   * - abbreviations
   * - English words
   * - Roman Urdu
   * - Urdu script
   *
   * normalizeRomanUrdu() remains available
   * as a utility, but is not used as the
   * translation input.
   */

  return {
    original: text,

    detectedLanguage,

    normalizedText: text,
  };
}