import fs from "node:fs/promises";
import path from "node:path";
import { roundSpinType } from "./protocol";
import { MongoClient } from "mongodb";
import { readRegistry } from "../catalog-sync";
import { MONGO_COLLECTION, MONGO_URI } from "../config";
import { numberOption, selectGames, stringOption } from "./cli";
import { ensureMongoIndexes, sourceRoundHash, upsertMongoRound } from "./mongo-store";
import { auditModeQuota } from "./mode-target";

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

function requiredFeatures(inventory: { required?: string[] }): string[] {
  return [...new Set(inventory.required ?? [])].sort();
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
      for (const source of documents) {
        const document: Record<string, unknown> = { ...source, gameId: game.gameId, game: game.slug };
        document.sourceRoundHash = sourceRoundHash(document as { gameId?: number; game?: string; data: unknown });
        await upsertMongoRound(collection, document);
      }
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
      const featureCounts = Object.fromEntries(await Promise.all(requiredFeatures(inventory).map(async (feature) => [feature, await collection.countDocuments({ features: feature })])));
      const missing = Object.entries(featureCounts).filter(([, count]) => Number(count) < minimum).map(([feature]) => feature);
      const documents = await collection.find({}).toArray();
      const source = await readNDJSON(path.join(__dirname, "..", "output", game.slug, `${game.slug}.ndjson`));
      const sourceHashes = new Set(source.map(doc => String(doc.sourceRoundHash)));
      const hashes = new Set(documents.map(doc => String(doc.sourceRoundHash)));
      const contentValid = documents.every(doc => typeof doc.sourceRoundHash === "string" &&
        doc.sourceRoundHash === sourceRoundHash(doc as unknown as { gameId?: number; game?: string; data: unknown }));
      const countsMatch = source.length === documents.length && hashes.size === documents.length &&
        sourceHashes.size === source.length && [...sourceHashes].every(hash => hashes.has(hash));
      const normal = documents.filter(doc => doc.testOnly !== true && Array.isArray(doc.data) && roundSpinType(doc.data, Number(doc.buy ?? 0)) === 0);
      const normalWin = normal.filter(doc => Number(doc.mul) > 0).length;
      const normalLoss = normal.filter(doc => Number(doc.mul) === 0).length;
      const total = documents.length;
      const modeQuota = auditModeQuota(game, documents, normalRounds, targetPerMode);
      const valid = uniqueHash && countsMatch && contentValid && missing.length === 0 && modeQuota.missing.length === 0 && normalWin > 0 && normalLoss > 0;
      const report = { brand: "3 OAKS", target, gameId: game.gameId, slug: game.slug, dbName: game.dbName, total,
        sourceCount: source.length, countsMatch, contentValid, uniqueHash, normalWin, normalLoss, featureCounts, missing,
        modeCounts: modeQuota.counts, modeTargets: modeQuota.targets, modeMissing: modeQuota.missing, valid };
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
