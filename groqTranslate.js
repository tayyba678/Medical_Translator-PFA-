import { callGroq } from "./groqClient.js";

function cleanOutput(text) {
  text = (text || "").trim();

  if (text.includes("<think>") && text.includes("</think>")) {
    text = text.split("</think>").pop().trim();
  }

  if (text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1);
  }

  return text;
}

function buildGlossaryLines(glossaryMatches, targetLang) {
  if (!glossaryMatches.length) return "";

  const toUrdu = targetLang.toLowerCase() === "urdu";

  const lines = glossaryMatches.map((m) => {
    if (toUrdu) {
      return m.keepEnglish
        ? `"${m.en}" -> keep "${m.en}" in English`
        : `"${m.en}" -> "${m.ur}"`;
    }
    return `"${m.ur}" -> "${m.en}"`;
  });

  return `\nMANDATORY TERMS:\n${lines.join("\n")}\n`;
}

function buildTargetRule(targetLang, preserveTerms = []) {
  if (targetLang.toLowerCase() === "urdu") {
    const list = preserveTerms.length
      ? `\nALWAYS KEEP IN ENGLISH: ${preserveTerms.join("; ")}`
      : "";

    return `
OUTPUT: natural Pakistani Urdu in Urdu script, but keep medical terms in English (Latin script) when Urdu speakers normally say them in English: drug names, disease/condition names, tests, procedures, devices, abbreviations. Translate everyday words (fever, cough, pain, stomach, etc.) into Urdu. Rule: if a Pakistani patient would say the English word inside an Urdu sentence, keep it English. Never use Roman Urdu.
Example: "Take paracetamol for fever and check your blood pressure." -> "بخار کے لیے paracetamol لیں اور اپنا blood pressure چیک کریں۔"${list}
`;
  }

  return `
OUTPUT: natural English only. No Urdu, Roman Urdu or explanations.
`;
}

function buildContext(context) {
  return context ? `\nCONTEXT: ${context}\n` : "";
}

export async function groqTranslate(
  text,
  sourceLang,
  targetLang,
  glossaryMatches,
  context,
  preserveTerms = []
) {
  const prompt = `Medical translation from ${sourceLang} to ${targetLang}. Translate only: no advice, explanation or additions.
Keep exact meaning: actions, who does what to whom, body parts, symptoms, numbers, dosage, timing, frequency, negation. Add nothing, omit nothing. Translate idioms by meaning, not word by word.
Roman Urdu is Urdu in Latin letters: read it as Urdu, not English. Input may mix Urdu script, Roman Urdu and English.
${buildTargetRule(targetLang, preserveTerms)}${buildGlossaryLines(glossaryMatches, targetLang)}${buildContext(context)}
Return ONLY the translation.

SOURCE:
${text}`;

  const response = await callGroq(
    [
      { role: "system", content: "You are a precise medical translation engine." },
      { role: "user", content: prompt },
    ],
    700
  );

  return {
    text: cleanOutput(response.choices[0].message.content),
    tokensUsed: response.usage?.total_tokens || 0,
  };
}

export async function groqTransliterateToUrduScript(text) {
  const prompt = `Transliterate this Roman Urdu into Urdu script. Do not translate, paraphrase, add or remove anything. Return only Urdu-script text.

${text}`;

  const response = await callGroq(
    [
      { role: "system", content: "You are a precise Roman Urdu to Urdu-script transliteration system." },
      { role: "user", content: prompt },
    ],
    400
  );

  return cleanOutput(response.choices[0].message.content);
}

export async function groqRefine(
  sourceText,
  draftText,
  targetLang,
  glossaryMatches,
  issues,
  context,
  preserveTerms = []
) {
  const prompt = `Fix this medical translation. Do not rewrite creatively; make it match the source exactly.

SOURCE:
${sourceText}

DRAFT:
${draftText}

PROBLEMS:
${issues.join("; ")}

Fix every problem. Keep meaning, actions, body parts, numbers, dosage, timing, frequency and negation. Add nothing, omit nothing.
${buildTargetRule(targetLang, preserveTerms)}${buildGlossaryLines(glossaryMatches, targetLang)}${buildContext(context)}
Return ONLY the corrected translation into ${targetLang}.`;

  const response = await callGroq(
    [
      { role: "system", content: "You are a precise medical translation correction engine." },
      { role: "user", content: prompt },
    ],
    600
  );

  return {
    text: cleanOutput(response.choices[0].message.content),
    tokensUsed: response.usage?.total_tokens || 0,
  };
}