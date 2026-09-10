import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readRegistry } from "./catalog-sync";
import { buildDataManifest, FinalizeDocument, MongoAuditSummary, ValidationSummary } from "./src/data-finalizer";
import { numberOption, selectGames, stringOption } from "./src/cli";

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
  const manifests: Record<string, unknown>[] = [];
  for (const game of games) {
    const root = path.join(__dirname, "output", game.slug);
    const source = path.join(root, `${game.slug}.ndjson`);
    const bytes = await fs.readFile(source);
    const documents = bytes.toString("utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as FinalizeDocument);
    const validation = await readJSON<ValidationSummary>(path.join(root, "validation-report.json"));
    const mongoAudit = await readJSON<MongoAuditSummary>(path.join(root, `mongo-audit-${stringOption(args, "--target", "test")}.json`));
    const manifest = buildDataManifest(game, documents, validation, crypto.createHash("sha256").update(bytes).digest("hex"), target, mongoAudit);
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
