import fs from "fs";
import { runPipeline } from "./pipeline.js";
import { corpusBleu, corpusChrf } from "./bleuchrf.js";

async function main() {
  const testSetPath = process.argv[2] || "./test_sentences.json";
  const testSet = JSON.parse(fs.readFileSync(testSetPath, "utf-8"));

  console.log(`Running ${testSet.length} test sentences...\n`);

  const results = [];
  for (let i = 0; i < testSet.length; i++) {
    const c = testSet[i];
    console.log(`[${i + 1}/${testSet.length}] ${c.source.slice(0, 50)}...`);
    const out = await runPipeline(c.source, c.target_lang, c.context || "");
    out.reference = c.reference || "";
    out.direction = c.direction || "";
    results.push(out);
  }

  const withRef = results.filter((r) => r.reference);
  const bleu = withRef.length ? corpusBleu(withRef.map((r) => r.translation), withRef.map((r) => r.reference)) : "N/A";
  const chrf = withRef.length ? corpusChrf(withRef.map((r) => r.translation), withRef.map((r) => r.reference)) : "N/A";

  const avgTokens = results.reduce((s, r) => s + r.tokensUsed, 0) / results.length;
  const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / results.length;
  const flagged = results.filter((r) => !r.safetyPassed).length;
  const safetyPassRate = (100 * (results.length - flagged)) / results.length;

  const report = {
    numSentences: results.length,
    avgTokensPerTranslation: Math.round(avgTokens),
    totalTokensUsed: results.reduce((s, r) => s + r.tokensUsed, 0),
    avgLatencyMs: Math.round(avgLatency),
    bleuScore: bleu,
    chrfScore: chrf,
    safetyFlaggedCount: flagged,
    safetyPassRatePercent: Math.round(safetyPassRate * 10) / 10,
    results,
  };

  console.log("\n" + "=".repeat(50));
  console.log("EVALUATION SUMMARY");
  console.log("=".repeat(50));
  console.log(`Sentences tested:       ${report.numSentences}`);
  console.log(`Avg tokens/translation: ${report.avgTokensPerTranslation}`);
  console.log(`Total tokens used:      ${report.totalTokensUsed}`);
  console.log(`Avg latency (ms):       ${report.avgLatencyMs}`);
  console.log(`BLEU score:             ${report.bleuScore}`);
  console.log(`chrF score:             ${report.chrfScore}`);
  console.log(`Safety flagged:         ${report.safetyFlaggedCount}/${report.numSentences}`);
  console.log(`Safety pass rate:       ${report.safetyPassRatePercent}%`);
  console.log("=".repeat(50));

  for (const r of results) {
    const flag = r.safetyPassed ? "✅ OK" : "⚠️ FLAGGED";
    console.log(`\n[${flag}] (${r.direction}) "${r.input}"`);
    console.log(`   -> ${r.translation}`);
    if (r.reference) console.log(`   (reference: ${r.reference})`);
    r.safetyIssues.forEach((i) => console.log(`   ! ${i}`));
  }

  fs.mkdirSync("./logs", { recursive: true });
  fs.writeFileSync("./logs/evaluation_report.json", JSON.stringify(report, null, 2));
  console.log(`\nFull report saved to: ./logs/evaluation_report.json`);
}

main();