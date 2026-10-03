import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readRegistry } from "./catalog-sync";
import { buildDataManifest, FinalizeDocument, MongoAuditSummary, ValidationSummary } from "./src/data-finalizer";
import { numberOption, selectGames, stringOption } from "./src/cli";
import { declaredModeTypes } from "./src/mode-target";
import { ndjsonLines } from "./src/ndjson-lines";

async function readJSON<T>(filename: string): Promise<T> {
  return JSON.parse(await fs.readFile(filename, "utf8")) as T;
}

async function atomicJSON(filename: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.part-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filename);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const games = selectGames(args, await readRegistry());
  const target = numberOption(args, "--target-per-feature", 10);
  const normalRounds = numberOption(args, "--normal-rounds", 0);
  const targetPerMode = numberOption(args, "--target-per-mode", 0);
  const manifests: Record<string, unknown>[] = [];
  for (const game of games) {
    const root = path.join(__dirname, "output", game.slug);
    const source = path.join(root, `${game.slug}.ndjson`);
    const digest = crypto.createHash("sha256");
    for await (const chunk of createReadStream(source)) digest.update(chunk);
    const documents: FinalizeDocument[] = [];
    let lineNumber = 0;
    for await (const line of ndjsonLines(source)) {
      lineNumber++;
      try { documents.push(JSON.parse(line) as FinalizeDocument); }
      catch (error) { throw new Error(`${source}:${lineNumber} JSON 非法: ${(error as Error).message}`); }
    }
    const validation = await readJSON<ValidationSummary>(path.join(root, "validation-report.json"));
    const mongoAudit = await readJSON<MongoAuditSummary>(path.join(root, `mongo-audit-${stringOption(args, "--target", "test")}.json`));
    const modeTargets = Object.fromEntries(declaredModeTypes(game).map(type => [type, type === 0 ? normalRounds : targetPerMode]));
    const manifest = buildDataManifest(game, documents, validation, digest.digest("hex"), target, mongoAudit, modeTargets);
    await atomicJSON(path.join(root, "data-manifest.json"), { ...manifest, generatedAt: new Date().toISOString() });
    manifests.push(manifest);
    console.log(`[finalize ${manifests.length}/${games.length}] ${game.slug} documents=${documents.length}`);
  }
  if (args.includes("--all")) {
    const report = { brand: "3 OAKS", generatedAt: new Date().toISOString(), total: manifests.length, archiveSha256: null, games: manifests };
    const serialized = JSON.stringify(report);
    if (/(?:authorization|cookie|huid|queue|request_id|session_id|token)/i.test(serialized)) throw new Error("总清单包含禁止字段");
    await atomicJSON(path.join(__dirname, "reports", "final-data-manifest.json"), report);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
