import { callGroq } from "./groqClient.js";

const MAX_TERMS = 30;

export async function extractMedicalTerms(text, glossaryMatches = []) {
  // English words hi nahi to call ki zaroorat nahi
  if (!/[A-Za-z]{4,}/.test(text)) {
    return { terms: [], tokensUsed: 0, called: false };
  }

  const prompt = `List medical, scientific or technical terms in the text that must stay in English when translated to Urdu: drugs, chemicals, lab tests, abbreviations, isotopes, anatomy, diseases, biochemical terms. Exclude common words and Urdu words. Copy each term exactly as written. Output ONLY a JSON array of strings.

TEXT:
${text}`;

  try {
    const res = await callGroq(
      [
        { role: "system", content: "Output only a JSON array." },
        { role: "user", content: prompt },
      ],
      150
    );

    const raw = res.choices[0].message.content
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/```json|```/g, "")
      .trim();

    const parsed = JSON.parse(raw);
    const lowerSource = text.toLowerCase();

    // glossary mein jin terms ka Urdu tarjuma tay hai, unhe preserve na karo
    const translateThese = new Set(
      glossaryMatches
        .filter((m) => !m.keepEnglish)
        .map((m) => (m.en || "").toLowerCase())
    );

    const seen = new Set();
    const terms = [];

    for (const t of Array.isArray(parsed) ? parsed : []) {
      if (typeof t !== "string") continue;
      const term = t.trim();
      const key = term.toLowerCase();

      if (!term || seen.has(key)) continue;
      if (!lowerSource.includes(key)) continue; // hallucinated term
      if (translateThese.has(key)) continue;

      seen.add(key);
      terms.push(term);
      if (terms.length >= MAX_TERMS) break;
    }

    return { terms, tokensUsed: res.usage?.total_tokens || 0, called: true };
  } catch (err) {
    if (err.message === "GROQ_DISABLED") throw err;
    return { terms: [], tokensUsed: 0, called: true }; // extractor fail ho to pipeline na ruke
  }
}