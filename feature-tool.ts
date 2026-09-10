import { MongoClient } from "mongodb";
import { MONGO_COLLECTION, MONGO_DB, MONGO_URI } from "./config";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const requested = option("--feature");
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const collection = client.db(MONGO_DB).collection(MONGO_COLLECTION);
    const features = requested ? [requested] : await collection.distinct("features");
    const result: Record<string, {
      count: number;
      examples: string[];
      cases: Array<{
        id: string;
        seedId?: string;
        bet: number;
        expectedWin: number;
        mul: number;
        frames: number;
        testOnly: boolean;
        capturedAt?: string;
      }>;
    }> = {};
    for (const feature of features.sort()) {
      const query = { features: feature, "validation.valid": true };
      const [count, examples] = await Promise.all([
        collection.countDocuments(query),
        collection.find(query, {
          projection: {
            _id: 1, seedId: 1, bet: 1, mul: 1, data: 1,
            testOnly: 1, capturedAt: 1, "validation.cumulativeWins": 1,
          },
        }).limit(10).toArray(),
      ]);
      const cases = examples.map((item) => {
        const wins = Array.isArray(item.validation?.cumulativeWins)
          ? item.validation.cumulativeWins.map(Number).filter(Number.isFinite)
          : [];
        return {
          id: String(item._id),
          ...(item.seedId ? { seedId: String(item.seedId) } : {}),
          bet: Number(item.bet ?? 0),
          expectedWin: wins.length > 0 ? wins[wins.length - 1] : Number(item.bet ?? 0) * Number(item.mul ?? 0),
          mul: Number(item.mul ?? 0),
          frames: Array.isArray(item.data) ? item.data.length : 0,
          testOnly: item.testOnly === true,
          ...(item.capturedAt ? { capturedAt: String(item.capturedAt) } : {}),
        };
      });
      result[feature] = { count, examples: cases.map((item) => item.id), cases };
    }
    console.log(JSON.stringify({ database: MONGO_DB, collection: MONGO_COLLECTION, result }, null, 2));
    if (requested && !result[requested]?.count) process.exitCode = 2;
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
