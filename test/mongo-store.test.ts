import assert from "node:assert/strict";
import test from "node:test";
import { ensureMongoIndexes, sanitizeProtocolData, sourceRoundHash, upsertMongoRound } from "../src/mongo-store";

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
  assert.match((writes[0] as any).filter.sourceRoundHash, /^[a-f0-9]{64}$/);
});
