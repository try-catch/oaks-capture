import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "capture.yml"), "utf8");
const worker = fs.readFileSync(path.join(root, "actions", "worker.ts"), "utf8");
const coordinator = fs.readFileSync(path.join(root, "actions", "coordinator.py"), "utf8");

test("每小时只调度一次并保留手工 check/capture/benchmark 入口", () => {
  assert.match(workflow, /options:\s*\[check, capture, benchmark\]/);
  assert.match(workflow, /options:\s*\['6', '10', '20', '40', '60'\]/);
  assert.match(workflow, /cron:\s*'43 \* \* \* \*'/);
  assert.doesNotMatch(workflow, /push:/);
});

test("采集严格服从 prepare 输出并保持单队列", () => {
  assert.match(workflow, /echo 'capture=enabled'/);
  assert.match(workflow, /if: needs\.prepare\.outputs\.capture == 'enabled'/);
  assert.match(workflow, /if: always\(\) && needs\.prepare\.outputs\.capture == 'enabled'/);
  assert.match(workflow, /group: oaks-official-single-queue/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /inputs\.mode == 'benchmark' \|\| \(vars\.BENCHMARK_ENABLED != 'true'/);
});

test("单个节点按线程数并发，节点数与矩阵一致", () => {
  assert.match(workflow, /OAKS_THREADS:\s*'8'/);
  assert.match(workflow, /OAKS_NODES:\s*'20'/);
  // 部署节奏是授权的运行参数，代码默认值保持更保守的 2 秒。
  assert.match(workflow, /OAKS_SPIN_DELAY_MS:\s*'1000'/);
  assert.match(workflow, /max-parallel:\s*20/);
  const matrix = workflow.match(/worker:\s*\[([^\]]+)\]/)?.[1] ?? "";
  assert.equal(matrix.split(",").length, 20);
  assert.match(worker, /numberFromEnv\('OAKS_THREADS', 8\)/);
  assert.match(worker, /fork\(__filename, \['thread'\]/);
  assert.match(worker, /Math\.min\(numberFromEnv\('OAKS_THREADS', 8\), Math\.ceil\(maxClaims \/ nodes\)\)/);
});

test("不会自动派发下一轮形成排队积压", () => {
  assert.doesNotMatch(workflow, /actions:\s*write/);
  assert.doesNotMatch(workflow, /actions\/workflows\/capture\.yml\/dispatches/);
});

test("同时活跃的官方会话数受限，不能等于线程总数", () => {
  // 实测 107 个并发会话 → 103 个游戏立刻 GAME_REOPENED；6 个会话时成功率 97%。
  assert.match(workflow, /OAKS_MAX_CLAIMS:\s*\$\{\{ inputs\.mode == 'benchmark' && inputs\.max_claims \|\| vars\.OAKS_STABLE_MAX_CLAIMS \|\| '6' \}\}/);
  assert.match(workflow, /OAKS_DEADLINE_MINUTES:\s*\$\{\{ inputs\.mode == 'benchmark' && '15' \|\| '45' \}\}/);
  assert.match(worker, /maxClaims: numberFromEnv\('OAKS_MAX_CLAIMS', 6\)/);
  assert.doesNotMatch(worker, /maxClaims: threads \* nodes/);
});

test("begin 把线程与节点拓扑交给协调器作为并发预算", () => {
  assert.match(worker, /maxInFlight:\s*threads \* nodes/);
  assert.match(workflow, /OAKS_THROTTLE_LIMIT:\s*'4'/);
  assert.match(worker, /throttleLimit:\s*Math\.min\(numberFromEnv\('OAKS_THROTTLE_LIMIT', 4\), Math\.ceil\(threads \/ 2\)\)/);
  assert.match(coordinator, /DEFAULT_THROTTLE_LIMIT = 4/);
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
  assert.match(coordinator, /len\(threads\) >= state\['topology'\]\['throttleLimit'\]/);
  assert.match(coordinator, /self\.release_node\(state, node\)/);
  assert.match(worker, /ACTIONS_HALTED/);
  assert.match(worker, /租约已交回，保留已落盘数据/);
});

test("采集 Runner 仍然禁止代理出口并强制 GitHub-hosted", () => {
  assert.match(worker, /不允许配置出口代理/);
  assert.match(worker, /采集仅允许在 GitHub-hosted Linux Runner 执行/);
  assert.match(worker, /真实采集需要服务商书面授权/);
});

test("空闲线程的协调连接短暂失败不会直接拖垮整个 Runner", () => {
  assert.match(worker, /deadline = Date\.now\(\) \+ numberFromEnv\('OAKS_DEADLINE_MINUTES', 40\) \* 60_000/);
  assert.match(worker, /catch \(error\) \{\s*if \(stopped\(\)\) break;\s*await new Promise/);
});
