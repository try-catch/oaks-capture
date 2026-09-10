import assert from "node:assert/strict";
import test from "node:test";
import { buildDeployPlan, capacityGate, DeployReadiness, MIN_AVAILABLE_DISK, MIN_AVAILABLE_MEMORY } from "../src/deploy-plan";
import { RegistryGame } from "../src/catalog";

function games(count: number): RegistryGame[] {
  return Array.from({ length: count }, (_, index) => ({
    gameId: 32601 + index, slug: `game_${index + 1}`, title: `Game ${index + 1}`,
    active: true, dbName: `oaks_Game${index + 1}`, validator: "common",
  }));
}

test("107 款游戏严格拆为 11 个不超过十款的 Ops Agent 批次", () => {
  const input = games(107);
  const ready = new Map<string, DeployReadiness>(input.map((game) => [game.slug, { service: true, resource: true, data: true, mongo: true, validation: true }]));
  const plan = buildDeployPlan(input, ready, { version: "v20260909.140000", registryImage: "127.0.0.1:5001/api-legacy-release" });
  assert.equal(plan.ready, true);
  assert.equal(plan.batches.length, 11);
  assert.equal(plan.batches[0].games.length, 10);
  assert.equal(plan.batches[10].games.length, 7);
  assert.equal(plan.batches[0].request.platform, "OAKS");
  assert.match(plan.batches[0].request.items[0].image, /v20260909\.140000-game-32601-amd64$/);
});

test("仅将达标游戏放入批次，不等待其余游戏", () => {
  const input = games(2);
  const ready = new Map<string, DeployReadiness>([
    [input[0].slug, { service: true, resource: true, data: true, mongo: true, validation: true }],
    [input[1].slug, { service: true, resource: true, data: false, mongo: false, validation: true }],
  ]);
  const plan = buildDeployPlan(input, ready, { version: "v20260909.2", registryImage: "127.0.0.1:5001/api-legacy-release" });
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.blockedGames[0].missing, ["data", "mongo"]);
  assert.equal(plan.batches[0].status, "pending");
  assert.deepEqual(plan.batches[0].games.map(game => game.slug), [input[0].slug]);
});

test("容量门禁要求至少 8 GiB 内存和 80 GiB 磁盘", () => {
  assert.equal(capacityGate({ memory: { available: MIN_AVAILABLE_MEMORY }, disk: { available: MIN_AVAILABLE_DISK } }).pass, true);
  const failed = capacityGate({ memory: { available: MIN_AVAILABLE_MEMORY - 1 }, disk: { available: MIN_AVAILABLE_DISK - 1 } });
  assert.equal(failed.pass, false);
  assert.equal(failed.reasons.length, 2);
});

 test("已部署游戏和严格校验失败游戏不生成发布批次", () => {
  const input = games(2);
  const states = new Map<string, DeployReadiness>([
    [input[0].slug, {service: true, resource: true, data: true, mongo: true, validation: true, deployed: true}],
    [input[1].slug, {service: true, resource: true, data: true, mongo: true, validation: false}],
  ]);
  const plan = buildDeployPlan(input, states, {version: "v20260910.1", registryImage: "localhost:5001/release"});
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.batches, []);
  assert.deepEqual(plan.blockedGames[0].missing, ["validation"]);
});
