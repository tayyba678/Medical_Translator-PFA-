const NEGATION_PATTERNS = [
  "not",
  "do not",
  "does not",
  "did not",
  "don't",
  "doesn't",
  "didn't",
  "never",
  "no",
  "without",
  "avoid",
  "nahi",
  "nahin",
  "mat",
  "na",
  "نہیں",
  "مت",
  "نہ",
];

const TIMING_PATTERNS = [
  "before",
  "after",
  "during",
  "morning",
  "afternoon",
  "evening",
  "night",
  "daily",
  "twice",
  "once",
  "every day",
  "every morning",
  "every night",
  "for",
  "within",
  "until",
  "pehle",
  "pehlay",
  "baad",
  "doraan",
  "roz",
  "subah",
  "shaam",
  "raat",
  "پہلے",
  "بعد",
  "دوران",
  "روز",
  "صبح",
  "شام",
  "رات",
];

const DOSAGE_UNITS = [
  "mg",
  "g",
  "mcg",
  "ml",
  "l",
  "tablet",
  "tablets",
  "capsule",
  "capsules",
  "dose",
  "doses",
  "گولی",
  "گولیاں",
  "کیپسول",
  "ملی گرام",
  "ملی لیٹر",
];

function containsWholeWord(text, term) {
  const escaped = term.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
    "iu"
  );

  return pattern.test(text);
}

function containsAnyPattern(text, patterns) {
  return patterns.some((pattern) =>
    containsWholeWord(text, pattern)
  );
}

function extractNumbers(text) {
  return [
    ...new Set(
      (text.match(/\d+(?:\.\d+)?/g) || [])
    ),
  ];
}

function extractDosages(text) {
  const dosages = [];

  const numberPattern =
    /(\d+(?:\.\d+)?)\s*(mg|g|mcg|ml|l|tablet|tablets|capsule|capsules|dose|doses|گولی|گولیاں|کیپسول|ملی\s*گرام|ملی\s*لیٹر)/giu;

  let match;

  while (
    (match = numberPattern.exec(text)) !==
    null
  ) {
    dosages.push(
      `${match[1]} ${match[2]}`
    );
  }

  return dosages;
}

function extractSignals(text) {
  return {
    numbers: extractNumbers(text),

    dosages:
      extractDosages(text),

    negation:
      containsAnyPattern(
        text,
        NEGATION_PATTERNS
      ),

    timing:
      containsAnyPattern(
        text,
        TIMING_PATTERNS
      ),
  };
}

function arraysEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  return a.every(
    (value, index) =>
      value === b[index]
  );
}

export function qualityGate(
  sourceText,
  draftText,
  englishTermsToPreserve
) {
  const issues = [];

  const source =
    extractSignals(sourceText);

  const draft =
    extractSignals(draftText);

  // --------------------------------------------
  // NUMBER PRESERVATION
  // --------------------------------------------
  if (
    !arraysEqual(
      source.numbers,
      draft.numbers
    )
  ) {
    issues.push(
      `Number mismatch: source=${source.numbers.join(", ")} draft=${draft.numbers.join(", ")}`
    );
  }

  // --------------------------------------------
  // DOSAGE PRESERVATION
  // --------------------------------------------
  if (
    source.dosages.length > 0 &&
    !arraysEqual(
      source.dosages,
      draft.dosages
    )
  ) {
    issues.push(
      `Dosage mismatch: source=${source.dosages.join(", ")} draft=${draft.dosages.join(", ")}`
    );
  }

  // --------------------------------------------
  // NEGATION PRESERVATION
  // --------------------------------------------
  if (
    source.negation !==
    draft.negation
  ) {
    issues.push(
      `Negation mismatch: source_has=${source.negation} draft_has=${draft.negation}`
    );
  }

  // --------------------------------------------
  // TIMING PRESERVATION
  // --------------------------------------------
  if (
    source.timing !==
    draft.timing
  ) {
    issues.push(
      `Timing information mismatch: source_has=${source.timing} draft_has=${draft.timing}`
    );
  }

  // --------------------------------------------
  // REQUIRED ENGLISH TERMS
  // --------------------------------------------
  for (
    const term of englishTermsToPreserve
  ) {
    if (
      !containsWholeWord(
        draftText,
        term
      )
    ) {
      issues.push(
        `Required English term "${term}" was not preserved`
      );
    }
  }

  return {
    passed:
      issues.length === 0,

    issues,
  };
}