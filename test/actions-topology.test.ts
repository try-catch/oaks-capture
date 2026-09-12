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

test("采集门禁不依赖单个 job 输出，且推送触发只认专用文件", () => {
  // 只依赖 prepare 的 job 输出时，capture 曾被无条件跳过（run 24/25）。
  assert.match(workflow, /github\.event_name == 'schedule' \|\| github\.event_name == 'push'/);
  assert.match(workflow, /inputs\.mode == 'capture' \|\| needs\.prepare\.outputs\.capture == 'true'/);
  // 推送触发必须限定在专用文件上，普通代码推送不能启动真实采集。
  assert.match(workflow, /paths:\s*\n\s*-\s*'capture-trigger\.json'/);
  assert.match(workflow, /"\$GITHUB_EVENT_NAME" == push/);
});

test("单个节点按线程数并发，节点数与矩阵一致", () => {
  assert.match(workflow, /OAKS_THREADS:\s*'8'/);
  assert.match(workflow, /OAKS_NODES:\s*'20'/);
  // 部署节奏是授权的运行参数，代码默认值保持更保守的 2 秒。
  assert.match(workflow, /OAKS_SPIN_DELAY_MS:\s*'1500'/);
  assert.match(workflow, /max-parallel:\s*20/);
  const matrix = workflow.match(/worker:\s*\[([^\]]+)\]/)?.[1] ?? "";
  assert.equal(matrix.split(",").length, 20);
  assert.match(worker, /numberFromEnv\('OAKS_THREADS', 8\)/);
  assert.match(worker, /fork\(__filename, \['thread'\]/);
});

test("运行结束后链式派发下一轮，不依赖 GitHub 的 cron", () => {
  // 实测 GitHub 对低活跃公开仓库的 cron 会被合并甚至丢弃：配每小时一次时
  // 一天只触发 4 次，所以连续性靠 finish 派发下一轮。
  assert.match(workflow, /actions:\s*write/);
  assert.match(workflow, /actions\/workflows\/capture\.yml\/dispatches/);
  assert.match(workflow, /"ref":"main","inputs":\{"mode":"capture"\}/);
  // prepare 失败不得续跑，避免配置性故障形成无限失败链。
  assert.match(workflow, /always\(\) && needs\.prepare\.result == 'success'/);
});

test("同时活跃的官方会话数受限，不能等于线程总数", () => {
  // 实测 107 个并发会话 → 103 个游戏立刻 GAME_REOPENED；6 个会话时成功率 97%。
  assert.match(workflow, /OAKS_MAX_CLAIMS:\s*'6'/);
  assert.match(worker, /maxClaims: numberFromEnv\('OAKS_MAX_CLAIMS', 6\)/);
  assert.doesNotMatch(worker, /maxClaims: threads \* nodes/);
});

test("begin 把线程与节点拓扑交给协调器作为并发预算", () => {
  assert.match(worker, /maxInFlight:\s*threads \* nodes/);
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
