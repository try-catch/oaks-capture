import assert from "node:assert/strict";
import test from "node:test";
import { RegistryGame } from "../src/catalog";
import { MIN_AVAILABLE_DISK, MIN_AVAILABLE_MEMORY } from "../src/deploy-plan";
import { auditServices, auditTestList } from "../src/test-audit";

const registry: RegistryGame[] = [
  { gameId: 32601, slug: "sun_of_egypt", title: "Sun of Egypt", active: true, dbName: "oaks_SunOfEgypt", validator: "sun-of-egypt" },
  { gameId: 32602, slug: "second", title: "Second", active: true, dbName: "oaks_Second", validator: "common" },
];

test("测试站必须使用 OAKS 技术标识并完整匹配 3 OAKS 注册表", () => {
  const audit = auditTestList(registry, [
    { gameId: 32601, provider: "OAKS", sourceId: "sun_of_egypt", status: 1 },
    { gameId: 32602, provider: "OAKS", sourceId: "second", status: 1 },
  ]);
  assert.equal(audit.brandDisplay, "3 OAKS");
  assert.equal(audit.valid, true);
  assert.equal(audit.actual, 2);
});

test("缺游戏或 slug 错位时测试站验收失败", () => {
  const audit = auditTestList(registry, [{ gameId: 32601, provider: "OAKS", sourceId: "wrong", status: 1 }]);
  assert.equal(audit.valid, false);
  assert.deepEqual(audit.missing, ["second"]);
});

test("服务必须运行、属于 OAKS 且有版本和 SHA", () => {
  const services = registry.map((game) => ({
    id: `game-${game.gameId}`, platform: "OAKS", gameId: game.gameId, status: "running", pid: game.gameId,
    version: "v20260909.1", sha256: "a".repeat(64), controllable: true,
  }));
  const audit = auditServices(registry, services, { memory: { available: MIN_AVAILABLE_MEMORY }, disk: { available: MIN_AVAILABLE_DISK } });
  assert.equal(audit.valid, true);
});
