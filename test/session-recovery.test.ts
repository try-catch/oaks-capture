import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { recoverableRoundError } from "../oaks";
import { command, ProtocolHttpError, ProtocolStatusError } from "../src/protocol";

const worker = fs.readFileSync(path.resolve(__dirname, "..", "actions", "worker.ts"), "utf8");
const coordinator = fs.readFileSync(path.resolve(__dirname, "..", "actions", "coordinator.py"), "utf8");

async function withFetch(body: string, run: () => Promise<unknown>): Promise<unknown> {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 200 });
  try { return await run(); } finally { globalThis.fetch = original; }
}

test("官方 200 里的业务失败码必须抛成可判别的会话错误", async () => {
  await assert.rejects(
    () => withFetch(JSON.stringify({ status: { code: "GAME_REOPENED" }, command: "play" }), () => command("https://example.test/g", "", "play", {})),
    (error: unknown) => error instanceof ProtocolStatusError && error.code === "GAME_REOPENED",
  );
  await assert.rejects(
    () => withFetch(JSON.stringify({ status: { code: "SERVER_ERROR" } }), () => command("https://example.test/g", "", "play", {})),
    (error: unknown) => error instanceof ProtocolStatusError && error.code === "SERVER_ERROR",
  );
});

test("OK 响应正常返回，不会被误判为失败", async () => {
  const result = await withFetch(JSON.stringify({ status: { code: "OK" }, context: {} }), () => command("https://example.test/g", "", "play", {})) as Record<string, unknown>;
  assert.deepEqual(result.context, {});
});

test("官方 200 非 JSON 响应按可恢复会话错误处理", async () => {
  await assert.rejects(
    () => withFetch("Get3OaksSpin temporary error", () => command("https://example.test/g", "", "play", {})),
    (error: unknown) => error instanceof ProtocolStatusError && error.code === "INVALID_JSON" && recoverableRoundError(error),
  );
});

test("会话重开与结果未知都只丢弃这一局，普通错误仍然直接抛出", () => {
  assert.equal(recoverableRoundError(new ProtocolStatusError("GAME_REOPENED", "play: reopened")), true);
  assert.equal(recoverableRoundError(new Error('play/spin: {"code":"GAME_REOPENED"}')), true);
  assert.equal(recoverableRoundError(new Error("协调器拒绝操作: 存在结果未知的官方请求，已隔离，禁止自动重放")), true);
  assert.equal(recoverableRoundError(new Error("已缓存的官方响应为业务失败: SERVER_ERROR")), true);
  assert.equal(recoverableRoundError(new ProtocolStatusError("SERVER_ERROR", "play: server error")), true);
  assert.equal(recoverableRoundError(new ProtocolHttpError("503", 503, 0)), true);
  assert.equal(recoverableRoundError(new ProtocolStatusError("FUNDS_EXCEED", "play: funds")), true);
  assert.equal(recoverableRoundError(new TypeError("fetch failed")), true);
  assert.equal(recoverableRoundError(new Error("结果缺少当前局 total_win/round_win")), false);
});

test("持久化模式下不再一遇错误就让整个游戏失败", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "oaks.ts"), "utf8");
  // 旧实现在安装 captureRuntime 后直接 throw，导致 Actions 里任何一次会话重开都终结该游戏；
  // 现在只有“不可恢复”的错误才抛出，可恢复的会话失效先丢弃未完成局。
  assert.match(source, /recoverableRoundError\(error\) \|\| retryBuyParameters\)\) captureRuntime\.discardPending\(\);\s*\n\s*else if \(captureRuntime\) throw error;/);
  // 会话建立失败在持久化模式下也必须重试。
  assert.equal(source.match(/if \(captureRuntime\) throw error/g)?.length, 1);
});

test("购买参数被服务拒绝时会丢弃当前局并使用下一组官方参数重试", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "oaks.ts"), "utf8");
  assert.match(source, /retryBuyParameters = message\.includes\("SERVER_ERROR"\) && attemptedAction\?\.name === "buy_spin"/);
  assert.match(source, /recoverableRoundError\(error\) \|\| retryBuyParameters/);
});

