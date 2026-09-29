import fs from "fs";

const GLOSSARY_PATH = "./data/glossary.json"; // curated: terms WITH a chosen Urdu translation
const KEEP_PATH = "./data/keep_english.txt"; // big list: one English term per line, no Urdu needed
const CATEGORIES = ["drug_names", "symptoms", "body_parts", "dosage_timing_words"];
const MAX_NGRAM = 5; // longest term (in words) we look for, e.g. "acute respiratory distress syndrome"

const glossary = JSON.parse(fs.readFileSync(GLOSSARY_PATH, "utf-8"));

// A "word" = letters/digits, with inner hyphens/apostrophes kept (X-ray, COVID-19, Crohn's)
const WORD_RE = /[\p{L}\p{N}]+(?:[-'\u2019][\p{L}\p{N}]+)*/gu;

const tokens = (text) => text.match(WORD_RE) || [];
const keyOfText = (s) => tokens(s).join(" ").toLowerCase();

let translateIndex; // key -> { en, ur, category, keepEnglish }
let keepIndex; // key -> canonical English term

function build() {
  translateIndex = new Map();
  keepIndex = new Map();

  // 1) Curated entries (English, Urdu and Roman Urdu forms all point to the same entry)
  for (const category of CATEGORIES) {
    for (const entry of glossary[category] || []) {
      const item = {
        en: entry.en,
        ur: entry.ur,
        category,
        keepEnglish: entry.keepEnglish ?? category === "drug_names",
      };
      const forms = [entry.en, entry.ur, ...(entry.roman_ur_variants || [])];
      for (const form of forms) {
        const key = form ? keyOfText(form) : "";
        if (key && !translateIndex.has(key)) translateIndex.set(key, item);
      }
      if (item.keepEnglish) keepIndex.set(keyOfText(entry.en), entry.en);
    }
  }

  // 2) Keep-English terms: small list inside glossary.json + the big text file
  const extra = [...(glossary.keep_english_terms || [])];
  if (fs.existsSync(KEEP_PATH)) {
    for (const line of fs.readFileSync(KEEP_PATH, "utf-8").split(/\r?\n/)) {
      const term = line.trim();
      if (term && !term.startsWith("#")) extra.push(term);
    }
  }
  for (const term of extra) {
    const key = keyOfText(term);
    if (!key) continue;
    const curated = translateIndex.get(key);
    if (curated && !curated.keepEnglish) continue; // a curated Urdu translation always wins
    keepIndex.set(key, term);
  }
}

build();

// Longest-match scan: cost depends on the length of the input, not on the size of the glossary
function scan(text, index) {
  const words = tokens(text).map((w) => w.toLowerCase());
  const hits = [];
  let i = 0;

  while (i < words.length) {
    let used = 0;
    for (let n = Math.min(MAX_NGRAM, words.length - i); n >= 1; n--) {
      const key = words.slice(i, i + n).join(" ");
      if (index.has(key)) {
        hits.push(index.get(key));
        used = n;
        break;
      }
    }
    i += used || 1;
  }

  return hits;
}

export function findMatches(text) {
  const seen = new Set();
  const matches = [];

  for (const item of scan(text, translateIndex)) {
    const id = `${item.category}|${item.en}`;
    if (!seen.has(id)) {
      seen.add(id);
      matches.push(item);
    }
  }

  return matches;
}

export function findEnglishTermsToPreserve(text) {
  const fromList = scan(text, keepIndex);
  const fromMatches = findMatches(text)
    .filter((m) => m.keepEnglish)
    .map((m) => m.en);

  return [...new Set([...fromList, ...fromMatches])];
}

export function addGlossaryEntry(category, entry) {
  const list = (glossary[category] = glossary[category] || []);
  const i = list.findIndex((e) => (e.en || "").toLowerCase() === entry.en.toLowerCase());

  if (i >= 0) list[i] = { ...list[i], ...entry };
  else list.push(entry);

  fs.writeFileSync(GLOSSARY_PATH, JSON.stringify(glossary, null, 2));

  if (entry.keepEnglish && !keepIndex.has(keyOfText(entry.en))) {
    fs.appendFileSync(KEEP_PATH, `\n${entry.en}`);
  }

  build(); // edits are rare, so a full rebuild is fine
}

export function glossaryStats() {
  return { translateTerms: translateIndex.size, keepEnglishTerms: keepIndex.size };
}