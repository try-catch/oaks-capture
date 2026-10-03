import fs from "node:fs/promises";
import path from "node:path";
import { roundSpinType } from "./protocol";
import { MongoClient } from "mongodb";
import { readRegistry } from "../catalog-sync";
import { MONGO_COLLECTION, MONGO_URI } from "../config";
import { requiredFeatures } from "./capture-checkpoint";
import { numberOption, selectGames, stringOption } from "./cli";
import { ensureMongoIndexes, sourceRoundHash, syncMongoRounds } from "./mongo-store";
import { declaredModeTypes, modeQuotaFromCounts } from "./mode-target";
import { ndjsonLines } from "./ndjson-lines";

export function mongoURI(target: string): string {
  if (target === "local") return process.env.OAKS_LOCAL_MONGO_URI ?? MONGO_URI;
  if (target === "test") {
    const uri = process.env.OAKS_TEST_MONGO_URI;
    if (!uri) throw new Error("--target test 必须通过 OAKS_TEST_MONGO_URI 提供受控连接串");
    return uri;
  }
  throw new Error(`不支持的 MongoDB 目标：${target}`);
}

async function readNDJSON(file: string): Promise<Record<string, unknown>[]> {
  return (await fs.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as Record<string, unknown>; }
    catch (error) { throw new Error(`${file}:${index + 1} JSON 非法: ${(error as Error).message}`); }
  });
}

export async function importMongo(args: string[]): Promise<Array<Record<string, unknown>>> {
  const registry = await readRegistry();
  const games = selectGames(args, registry);
  const target = stringOption(args, "--target", "local");
  const client = new MongoClient(mongoURI(target));
  const result: Array<Record<string, unknown>> = [];
  await client.connect();
  try {
    for (const game of games) {
      const file = path.join(__dirname, "..", "output", game.slug, `${game.slug}.ndjson`);
      const documents = await readNDJSON(file);
      const collection = client.db(game.dbName).collection(MONGO_COLLECTION);
      await ensureMongoIndexes(collection);
      const normalized = documents.map(source => {
        const document: Record<string, unknown> = { ...source, gameId: game.gameId, game: game.slug };
        document.sourceRoundHash = sourceRoundHash(document as { gameId?: number; game?: string; data: unknown });
        return document;
      });
      await syncMongoRounds(collection, normalized);
      result.push({ gameId: game.gameId, slug: game.slug, dbName: game.dbName, sourceCount: documents.length, mongoCount: await collection.countDocuments() });
      console.log(`[mongo import] ${game.slug} source=${documents.length}`);
    }
  } finally { await client.close(); }
  return result;
}

export async function auditMongo(args: string[]): Promise<Array<Record<string, unknown>>> {
  const registry = await readRegistry();
  const games = selectGames(args, registry);
  const target = stringOption(args, "--target", "local");
  const minimum = numberOption(args, "--target-per-feature", 10);
  const normalRounds = numberOption(args, "--normal-rounds", 0);
  const targetPerMode = numberOption(args, "--target-per-mode", 0);
  const modeQuotaEnabled = normalRounds > 0 || targetPerMode > 0;
  const client = new MongoClient(mongoURI(target));
  const result: Array<Record<string, unknown>> = [];
  await client.connect();
  try {
    for (const game of games) {
      const collection = client.db(game.dbName).collection(MONGO_COLLECTION);
      const indexes = await collection.indexes();
      const uniqueHash = indexes.some((index) => index.unique === true && index.key.sourceRoundHash === 1 && Object.keys(index.key).length === 1);
      const inventoryPath = path.join(__dirname, "..", "output", game.slug, "feature-inventory.json");
      const inventory = JSON.parse(await fs.readFile(inventoryPath, "utf8")) as { required?: string[] };
      const featureCounts = Object.fromEntries(await Promise.all(requiredFeatures(inventory.required ?? [], modeQuotaEnabled)
        .map(async (feature) => [feature, await collection.countDocuments({ features: feature })])));
      const missing = Object.entries(featureCounts).filter(([, count]) => Number(count) < minimum).map(([feature]) => feature);
      const sourceHashes = new Set<string>();
      const sourceModeCounts: Record<number, number> = Object.fromEntries(declaredModeTypes(game).map(type => [type, 0]));
      let sourceCount = 0;
      const sourceFile = path.join(__dirname, "..", "output", game.slug, `${game.slug}.ndjson`);
      for await (const line of ndjsonLines(sourceFile)) {
        let document: Record<string, any>;
        try { document = JSON.parse(line); }
        catch (error) { throw new Error(`${sourceFile}:${sourceCount + 1} JSON 非法: ${(error as Error).message}`); }
        sourceCount++;
        sourceHashes.add(String(document.sourceRoundHash));
        if (document.testOnly !== true && Array.isArray(document.data)) {
          const type = roundSpinType(document.data, Number(document.buy ?? 0));
          if (type in sourceModeCounts) sourceModeCounts[type]++;
        }
      }
      const hashes = new Set<string>();
      const modeCounts: Record<number, number> = Object.fromEntries(declaredModeTypes(game).map(type => [type, 0]));
      let contentValid = true;
      let normalWin = 0;
      let normalLoss = 0;
      let total = 0;
      for await (const doc of collection.find({})) {
        total++;
        const hash = String(doc.sourceRoundHash);
        hashes.add(hash);
        try {
          if (typeof doc.sourceRoundHash !== "string" ||
              doc.sourceRoundHash !== sourceRoundHash(doc as unknown as { gameId?: number; game?: string; data: unknown })) contentValid = false;
        } catch { contentValid = false; }
        if (doc.testOnly !== true && Array.isArray(doc.data)) {
          const type = roundSpinType(doc.data, Number(doc.buy ?? 0));
          if (type in modeCounts) modeCounts[type]++;
          if (type === 0 && Number(doc.mul) > 0) normalWin++;
          if (type === 0 && Number(doc.mul) === 0) normalLoss++;
        }
      }
      const countsMatch = sourceCount === total && hashes.size === total &&
        sourceHashes.size === sourceCount && [...sourceHashes].every(hash => hashes.has(hash));
      const modeQuota = modeQuotaFromCounts(game, modeCounts, normalRounds, targetPerMode);
      const valid = uniqueHash && countsMatch && contentValid && missing.length === 0 && modeQuota.missing.length === 0 && normalWin > 0 && normalLoss > 0;
      const report = { brand: "3 OAKS", target, gameId: game.gameId, slug: game.slug, dbName: game.dbName, total,
        sourceCount, countsMatch, contentValid, uniqueHash, normalWin, normalLoss, featureCounts, missing,
        modeCounts: modeQuota.counts, sourceModeCounts, modeTargets: modeQuota.targets, modeMissing: modeQuota.missing, valid };
      const reportPath = path.join(__dirname, "..", "output", game.slug, `mongo-audit-${target}.json`);
      const temporary = `${reportPath}.part-${process.pid}`;
      await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
      await fs.rename(temporary, reportPath);
      result.push(report);
      console.log(`[mongo audit] ${game.slug} total=${total} valid=${valid}`);
    }
  } finally { await client.close(); }
  if (result.some((item) => !item.valid)) throw new Error("MongoDB 验收未通过，详情见逐游戏输出");
  return result;
}
