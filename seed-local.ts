import fs from "node:fs/promises";
import path from "node:path";
import { MongoClient } from "mongodb";
import { MONGO_COLLECTION, MONGO_DB, MONGO_URI, RTP_BUCKETS } from "./config";
import { classify, DIRECTED_TEST_FEATURES, validateRound } from "./src/protocol";
import crypto from "node:crypto";

function seedID(document: any): string {
  return crypto.createHash("sha256").update(JSON.stringify(document.data)).digest("hex");
}

function normalize(document: any): any {
  const validation = validateRound(document.data, Number(document.bet));
  const expectedMul = validation.win / Number(document.bet);
  const testOnly = DIRECTED_TEST_FEATURES.some((feature) => validation.features.includes(feature));
  if (!Number.isFinite(expectedMul)) throw new Error("mul 无法计算");
  return {
    ...document,
    mul: expectedMul,
    branches: classify(document.data),
    features: classify(document.data),
    captureVersion: 2,
    settlementField: "context.current.total_win",
    validation: { valid: true, cumulativeWins: validation.cumulativeWins },
    testOnly,
    rtp: testOnly ? [] : (Array.isArray(document.rtp) && document.rtp.length > 0 ? document.rtp : RTP_BUCKETS),
  };
}

async function main(): Promise<void> {
  const source = path.resolve(__dirname, "seed-data/sun_of_egypt.ndjson");
  const lines = (await fs.readFile(source, "utf8")).split(/\r?\n/).filter(Boolean);
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const collection = client.db(MONGO_DB).collection(MONGO_COLLECTION);
    let inserted = 0;
    let updated = 0;
    for (const line of lines) {
      const normalized = normalize(JSON.parse(line));
      const id = seedID(normalized);
      const document = { ...normalized, seedId: id };
      const result = await collection.updateOne({ seedId: id }, { $set: document }, { upsert: true });
      if (result.upsertedCount) inserted++;
      else updated++;
    }
    await collection.createIndex({ seedId: 1 }, { unique: true, sparse: true });
    await collection.createIndex({ bonus: 1, buy: 1, mul: 1 });
    console.log(`校验并导入完成：新增 ${inserted}，更新 ${updated}，总计 ${lines.length}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
