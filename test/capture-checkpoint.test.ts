import assert from "node:assert/strict";
import test from "node:test";
import { coverageComplete, featureTarget, remainingTargets } from "../src/capture-checkpoint";

test("capture checkpoint 按每个必需分支计算剩余数量", () => {
  assert.deepEqual(remainingTargets({ "free-spins": 10, respin: 7 }, ["free-spins", "respin"], 10), { respin: 3 });
  assert.equal(coverageComplete(["free-spins", "respin"], { "free-spins": 10, respin: 9 }, 10), false);
  assert.equal(coverageComplete(["free-spins", "respin"], { "free-spins": 10, respin: 10 }, 10), true);
});

test("普通输赢各一条，只有特殊分支使用批量目标", () => {
  assert.equal(featureTarget("base-loss", 10), 1);
  assert.equal(featureTarget("base-or-feature-win", 10), 1);
  assert.equal(featureTarget("free-spins", 10), 10);
  assert.deepEqual(remainingTargets({ "base-loss": 1 }, ["base-loss", "base-or-feature-win", "free-spins"], 10), {
    "base-or-feature-win": 1,
    "free-spins": 10,
  });
});
