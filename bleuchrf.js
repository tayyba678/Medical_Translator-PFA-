function tokenize(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

function ngrams(tokens, n) {
  const counts = new Map();
  for (let i = 0; i <= tokens.length - n; i++) {
    const gram = tokens.slice(i, i + n).join(" ");
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

export function corpusBleu(hypotheses, references) {
  let matchCounts = [0, 0, 0, 0];
  let totalCounts = [0, 0, 0, 0];
  let hypLenTotal = 0, refLenTotal = 0;

  for (let i = 0; i < hypotheses.length; i++) {
    const hypTokens = tokenize(hypotheses[i]);
    const refTokens = tokenize(references[i]);
    hypLenTotal += hypTokens.length;
    refLenTotal += refTokens.length;

    for (let n = 1; n <= 4; n++) {
      const hypGrams = ngrams(hypTokens, n);
      const refGrams = ngrams(refTokens, n);
      let match = 0, total = 0;
      for (const [gram, count] of hypGrams) {
        total += count;
        match += Math.min(count, refGrams.get(gram) || 0);
      }
      matchCounts[n - 1] += match;
      totalCounts[n - 1] += total;
    }
  }

  const precisions = matchCounts.map((m, i) => (totalCounts[i] === 0 ? 0 : m / totalCounts[i]));
  const logSum = precisions.reduce((sum, p) => sum + (p > 0 ? Math.log(p) : -1e9), 0);
  const geoMean = Math.exp(logSum / 4);
  const bp = hypLenTotal >= refLenTotal ? 1 : Math.exp(1 - refLenTotal / (hypLenTotal || 1));
  const bleu = bp * geoMean * 100;

  return Number.isFinite(bleu) ? Math.round(bleu * 100) / 100 : 0;
}

function charNgrams(text, n) {
  const chars = text.replace(/\s+/g, " ").trim();
  const counts = new Map();
  for (let i = 0; i <= chars.length - n; i++) {
    const gram = chars.slice(i, i + n);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

export function corpusChrf(hypotheses, references, maxN = 6, beta = 2) {
  let precisionSum = 0, recallSum = 0, count = 0;

  for (let i = 0; i < hypotheses.length; i++) {
    let matchTotal = 0, hypTotal = 0, refTotal = 0;
    for (let n = 1; n <= maxN; n++) {
      const hypGrams = charNgrams(hypotheses[i], n);
      const refGrams = charNgrams(references[i], n);
      let match = 0, hSum = 0, rSum = 0;
      for (const [gram, c] of hypGrams) { hSum += c; match += Math.min(c, refGrams.get(gram) || 0); }
      for (const c of refGrams.values()) rSum += c;
      matchTotal += match; hypTotal += hSum; refTotal += rSum;
    }
    precisionSum += hypTotal === 0 ? 0 : matchTotal / hypTotal;
    recallSum += refTotal === 0 ? 0 : matchTotal / refTotal;
    count++;
  }

  const avgP = precisionSum / count, avgR = recallSum / count;
  if (avgP + avgR === 0) return 0;
  const f = ((1 + beta * beta) * avgP * avgR) / (beta * beta * avgP + avgR);
  return Math.round(f * 100 * 100) / 100;
}