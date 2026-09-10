import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { JSONMap, nextAction, validateRound } from "./src/protocol";

function option(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

function numberOption(name: string, fallback: number): number {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

function nonNegativeNumberOption(name: string, fallback: number): number {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`);
  return value;
}

function requestId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function parseConnection(): { api: string; token: string } {
  const gameURL = option("--game-url");
  if (gameURL) {
    const parsed = new URL(gameURL);
    const api = parsed.searchParams.get("api") ?? "";
    const token = parsed.searchParams.get("token") ?? "";
    if (!api || !token) throw new Error("--game-url 缺少 api 或 token 参数");
    return { api: api.replace(/\/$/, ""), token };
  }
  const api = option("--api").replace(/\/$/, "");
  const token = option("--token");
  if (!api || !token) throw new Error("请传 --game-url，或同时传 --api 与 --token");
  return { api, token };
}

async function send(endpoint: string, command: string, body: JSONMap): Promise<JSONMap> {
  const response = await fetch(`${endpoint}?gsc=${encodeURIComponent(command)}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${command} HTTP ${response.status}: ${text}`);
  const result = JSON.parse(text) as JSONMap;
  if (result.status?.code !== "OK") throw new Error(`${command} 协议失败: ${text}`);
  if (result.request_id !== body.request_id) throw new Error(`${command} request_id 未原样返回`);
  return result;
}

function cumulativeWin(frame: JSONMap): number {
  const context = frame.context ?? {};
  const current = context.current && context[context.current];
  for (const candidate of [current?.total_win, current?.round_win, context.total_win, context.round_win]) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  throw new Error("响应帧缺少当前玩法累计赢分");
}

function balance(frame: JSONMap): number {
  const value = Number(frame.user?.balance);
  if (!Number.isInteger(value) || value < 0) throw new Error(`非法余额: ${frame.user?.balance}`);
  return value;
}

function assertMoney(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`${label}: 实际 ${actual}，预期 ${expected}`);
}

function stableFrame(frame: JSONMap): string {
  const cloned = structuredClone(frame);
  delete cloned.request_id;
  return JSON.stringify(cloned);
}

async function main(): Promise<void> {
  const { api, token } = parseConnection();
  const rounds = numberOption("--rounds", 100);
  const game = option("--game", "sun_of_egypt").trim().replace(/^\/+|\/+$/g, "");
  const bet = numberOption("--bet", 25);
  const betPerLine = numberOption("--bet-per-line", 1);
  const lines = numberOption("--lines", 25);
  const pauseBeforeSpinMs = nonNegativeNumberOption("--pause-before-spin-ms", 0);
  const pauseBeforeRound = numberOption("--pause-before-round", 1);
  const expectedFeature = option("--expect-feature").trim();
  const output = path.resolve(option("--output", "output/local-audit.json"));
  if (!game) throw new Error("--game 不能为空");
  const endpoint = `${api}/${game}/`;

  const loginRequest = { command: "login", request_id: requestId(), token, language: "en" };
  const login = await send(endpoint, "login", loginRequest);
  const sessionId = String(login.session_id ?? "");
  const huid = String(login.user?.huid ?? login.huid ?? "");
  if (!sessionId || !huid) throw new Error("login 缺少 session_id/huid");
  const start = await send(endpoint, "start", {
    command: "start", request_id: requestId(), session_id: sessionId, mode: "play", huid,
  });
  let currentBalance = balance(start);
  const openingBalance = currentBalance;
  if (pauseBeforeRound > rounds) throw new Error("--pause-before-round 不能大于 --rounds");
  if (pauseBeforeSpinMs > 0 && pauseBeforeRound === 1) {
    // login/start 由入口层处理，管理后台此时可能仍把玩家视为离线；先发一次
    // 无副作用的 sync，让游戏进程建立玩家桌对象，后台“指定开奖结果”才能
    // 准确投递到当前游戏进程。
    const primed = await send(endpoint, "sync", {
      command: "sync", request_id: requestId(), session_id: sessionId, mode: "play", huid,
    });
    assertMoney(balance(primed), currentBalance, "定向验收预连接 sync 余额");
  }
  let totalBet = 0;
  let totalPayout = 0;
  let duplicateChecks = 0;
  let resumeChecks = 0;
  let specialRounds = 0;
  let framesChecked = 0;
  const coverage = new Set<string>();

  for (let round = 1; round <= rounds; round++) {
    if (pauseBeforeSpinMs > 0 && round === pauseBeforeRound) {
      console.log(`[pause] 第 ${round} 局前等待后台指定开奖结果 ${pauseBeforeSpinMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, pauseBeforeSpinMs));
    }
    const frames: JSONMap[] = [];
    let previousCumulative = 0;
    let action = "spin";
    let first = true;
    for (let step = 0; step < 100; step++) {
      const body: JSONMap = {
        command: "play", request_id: requestId(), session_id: sessionId,
        action: first
          ? { name: "spin", params: { bet_per_line: betPerLine, lines } }
          : { name: action, params: {} },
      };
      if (first) body.bet = bet;
      const response = await send(endpoint, "play", body);
      const cumulative = cumulativeWin(response);
      const payoutDelta = cumulative - previousCumulative;
      if (payoutDelta < 0) throw new Error(`第 ${round} 局第 ${step + 1} 帧累计赢分倒退`);
      const expectedBalance = currentBalance - (first ? bet : 0) + payoutDelta;
      assertMoney(balance(response), expectedBalance, `第 ${round} 局第 ${step + 1} 帧余额`);
      currentBalance = expectedBalance;
      previousCumulative = cumulative;
      frames.push(response);
      framesChecked++;

      const duplicate = await send(endpoint, "play", body);
      assertMoney(balance(duplicate), currentBalance, `第 ${round} 局第 ${step + 1} 帧重复请求余额`);
      if (stableFrame(duplicate) !== stableFrame(response)) {
        throw new Error(`第 ${round} 局第 ${step + 1} 帧重复请求没有返回同一结果`);
      }
      duplicateChecks++;

      const upcoming = nextAction(response);
      if (!upcoming) break;
      if (resumeChecks === 0) {
        const resumed = await send(endpoint, "sync", {
          command: "sync", request_id: requestId(), session_id: sessionId, mode: "play", huid,
        });
        assertMoney(balance(resumed), currentBalance, "特殊局 sync 恢复余额");
        if (String(resumed.context?.last_action) !== String(response.context?.last_action)) {
          throw new Error("sync 没有恢复到最后一个已完成帧");
        }
        resumeChecks++;
      }
      action = upcoming;
      first = false;
      if (step === 99) throw new Error(`第 ${round} 局超过 100 帧`);
    }
    const validation = validateRound(frames, bet);
    validation.features.forEach((feature) => coverage.add(feature));
    if (frames.length > 1) specialRounds++;
    totalBet += bet;
    totalPayout += validation.win;
    assertMoney(currentBalance, openingBalance - totalBet + totalPayout, `第 ${round} 局结束总账`);
    if (round % 10 === 0 || frames.length > 1) {
      console.log(`[${round}/${rounds}] frames=${frames.length} win=${validation.win} balance=${currentBalance} features=${validation.features.join(",")}`);
    }
  }

  if (expectedFeature && !coverage.has(expectedFeature)) {
    throw new Error(`定向验收未命中玩法 ${expectedFeature}，实际覆盖 ${[...coverage].sort().join(",")}`);
  }

  const summary = {
    valid: true, game, endpoint, bet, betPerLine, lines, rounds, framesChecked, duplicateChecks, resumeChecks, specialRounds,
    openingBalance, closingBalance: currentBalance, totalBet, totalPayout,
    expectedClosingBalance: openingBalance - totalBet + totalPayout,
    coverage: [...coverage].sort(), expectedFeature: expectedFeature || undefined, checkedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
