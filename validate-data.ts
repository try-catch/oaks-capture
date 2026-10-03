import fs from "node:fs/promises";
import path from "node:path";
import { readRegistry } from "./catalog-sync";
import { selectGames } from "./src/cli";
import { classifyRound } from "./src/features";
import { featureTarget, requiredFeatures } from "./src/capture-checkpoint";
import { sourceRoundHash } from "./src/mongo-store";
import { roundSpinType } from "./src/protocol";
import { validateGameRound } from "./src/validators";
import { declaredModeTypes, modeQuotaFromCounts } from "./src/mode-target";
import { ndjsonLines } from "./src/ndjson-lines";

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
  let documents = 0;
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
  let randomPoolDocuments = 0;
  let testOnlyDocuments = 0;
  const modeCounts: Record<number, number> = Object.fromEntries(declaredModeTypes(game).map((type) => [type, 0]));

  for await (const line of ndjsonLines(source)) {
    documents++;
    try {
      const document = JSON.parse(line);
      const spinType = Array.isArray(document.data) ? roundSpinType(document.data, Number(document.buy ?? 0)) : undefined;
      if (document.testOnly !== true && spinType !== undefined && spinType in modeCounts) modeCounts[spinType]++;
      if (document.testOnly !== true && Array.isArray(document.rtp) && document.rtp.length > 0 && spinType === 0) {
        randomPoolDocuments++;
      }
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
      const validatedSpinType = spinType ?? roundSpinType(document.data, Number(document.buy ?? 0));
      const validation = validateGameRound(game, document.data, bet);
      const expectedMul = validation.win / bet;
      if (Math.abs(Number(document.mul) - expectedMul) > 1e-9) {
        throw new Error(`mul=${document.mul}，协议应为 ${expectedMul}`);
      }
      totalBet += bet;
      totalWin += validation.win;
      if (document.testOnly === true || !Array.isArray(document.rtp) || document.rtp.length === 0) {
        testOnlyDocuments++;
      } else if (validatedSpinType === 0) {
        randomPoolBet += bet;
        randomPoolWin += validation.win;
      }
      const features = new Set(validation.features);
      for (const evidence of classifyRound(document.data)) features.add(evidence.name);
      for (const feature of features) {
        if (spinType !== 0 && ["base-loss", "base-or-feature-win"].includes(feature)) continue;
        coverage[feature] = (coverage[feature] ?? 0) + 1;
        (examples[feature] ??= []).push(documents);
        examples[feature] = examples[feature].slice(0, 10);
      }
    } catch (error) {
      errors.push(`第 ${documents} 行：${(error as Error).message}`);
    }
  }

  const inventoryPath = path.join(__dirname, "output", game.slug, "feature-inventory.json");
  const inventory = await fs.readFile(inventoryPath, "utf8").then((content) => JSON.parse(content)).catch(() => undefined);
  const requestedRequired = arg("--require", "").split(",").map((value) => value.trim()).filter(Boolean);
  const normalRounds = Number(arg("--normal-rounds", "0"));
  const targetPerMode = Number(arg("--target-per-mode", "0"));
  const modeQuotaEnabled = normalRounds > 0 || targetPerMode > 0;
  const required = requiredFeatures(requestedRequired.length ? requestedRequired : (inventory?.required ?? []),
    modeQuotaEnabled && requestedRequired.length === 0);
  const targetPerFeature = Number(arg("--target-per-feature", "1"));
  const missing = required.filter((feature) => (coverage[feature] ?? 0) < featureTarget(feature, targetPerFeature));
  const modeQuota = modeQuotaFromCounts(game, modeCounts, normalRounds, targetPerMode);
  const report = {
    brand: "3 OAKS",
    game: game.slug,
    source,
    generatedAt: new Date().toISOString(),
    documents,
    valid: documents - errors.length,
    invalid: errors.length,
    duplicates,
    sensitiveDocuments,
    uniqueRoundHashes: hashes.size,
    totalBet,
    totalWin,
    observedRtpPercent: totalBet ? Number((totalWin / totalBet * 100).toFixed(4)) : 0,
    randomPoolDocuments,
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