test("可恢复的会话失效会丢弃未完成局并重新登录", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "oaks.ts"), "utf8");
  assert.match(source, /recoverableRoundError\(error\) \|\| retryBuyParameters\)\) captureRuntime\.discardPending\(\)/);
  assert.match(source, /ACTIONS_BUDGET.*ACTIONS_RATE_LIMIT.*ACTIONS_HALTED/);
});

test("协调器只重放可用响应，业务失败的 200 必须重新请求", () => {
  assert.match(coordinator, /previous\.get\('usable'\) is True/);
  assert.match(coordinator, /entry\['usable'\] = usable/);
});

test("丢弃未完成局必须同时清掉请求日志键，否则重新登录会被缓存重放", () => {
  const workerSource = fs.readFileSync(path.resolve(__dirname, "..", "actions", "worker.ts"), "utf8");
  assert.match(workerSource, /discardPending: \(\) => \{[\s\S]{0,200}?requestKey = undefined/);
  // 未完成局只在进程内保留：跨运行恢复必然拿死会话重放（会话空闲约 61 秒即被重开）。
  assert.match(workerSource, /pending = undefined;\s*\n\s*requestKey = undefined;/);
  assert.doesNotMatch(workerSource, /restored\.pending/);
  // JSON.stringify 会丢掉 undefined 字段，清空未完成局曾经因此让线程抛 KeyError 卡死。
  assert.doesNotMatch(workerSource, /value: undefined/);
});

test("协调走常驻长连接，异常时回退单次调用", () => {
  const channelSource = fs.readFileSync(path.resolve(__dirname, "..", "src", "coordinator-channel.ts"), "utf8");
  // 单次调用要新起 ssh+sudo+python，实测每次 1-2 秒，是一轮三个往返的主要成本。
  assert.match(worker, /coordinator-client\.py/);
  assert.match(worker, /CoordinatorChannel/);
  // 默认启用；显式设为 0 才关闭（numberFromEnv 把 0 当无效值回落默认）。
  assert.match(worker, /process\.env\.OAKS_PERSISTENT_CHANNEL !== '0'/);
  assert.doesNotMatch(worker, /numberFromEnv\('OAKS_PERSISTENT_CHANNEL'/);
  // 阻塞读写必须用 handle 上的 fd：子进程管道的 .fd 是 undefined（实测踩过，
  // 结果每次都静默回退，还会留下一堆半死的 ssh 进程把 sshd 拖垮）。
  assert.match(channelSource, /_handle\?\.fd/);
  // 不能设置阻塞模式：阻塞读没有超时，对端不响应会永久卡住整条线程（实测踩过）。
  assert.doesNotMatch(channelSource, /setBlocking/);
  assert.match(channelSource, /EAGAIN/);
  assert.match(channelSource, /协调通道读取超时/);
  // 通道任何异常都必须退回单次调用，且单次调用仍然校验 ok。
  assert.match(channelSource, /return this\.oneShot\(payload\)/);
  assert.match(worker, /协调器拒绝操作/);
});

test("worker 在 GitHub 本地缓存响应且只向测试服报告小型状态", () => {
  assert.match(worker, /localResponses\.set/);
  assert.match(worker, /rpc\('permit', \{ key \}\)/);
  assert.doesNotMatch(worker, /body: body\.toString\('base64'\)/);
  assert.doesNotMatch(worker, /rpc\('permit', \{ key, request \}\)/);
  assert.match(worker, /usable = response\.ok && usableResponse\(body\)/);
  assert.match(worker, /businessCode: 'FETCH_ERROR'/);
  assert.match(worker, /function reasonOf/);
  // 公开日志不得出现完整 URL（含队列令牌）或官方响应正文。
  assert.match(worker, /replace\(\/https\?:\\\/\\\/\\S\+\/g, '<url>'\)/);
});
