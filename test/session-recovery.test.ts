import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { recoverableRoundError } from "../oaks";
import { command, ProtocolStatusError } from "../src/protocol";

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

test("会话重开与结果未知都只丢弃这一局，普通错误仍然直接抛出", () => {
  assert.equal(recoverableRoundError(new ProtocolStatusError("GAME_REOPENED", "play: reopened")), true);
  assert.equal(recoverableRoundError(new Error('play/spin: {"code":"GAME_REOPENED"}')), true);
  assert.equal(recoverableRoundError(new Error("协调器拒绝操作: 存在结果未知的官方请求，已隔离，禁止自动重放")), true);
  assert.equal(recoverableRoundError(new Error("已缓存的官方响应为业务失败: SERVER_ERROR")), true);
  assert.equal(recoverableRoundError(new ProtocolStatusError("FUNDS_EXCEED", "play: funds")), false);
  assert.equal(recoverableRoundError(new Error("结果缺少当前局 total_win/round_win")), false);
});

test("持久化模式下不再一遇错误就让整个游戏失败", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "oaks.ts"), "utf8");
  // 旧实现在安装 captureRuntime 后直接 throw，导致 Actions 里任何一次会话重开都终结该游戏；
  // 现在只有“不可恢复”的错误才抛出，可恢复的会话失效先丢弃未完成局。
  assert.match(source, /recoverableRoundError\(error\)\) captureRuntime\.savePending\(undefined\);\s*\n\s*else if \(captureRuntime\) throw error;/);
  // 会话建立失败在持久化模式下也必须重试。
  assert.equal(source.match(/if \(captureRuntime\) throw error/g)?.length, 1);
});

test("可恢复的会话失效会丢弃未完成局并重新登录", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "oaks.ts"), "utf8");
  assert.match(source, /recoverableRoundError\(error\)\) captureRuntime\.savePending\(undefined\)/);
  assert.match(source, /ACTIONS_BUDGET.*ACTIONS_RATE_LIMIT.*ACTIONS_HALTED/);
});

test("协调器只重放可用响应，业务失败的 200 必须重新请求", () => {
  assert.match(coordinator, /previous\.get\('usable'\) is True/);
  assert.match(coordinator, /entry\['usable'\] = bool\(req\.get\('usable'/);
});

test("worker 拒绝重放已缓存的业务失败响应并输出可诊断原因", () => {
  assert.match(worker, /已缓存的官方响应为业务失败/);
  assert.match(worker, /usable: usableResponse\(body\)/);
  assert.match(worker, /function reasonOf/);
  // 公开日志不得出现完整 URL（含队列令牌）或官方响应正文。
  assert.match(worker, /replace\(\/https\?:\\\/\\\/\\S\+\/g, '<url>'\)/);
});
