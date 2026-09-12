import assert from "node:assert/strict";
import test from "node:test";
import { auditModeQuota, declaredModeTypes } from "../src/mode-target";
import type { RegistryGame } from "../src/catalog";

const game = {
  slug: "fixture",
  discovery: { settings: {
    buyModes: [{ providerMode: 0, spinType: 1, price: 50, source: "array" }],
    boosterPrices: { "2": 3 },
  } },
} as unknown as RegistryGame;

test("按代码定义生成普通、购买和加注配额", () => {
  assert.deepEqual(declaredModeTypes(game), [0, 1, 1002]);
  const documents = [
    { buy: 0, data: [{}] },
    { buy: 1, data: [{}] },
    { buy: 1002, data: [{}] },
    { buy: 1002, data: [{}], testOnly: true },
  ];
  assert.deepEqual(auditModeQuota(game, documents, 2, 1), {
    counts: { 0: 1, 1: 1, 1002: 1 },
    targets: { 0: 2, 1: 1, 1002: 1 },
    missing: [0],
  });
});
