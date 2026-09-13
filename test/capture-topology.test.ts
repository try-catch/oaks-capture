import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "..");
// 内部仓库把 workflow 放在 actions/workflow.yml，公开仓库放在 .github/workflows/capture.yml。
const workflowPath = [".github/workflows/capture.yml", "actions/workflow.yml"]
  .map((relative) => path.join(root, relative))
  .find((candidate) => fs.existsSync(candidate));
assert.ok(workflowPath, "找不到 capture workflow");
const workflow = fs.readFileSync(workflowPath!, "utf8");
const worker = fs.readFileSync(path.join(root, "actions", "worker.ts"), "utf8");
const coordinator = fs.readFileSync(path.join(root, "actions", "coordinator.py"), "utf8");
const pythonTests = fs.readFileSync(path.join(root, "actions", "test_coordinator.py"), "utf8");

function envValue(name: string): string {
  const match = workflow.match(new RegExp(`${name}:\\s*(.+)`));
  assert.ok(match, `workflow 缺少 ${name}`);
  return match![1].trim();
}

test("20 个节点只保留全局会话预算所需的 worker 子进程", () => {
  const nodes = Number(envValue("OAKS_NODES").replace(/['"]/g, ""));
  const maxClaims = Number(envValue("OAKS_MAX_CLAIMS").replace(/['"]/g, ""));
  const authorizedThreads = Number(envValue("OAKS_THREADS").replace(/['"]/g, ""));
  assert.equal(nodes, 20);
  assert.equal(maxClaims, 6);
  // OAKS_THREADS 是与服务商书面授权的上限，不是每节点实际要 fork 的子进程数。
  // 实际值必须收敛到 ceil(maxClaims / nodes)：20 节点 × 6 会话 = 每节点 1 个。
  assert.equal(Math.min(authorizedThreads, Math.ceil(maxClaims / nodes)), 1);
  assert.match(worker, /Math\.min\(numberFromEnv\('OAKS_THREADS', 8\), Math\.ceil\(maxClaims \/ nodes\)\)/);
  assert.doesNotMatch(worker, /const threads = numberFromEnv\('OAKS_THREADS', 8\)/);
  // 两条启动路径都必须走收敛后的线程数：supervise 产子进程、begin 上报预算。
  assert.ok((worker.match(/activeThreads\(\)/g) ?? []).length >= 3, "activeThreads 未覆盖全部启动路径");
});

test("同时活跃的写入者硬限制为 6，不能被派发参数放大", () => {
  // 旧版 workflow 允许 benchmark 把 max_claims 调到 120，等于绕过 6 的硬限制。
  assert.equal(envValue("OAKS_MAX_CLAIMS"), "'6'");
  assert.doesNotMatch(workflow, /inputs\.max_claims/);
  assert.doesNotMatch(workflow, /'40', '60', '80'/);
});

test("满额 claim 必须指数退避且客户端原样遵守", () => {
  assert.match(coordinator, /CLAIM_WAIT_BASE_MS = 1500/);
  assert.match(coordinator, /CLAIM_WAIT_MAX_MS = 30_000/);
  // 满额分支必须走退避，不能回到固定 3000 毫秒的轮询。
  assert.doesNotMatch(coordinator, /'wait': 3000/);
  // 全局满额与单节点满额两条分支都要退避。
  assert.equal((coordinator.match(/'wait': claim_backoff\(state, worker\)/g) ?? []).length, 2);
  assert.match(coordinator, /clear_claim_backoff\(state, worker\)/);
  // 客户端必须按协调器下发的退避等待，不能再夹到 5 秒。
  assert.match(worker, /Math\.min\(30_000, wait\)/);
  assert.doesNotMatch(worker, /Math\.min\(5000, claimed\.wait\)/);
  assert.match(pythonTests, /def test_full_capacity_claim_backs_off_exponentially/);
  assert.match(pythonTests, /def test_successful_claim_clears_backoff/);
});

test("退避状态对门禁可观测且每轮重置", () => {
  assert.match(coordinator, /'claimBackoff': \{'workers'/);
  assert.match(coordinator, /metrics=metrics, claimWaits=\{\}/);
  assert.match(pythonTests, /def test_begin_resets_claim_backoff/);
});
