import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, "actions", "workflow.yml"), "utf8");
const worker = fs.readFileSync(path.join(root, "actions", "worker.ts"), "utf8");
const coordinator = fs.readFileSync(path.join(root, "actions", "coordinator.py"), "utf8");

test("定时检查为每二十分钟一次且保留手工 check/capture 入口", () => {
  assert.match(workflow, /-\s*cron:\s*'\*\/20 \* \* \* \*'/);
  assert.doesNotMatch(workflow, /cron:\s*'17 \* \* \* \*'/);
  assert.match(workflow, /options:\s*\[check, capture\]/);
});

test("单个节点按线程数并发，节点数与矩阵一致", () => {
  assert.match(workflow, /OAKS_THREADS:\s*'8'/);
  assert.match(workflow, /OAKS_NODES:\s*'20'/);
  assert.match(workflow, /max-parallel:\s*20/);
  const matrix = workflow.match(/worker:\s*\[([^\]]+)\]/)?.[1] ?? "";
  assert.equal(matrix.split(",").length, 20);
  assert.match(worker, /numberFromEnv\('OAKS_THREADS', 8\)/);
  assert.match(worker, /fork\(__filename, \['thread'\]/);
});

test("begin 把线程与节点拓扑交给协调器作为并发预算", () => {
  assert.match(worker, /maxInFlight:\s*threads \* nodes/);
  assert.match(worker, /maxClaims:\s*threads \* nodes/);
  assert.match(worker, /throttleLimit:\s*numberFromEnv\('OAKS_THROTTLE_LIMIT', 6\)/);
  assert.match(coordinator, /DEFAULT_THROTTLE_LIMIT = 6/);
});

test("单次采集不再被 500 局上限截断，由配额或本轮预算收工", () => {
  assert.match(worker, /'--rounds', '1000000'/);
  assert.doesNotMatch(worker, /'--rounds', '500'/);
});

test("官方请求仍受节点间隔、Retry-After 与全局暂停约束", () => {
  assert.match(coordinator, /DEFAULT_NODE_SPACING_MS = 250/);
  assert.match(coordinator, /GLOBAL_LIMIT_NODES = 2/);
  assert.match(coordinator, /state\['until'\] = max\(state\['until'\], now \+ wait\)/);
  assert.match(coordinator, /state\['nodeUntil'\]\[node\] = max\(state\['nodeUntil'\]\.get\(node, 0\), now \+ wait\)/);
  assert.match(coordinator, /禁止自动重放/);
});

test("熔断节点交回租约并停止真实请求，但保留已落盘数据", () => {
  assert.match(coordinator, /len\(threads\) > state\['topology'\]\['throttleLimit'\]/);
  assert.match(coordinator, /self\.release_node\(state, node\)/);
  assert.match(worker, /ACTIONS_HALTED/);
  assert.match(worker, /租约已交回，保留已落盘数据/);
});

test("采集 Runner 仍然禁止代理出口并强制 GitHub-hosted", () => {
  assert.match(worker, /不允许配置出口代理/);
  assert.match(worker, /采集仅允许在 GitHub-hosted Linux Runner 执行/);
  assert.match(worker, /真实采集需要服务商书面授权/);
});
