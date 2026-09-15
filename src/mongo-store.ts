import crypto from "node:crypto";

export const MONGO_INDEXES = [
  { key: { sourceRoundHash: 1 }, options: { unique: true, name: "source_round_hash_unique", partialFilterExpression: { sourceRoundHash: { $type: "string" } } } },
  { key: { features: 1 }, options: { name: "features" } },
  { key: { branches: 1 }, options: { name: "branches" } },
  { key: { mul: 1 }, options: { name: "mul" } },
  { key: { bet: 1 }, options: { name: "bet" } },
  { key: { buy: 1 }, options: { name: "buy" } },
] as const;

const SENSITIVE_KEYS = new Set(["authorization", "cookie", "huid", "queue", "request_id", "session_id", "token"]);

export function sanitizeProtocolData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeProtocolData);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_KEYS.has(key.toLowerCase()))
      .map(([key, child]) => [key, sanitizeProtocolData(child)]));
  }
  return value;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sourceRoundHash(document: { gameId?: number; game?: string; data: unknown }): string {
  return crypto.createHash("sha256").update(stable({
    gameId: document.gameId,
    game: document.game,
    data: sanitizeProtocolData(document.data),
  })).digest("hex");
}

interface MongoCollectionLike {
  createIndex(key: Record<string, number>, options?: Record<string, unknown>): Promise<unknown>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options: Record<string, unknown>): Promise<unknown>;
  bulkWrite?(...args: any[]): Promise<unknown>;
  estimatedDocumentCount?(): Promise<number>;
}

export async function ensureMongoIndexes(collection: MongoCollectionLike): Promise<void> {
  for (const index of MONGO_INDEXES) await collection.createIndex({ ...index.key }, { ...index.options });
}

export async function upsertMongoRound(collection: MongoCollectionLike, document: Record<string, unknown>): Promise<void> {
  const hash = String(document.sourceRoundHash ?? sourceRoundHash(document as { gameId?: number; game?: string; data: unknown }));
  // 唯一索引是 partial index；查询必须包含相同类型条件，Mongo 才会稳定使用索引。
  await collection.updateOne({ sourceRoundHash: { $eq: hash, $type: "string" } }, { $setOnInsert: { ...document, sourceRoundHash: hash } }, { upsert: true });
}

export async function upsertMongoRounds(collection: MongoCollectionLike, documents: Record<string, unknown>[], batchSize = 500): Promise<number> {
  const unique = [...new Map(documents.map(document => {
    const hash = String(document.sourceRoundHash ?? sourceRoundHash(document as { gameId?: number; game?: string; data: unknown }));
    return [hash, { ...document, sourceRoundHash: hash }];
  })).values()];
  if (!collection.bulkWrite) {
    for (const document of unique) await upsertMongoRound(collection, document);
    return unique.length;
  }
  for (let offset = 0; offset < unique.length; offset += batchSize) {
    await collection.bulkWrite(unique.slice(offset, offset + batchSize).map(document => ({
      updateOne: { filter: { sourceRoundHash: { $eq: document.sourceRoundHash, $type: "string" } }, update: { $setOnInsert: document }, upsert: true },
    })), { ordered: false });
  }
  return unique.length;
}

export async function syncMongoRounds(collection: MongoCollectionLike, documents: Record<string, unknown>[], batchSize = 500): Promise<number> {
  const unique = [...new Map(documents.map(document => {
    const hash = String(document.sourceRoundHash ?? sourceRoundHash(document as { gameId?: number; game?: string; data: unknown }));
    return [hash, { ...document, sourceRoundHash: hash }];
  })).values()];
  if (collection.estimatedDocumentCount && await collection.estimatedDocumentCount() === unique.length) {
    // 快速路径只校验最近恢复点，保持每次认领恒定为一次索引写，而不是重放全部历史。
    if (unique.length) await upsertMongoRound(collection, unique[unique.length - 1]);
    return 0;
  }
  return upsertMongoRounds(collection, unique, batchSize);
}
