import assert from "node:assert/strict";
import test from "node:test";
import { ensureMongoIndexes, sanitizeProtocolData, sourceRoundHash, syncMongoRounds, upsertMongoRound, upsertMongoRounds } from "../src/mongo-store";

test("sourceRoundHash 忽略敏感会话字段并保持内容稳定", () => {
  const first = { gameId: 32601, game: "sun_of_egypt", data: [{ request_id: "one", session_id: "secret", context: { total_win: 10 } }] };
  const copy = { game: "sun_of_egypt", gameId: 32601, data: [{ request_id: "two", session_id: "other", context: { total_win: 10 } }] };
  assert.equal(sourceRoundHash(first), sourceRoundHash(copy));
  const sanitized = JSON.stringify(sanitizeProtocolData({ token: "a", queue: "b", cookie: "c", nested: { huid: "d", value: 1 } }));
  assert.equal(sanitized, '{"nested":{"value":1}}');
});

test("MongoDB 建立唯一索引并按 sourceRoundHash upsert", async () => {
  const indexes: unknown[] = [];
  const writes: unknown[] = [];
  const collection = {
    async createIndex(key: unknown, options: unknown) { indexes.push({ key, options }); },
    async updateOne(filter: unknown, update: unknown, options: unknown) { writes.push({ filter, update, options }); },
  };
  await ensureMongoIndexes(collection);
  assert.equal(indexes.length, 6);
  assert.deepEqual(indexes[0], { key: { sourceRoundHash: 1 }, options: { unique: true, name: "source_round_hash_unique", partialFilterExpression: { sourceRoundHash: { $type: "string" } } } });
  const document = { gameId: 32601, game: "sun_of_egypt", data: [{ context: { total_win: 0 } }] };
  await upsertMongoRound(collection, document);
  assert.deepEqual((writes[0] as any).options, { upsert: true });
  assert.match((writes[0] as any).filter.sourceRoundHash.$eq, /^[a-f0-9]{64}$/);
  assert.equal((writes[0] as any).filter.sourceRoundHash.$type, "string");
});

test("历史数量一致时跳过全量 upsert，不一致时分批写入", async () => {
  const documents = Array.from({ length: 3 }, (_, index) => ({ sourceRoundHash: String(index).padStart(64, "a"), data: [index] }));
  let batches = 0;
  let fastWrites = 0;
  const matching = { async estimatedDocumentCount() { return 3; }, async createIndex() {}, async updateOne() { fastWrites++; } };
  assert.equal(await syncMongoRounds(matching, documents), 0);
  assert.equal(fastWrites, 1);
  const repairing = {
    async estimatedDocumentCount() { return 1; }, async createIndex() {}, async updateOne() {},
    async bulkWrite(operations: unknown[]) { batches++; assert.ok(operations.length <= 2); },
  };
  assert.equal(await syncMongoRounds(repairing, documents, 2), 3);
  assert.equal(batches, 2);
});

test("实时数据批量 upsert 不扫描集合数量", async () => {
  let estimated = 0;
  const batches: unknown[][] = [];
  const collection = {
    async estimatedDocumentCount() { estimated++; return 0; },
    async createIndex() {}, async updateOne() {},
    async bulkWrite(operations: unknown[]) { batches.push(operations); },
  };
  const documents = [1, 2, 3].map(value => ({ game: "one", data: { value } }));
  assert.equal(await upsertMongoRounds(collection, documents, 2), 3);
  assert.equal(estimated, 0);
  assert.deepEqual(batches.map(batch => batch.length), [2, 1]);
});
