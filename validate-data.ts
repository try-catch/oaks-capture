import fs from "node:fs/promises";
import path from "node:path";
import { readRegistry } from "./catalog-sync";
import { selectGames } from "./src/cli";
import { classifyRound } from "./src/features";
import { featureTarget } from "./src/capture-checkpoint";
import { sourceRoundHash } from "./src/mongo-store";
import { roundSpinType } from "./src/protocol";
import { validateGameRound } from "./src/validators";
import { auditModeQuota } from "./src/mode-target";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1]) : fallback;
}

async function main(): Promise<void> {
  const game = selectGames(process.argv.slice(2), await readRegistry())[0];
  const capturedSource = path.join("output", game.slug, `${game.slug}.ndjson`);
  const seedSource = path.join("seed-data", `${game.slug}.ndjson`);
  const defaultSource = await fs.stat(path.resolve(__dirname, capturedSource)).then(() => capturedSource).catch(() => seedSource);
  const source = path.resolve(__dirname, arg("--file", defaultSource));
  const defaultReport = defaultSource === capturedSource
    ? path.join("output", game.slug, "validation-report.json")
    : path.join("seed-data", `${game.slug}-feature-report.json`);
  const reportPath = path.resolve(__dirname, arg("--report", defaultReport));
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const lines = (await fs.readFile(source, "utf8")).split(/\r?\n/).filter(Boolean);
  const coverage: Record<string, number> = {};
  const examples: Record<string, number[]> = {};
  const errors: string[] = [];
  const hashes = new Set<string>();
  let duplicates = 0;
  let sensitiveDocuments = 0;
  let totalBet = 0;
  let totalWin = 0;
  let randomPoolBet = 0;
  let randomPoolWin = 0;
  let testOnlyDocuments = 0;

  lines.forEach((line, index) => {
    try {
      const document = JSON.parse(line);
      if (/"(?:authorization|cookie|huid|queue|request_id|session_id|token)"\s*:/i.test(line)) {
        sensitiveDocuments++;
        throw new Error("包含禁止落盘的会话或敏感字段");
      }
      const hash = sourceRoundHash(document);
      if (document.sourceRoundHash && document.sourceRoundHash !== hash) throw new Error("sourceRoundHash 与协议内容不一致");
      if (hashes.has(hash)) {
        duplicates++;
        throw new Error(`重复 sourceRoundHash: ${hash}`);
      }
      hashes.add(hash);
      const bet = Number(document.bet);
      const spinType = roundSpinType(document.data, Number(document.buy ?? 0));
      const validation = validateGameRound(game, document.data, bet);
      const expectedMul = validation.win / bet;
      if (Math.abs(Number(document.mul) - expectedMul) > 1e-9) {
        throw new Error(`mul=${document.mul}，协议应为 ${expectedMul}`);
      }
      totalBet += bet;
      totalWin += validation.win;
      if (document.testOnly === true || !Array.isArray(document.rtp) || document.rtp.length === 0) {
        testOnlyDocuments++;
      } else if (spinType === 0) {
        randomPoolBet += bet;
        randomPoolWin += validation.win;
      }
      const features = new Set(validation.features);
      for (const evidence of classifyRound(document.data)) features.add(evidence.name);
      for (const feature of features) {
        if (spinType !== 0 && ["base-loss", "base-or-feature-win"].includes(feature)) continue;
        coverage[feature] = (coverage[feature] ?? 0) + 1;
        (examples[feature] ??= []).push(index + 1);
        examples[feature] = examples[feature].slice(0, 10);
      }
    } catch (error) {
      errors.push(`第 ${index + 1} 行：${(error as Error).message}`);
    }
  });

  const inventoryPath = path.join(__dirname, "output", game.slug, "feature-inventory.json");
  const inventory = await fs.readFile(inventoryPath, "utf8").then((content) => JSON.parse(content)).catch(() => undefined);
  const requestedRequired = arg("--require", "").split(",").map((value) => value.trim()).filter(Boolean);
  const required = [...new Set(["base-loss", "base-or-feature-win", ...(requestedRequired.length ? requestedRequired : (inventory?.required ?? []))])].sort();
  const targetPerFeature = Number(arg("--target-per-feature", "1"));
  const missing = required.filter((feature) => (coverage[feature] ?? 0) < featureTarget(feature, targetPerFeature));
  const normalRounds = Number(arg("--normal-rounds", "0"));
  const targetPerMode = Number(arg("--target-per-mode", "0"));
  const modeQuota = auditModeQuota(game, lines.map((line) => {
    try { return JSON.parse(line); } catch { return {}; }
  }), normalRounds, targetPerMode);
  const report = {
    brand: "3 OAKS",
    game: game.slug,
    source,
    generatedAt: new Date().toISOString(),
    documents: lines.length,
    valid: lines.length - errors.length,
    invalid: errors.length,
    duplicates,
    sensitiveDocuments,
    uniqueRoundHashes: hashes.size,
    totalBet,
    totalWin,
    observedRtpPercent: totalBet ? Number((totalWin / totalBet * 100).toFixed(4)) : 0,
    randomPoolDocuments: lines.filter((line) => {
      try {
        const document = JSON.parse(line);
        return document.testOnly !== true && Array.isArray(document.rtp) && document.rtp.length > 0
          && roundSpinType(document.data, Number(document.buy ?? 0)) === 0;
      } catch {
        return false;
      }
    }).length,
    testOnlyDocuments,
    randomPoolRtpPercent: randomPoolBet ? Number((randomPoolWin / randomPoolBet * 100).toFixed(4)) : 0,
    coverage,
    examples,
    required,
    targetPerFeature,
    missing,
    modeCounts: modeQuota.counts,
    modeTargets: modeQuota.targets,
    modeMissing: modeQuota.missing,
    errors: errors.slice(0, 100),
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (errors.length || missing.length || modeQuota.missing.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
