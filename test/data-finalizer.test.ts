import assert from "node:assert/strict";
import test from "node:test";
import { buildDataManifest } from "../src/data-finalizer";

const hashes = Array.from({ length: 12 }, (_, index) => index.toString(16).padStart(64, "0"));

test("数据总清单要求普通输赢各一条且特殊分支十条唯一哈希", () => {
  const manifest = buildDataManifest(
    { gameId: 32601, slug: "sun_of_egypt", dbName: "oaks_SunOfEgypt" },
    hashes.map((sourceRoundHash) => ({ sourceRoundHash })),
    {
      documents: 12, invalid: 0, duplicates: 0, sensitiveDocuments: 0, uniqueRoundHashes: 12,
      coverage: { "base-loss": 1, "base-or-feature-win": 1, "free-spins": 10 },
      examples: { "base-loss": [1], "base-or-feature-win": [2], "free-spins": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
      required: ["base-loss", "base-or-feature-win", "free-spins"],
    },
    "a".repeat(64),
    10,
  );
  assert.equal(manifest.complete, true);
  assert.equal((manifest.featureHashes as Record<string, string[]>)["free-spins"].length, 10);
});

test("特殊分支不足十条时拒绝生成清单", () => {
  assert.throws(() => buildDataManifest(
    { gameId: 32601, slug: "sun_of_egypt", dbName: "oaks_SunOfEgypt" },
    hashes.slice(0, 9).map((sourceRoundHash) => ({ sourceRoundHash })),
    {
      documents: 9, invalid: 0, duplicates: 0, sensitiveDocuments: 0, uniqueRoundHashes: 9,
      coverage: { "free-spins": 9 }, examples: { "free-spins": [1, 2, 3, 4, 5, 6, 7, 8, 9] }, required: ["free-spins"],
    },
    "b".repeat(64),
    10,
  ), /少于 10/);
});


test("Mongo 存在额外文档时不能将数据标为完成", () => {
  assert.throws(() => buildDataManifest(
    {gameId: 32608, slug: "joker_glitz_x1000", dbName: "oaks_joker_glitz_x1000"},
    [{sourceRoundHash: "a".repeat(64)}],
    {documents: 1, invalid: 0, duplicates: 0, sensitiveDocuments: 0, uniqueRoundHashes: 1,
      coverage: {}, examples: {}, required: []},
    "b".repeat(64), 10, {total: 2, valid: true, featureCounts: {}}
  ), /MongoDB 回读未通过/);
});
