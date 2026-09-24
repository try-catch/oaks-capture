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

test("CAPTURE_ENABLED 是硬门禁，且推送触发只认专用文件", () => {
  assert.match(workflow, /echo 'capture=run'/);
  assert.match(workflow, /if: needs\.prepare\.result == 'success' && needs\.prepare\.outputs\.capture == 'run'/);
  assert.doesNotMatch(workflow, /github\.event_name == 'schedule' \|\| github\.event_name == 'push'/);
  // 推送触发必须限定在专用文件上，普通代码推送不能启动真实采集。
  assert.match(workflow, /paths:\s*\n\s*-\s*'capture-trigger\.json'/);
  assert.match(workflow, /"\$GITHUB_EVENT_NAME" == push/);
});

test("单个节点按线程数并发，节点数与矩阵一致", () => {
  assert.match(workflow, /OAKS_THREADS:\s*'8'/);
  assert.match(workflow, /OAKS_NODES:\s*'20'/);
  // 在 24 会话硬上限内减少固定空等；429 仍由 CaptureThrottle 切回保守节奏。
  assert.match(workflow, /OAKS_SPIN_DELAY_MS:\s*'500'/);
  assert.match(workflow, /OAKS_NODE_SPACING_MS:\s*'200'/);
  assert.match(workflow, /OAKS_SHARDS_PER_GAME:\s*'2'/);
  assert.match(workflow, /max-parallel:\s*20/);
  const matrix = workflow.match(/worker:\s*\[([^\]]+)\]/)?.[1] ?? "";
  assert.equal(matrix.split(",").length, 20);
  // 每节点子进程数必须按全局会话预算收敛，不能直接用授权线程数。
  assert.match(worker, /const threads = activeThreads\(\)/);
  assert.match(worker, /fork\(__filename, \['thread'\]/);
});

test("定时采集与链式续跑处于停止状态（2026-09-13 交由 Codex 接手）", () => {
  // 两者都是可恢复的：取消注释即可重新启用。
  assert.doesNotMatch(workflow, /^\s*-\s*cron:/m);
  assert.doesNotMatch(workflow, /^\s+curl -sS -o \/dev\/null -w '下一轮派发/m);
  assert.match(workflow, /# schedule:/);
  assert.match(workflow, /# - name: 链式派发下一轮采集/);
  // 手工入口仍保留：workflow_dispatch 与专用文件推送。
  assert.match(workflow, /options:\s*\[check, capture\]/);
  assert.match(workflow, /capture-trigger\.json/);
});

test("同时活跃的官方会话数受限，不能等于线程总数", () => {
  // 会话数必须独立于线程数可调：历史上把两者绑在一起时，107 个并发会话
  // 让 103 个游戏立刻 GAME_REOPENED；正式采集维持历史压测最优的 24 个会话。
  const configured = workflow.match(/OAKS_MAX_CLAIMS:\s*'(\d+)'/);
  assert.ok(configured, '缺少 OAKS_MAX_CLAIMS');
  assert.ok(Number(configured![1]) < 8 * 20, '会话数不应等于线程总数');
  assert.match(worker, /maxClaims: numberFromEnv\('OAKS_MAX_CLAIMS', 24\)/);
  assert.doesNotMatch(worker, /maxClaims: threads \* nodes/);
  assert.match(worker, /maxShards: numberFromEnv\('OAKS_SHARDS_PER_GAME', 2\)/);
  assert.match(worker, /phase: 'catalog-coverage'/);
});

test("begin 把线程与节点拓扑交给协调器作为并发预算", () => {
  assert.match(worker, /maxInFlight:\s*threads \* nodes/);
  // 单线程节点只要一次限速就足以判定出口被封控，因此熔断阈值随线程数收敛。
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
  // 阈值用 >=：收敛到单线程后，一次限速就足以判定该出口被封控。
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
