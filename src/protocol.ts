import crypto from "node:crypto";
import { REQUEST_TIMEOUT_MS } from "../config";
import { GameDiscovery } from "./catalog";
import { discoverGame, parsePlayConfig, resolveDemoEndpoint } from "./game-definition";
import type { PlayAction } from "./shop";

export type JSONMap = Record<string, any>;

export interface Session {
  endpoint: string;
  sessionId: string;
  huid: string;
  cookie: string;
  start: JSONMap;
  betPerLine: number;
  lines: number;
  defaultBet: number;
}

export class ProtocolHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "ProtocolHttpError";
  }
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

export interface SpinSettings {
  betPerLine: number;
  lines: number;
  defaultBet: number;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function sessionSpinSettings(start: JSONMap, fallback: SpinSettings): SpinSettings {
  const context = start?.context ?? {};
  const state = context.current ? context[context.current] ?? {} : {};
  const betPerLine = positiveNumber(state.bet_per_line, fallback.betPerLine);
  const lines = positiveNumber(state.lines, fallback.lines);
  return {
    betPerLine,
    lines,
    defaultBet: positiveNumber(state.round_bet, positiveNumber(fallback.defaultBet, betPerLine * lines)),
  };
}

export async function fetchText(url: string, headers: HeadersInit = {}): Promise<{ text: string; headers: Headers }> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return { text: await response.text(), headers: response.headers };
}

export { parsePlayConfig } from "./game-definition";

export async function openSession(game?: GameDiscovery): Promise<Session> {
  const definition = game ?? await discoverGame("sun_of_egypt");
  const page = await fetchText(definition.playUrl);
  const config = parsePlayConfig(page.text);
  const queue = String(config.options.queue);
  const token = String(config.options.token);
  const endpoint = resolveDemoEndpoint(String(config.desktop?.server_url ?? definition.serverTemplate), queue);
  const cookie = page.headers.get("set-cookie")?.split(",").map((v) => v.split(";")[0]).join("; ") ?? "";
  const login = await command(endpoint, cookie, "login", { token, language: "en" });
  const start = await command(endpoint, cookie, "start", { session_id: login.session_id, mode: "play", huid: login.user.huid });
  const settings = sessionSpinSettings(start, {
    betPerLine: definition.betPerLine,
    lines: definition.lines,
    defaultBet: definition.defaultBet,
  });
  return { endpoint, cookie, sessionId: login.session_id, huid: login.user.huid, start, ...settings };
}

export async function command(endpoint: string, cookie: string, name: string, extra: JSONMap): Promise<JSONMap> {
  // 与官方 Runner 保持一致，首帧和奖励续帧均携带相同的金额口径及运行参数。
  const playOptions = name === "play" ? {
    set_denominator: 1, quick_spin: false, sound: false, autogame: false,
    mobile: "0", portrait: false, fullscreen: false,
  } : {};
  const body = JSON.stringify({ command: name, request_id: crypto.randomUUID().replaceAll("-", ""), ...playOptions, ...extra });
  const response = await fetch(`${endpoint}?gsc=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "text/plain", ...(cookie ? { cookie } : {}) },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ProtocolHttpError(
      `${response.status} ${response.statusText}: ${name}`,
      response.status,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  const result = await response.json() as JSONMap;
  if (result.status?.code && result.status.code !== "OK") throw new Error(`${name}${extra.action?.name ? `/${extra.action.name}` : ""}: ${JSON.stringify(result.status)}`);
  return result;
}

export function nextAction(response: JSONMap): string | undefined {
  if (response.context?.round_finished) return undefined;
  const actions = Array.isArray(response.context?.actions) ? response.context.actions : [];
  return actions.find((name: unknown) => typeof name === "string" && name !== "spin");
}

export function roundWin(frames: JSONMap[]): number {
  // last_win 是“上一局赢分”，即使 round_finished=true 也可能仍是上一局值。
  // 当前局唯一可靠口径是最后一帧 context.current 指向状态里的 total_win。
  for (let index = frames.length - 1; index >= 0; index--) {
    const context = frames[index].context ?? {};
    const current = context.current && context[context.current];
    for (const value of [current?.total_win, current?.round_win, context.total_win, context.round_win]) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) return number;
    }
  }
  throw new Error("结果缺少当前局 total_win/round_win，禁止用 last_win 猜测结算");
}

export function frameCumulativeWin(frame: JSONMap): number {
  const context = frame.context ?? {};
  const current = context.current && context[context.current];
  for (const value of [current?.total_win, current?.round_win, context.total_win, context.round_win]) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  throw new Error("帧缺少当前玩法累计赢分");
}

export interface RoundValidation {
  win: number;
  cumulativeWins: number[];
  features: string[];
}

export const DIRECTED_TEST_FEATURES = [
  "free-retrigger",
  "hold-win-during-free-spins",
  "mini-jackpot",
  "major-jackpot",
  "grand-full-board",
] as const;

export function validateCommonRound(frames: JSONMap[], bet: number): RoundValidation {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error("结果帧为空");
  if (!Number.isFinite(bet) || bet <= 0) throw new Error(`非法采集下注: ${bet}`);

  const firstAction = String(frames[0]?.context?.last_action ?? "").toLowerCase();
  if (!["spin", "buy_spin"].includes(firstAction)) throw new Error(`首帧不是 spin/buy_spin: ${firstAction || "<empty>"}`);

  const cumulativeWins: number[] = [];
  let previous = 0;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (frame?.status?.code !== "OK") throw new Error(`第 ${index + 1} 帧状态异常`);
    const current = frameCumulativeWin(frame);
    if (current + 1e-9 < previous) {
      throw new Error(`第 ${index + 1} 帧累计赢分倒退: ${previous} -> ${current}`);
    }
    cumulativeWins.push(current);
    previous = current;

    if (index > 0) {
      const previousActions = Array.isArray(frames[index - 1]?.context?.actions)
        ? frames[index - 1].context.actions.map((value: unknown) => String(value).toLowerCase())
        : [];
      const actualAction = String(frame?.context?.last_action ?? "").toLowerCase();
      if (!previousActions.includes(actualAction)) {
        throw new Error(`第 ${index + 1} 帧动作 ${actualAction} 不在上一帧 actions=${previousActions.join(",")}`);
      }
    }
  }

  const last = frames.at(-1)?.context ?? {};
  if (last.round_finished !== true) throw new Error("末帧没有 round_finished=true");
  const actions = Array.isArray(last.actions) ? last.actions.map((value: unknown) => String(value).toLowerCase()) : [];
  if (!actions.includes("spin")) throw new Error("末帧没有恢复 spin 动作");

  return { win: roundWin(frames), cumulativeWins, features: classify(frames) };
}

export function actionFeatureKey(action: { name: string; params?: JSONMap }): string {
  if (action.name === "buy_spin") return `buy-bonus:${Number(action.params?.selected_mode ?? 0)}`;
  const booster = Number(action.params?.ante_bet ? action.params?.selected_mode : 0);
  if (action.name === "spin" && booster > 0) return `booster:${booster}`;
  return action.name;
}

export function protocolAction(action: PlayAction): { name: string; params: Record<string, number | string> } {
  return { name: action.name, params: action.params };
}

export const BOOSTER_SPIN_TYPE_OFFSET = 1000;

// Mongo 的 buy 字段也是核心选取结果池使用的 spinType。购买模式保留官方编号，
// booster 放入独立区间，避免与同编号的 buy_spin 冲突。
export function actionSpinType(action: { name: string; params?: JSONMap; spinType?: number }): number {
  if (Number.isInteger(action.spinType) && Number(action.spinType) > 0) return Number(action.spinType);
  const selectedMode = Number(action.params?.selected_mode ?? 0);
  if (!Number.isInteger(selectedMode) || selectedMode <= 0) return 0;
  if (action.name === "buy_spin") return selectedMode;
  if (action.name === "spin" && Number(action.params?.ante_bet ?? 0) > 0) return BOOSTER_SPIN_TYPE_OFFSET + selectedMode;
  return 0;
}

export function roundSpinType(frames: JSONMap[], fallback = 0): number {
  const context = frames[0]?.context ?? {};
  const name = String(context.last_action ?? "");
  const params = context.last_args && typeof context.last_args === "object" ? context.last_args as JSONMap : {};
  const providerMode = Number(params.selected_mode);
  if (name === "buy_spin" && Number.isInteger(fallback) && fallback > 0 &&
      (providerMode === 0 || fallback === providerMode + 1)) return fallback;
  const detected = actionSpinType({ name, params });
  if (detected > 0) return detected;
  if (name === "spin") return 0;
  return Number.isInteger(fallback) && fallback >= 0 ? fallback : 0;
}

export function validateSunJackpots(frames: JSONMap[], bet: number): void {
  for (let index = 0; index < frames.length; index++) {
    const bonus = frames[index].context?.bonus;
    if (!bonus || Number(bonus.rounds_left) !== 0 || !Array.isArray(bonus.bs_v)) continue;
    let expected = 0;
    for (const value of bonus.bs_v.flat(Infinity)) {
      if (typeof value === "number" && Number.isFinite(value)) expected += value;
      else if (String(value).toLowerCase() === "mini") expected += bet * 30;
      else if (String(value).toLowerCase() === "major") expected += bet * 150;
      else if (value !== null && value !== undefined && value !== "") throw new Error(`第 ${index + 1} 帧存在未知 jackpot 值: ${String(value)}`);
    }
    if (Number(bonus.bs_count) === 15) expected += bet * 1000;
    const actual = Number(bonus.round_win);
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-9) {
      throw new Error(`第 ${index + 1} 帧 Hold & Win 派奖不符: 实际 ${bonus.round_win}，规则应为 ${expected}`);
    }
  }
}

// 兼容既有 Sun of Egypt 导入、修复和验收工具。
export function validateRound(frames: JSONMap[], bet: number): RoundValidation {
  const result = validateCommonRound(frames, bet);
  validateSunJackpots(frames, bet);
  return result;
}

export function classify(frames: JSONMap[]): string[] {
  const text = JSON.stringify(frames).toLowerCase();
  const branches = new Set<string>(["base"]);
  for (const frame of frames) {
    const current = String(frame.context?.current ?? "").toLowerCase();
    const lastAction = String(frame.context?.last_action ?? "").toLowerCase();
    if (current) branches.add(current);
    if (lastAction) branches.add(lastAction);
  }
  if (text.includes("freespin")) branches.add("freespins");
  if (text.includes("respin")) branches.add("respins");
  const finalWin = (() => { try { return roundWin(frames); } catch { return 0; } })();
  branches.add(finalWin > 0 ? "base-or-feature-win" : "base-loss");

  let previousFreeGranted: number | undefined;
  let previousBonusLeft: number | undefined;
  for (const frame of frames) {
    const context = frame.context ?? {};
    const freeGranted = Number(context.freespins?.rounds_granted);
    if (Number.isFinite(freeGranted)) {
      if (previousFreeGranted !== undefined && freeGranted > previousFreeGranted) branches.add("free-retrigger");
      previousFreeGranted = freeGranted;
    }
    const bonus = context.bonus ?? {};
	if (String(bonus.back_to ?? "").toLowerCase() === "freespins") branches.add("hold-win-during-free-spins");
    // Mini/Major 文字也可能出现在未触发的普通 Sun 图标上。只有进入
    // 官方 Hold & Win 的 bonus 状态后，锁定盘面中的 jackpot 才算实际命中。
    const bonusValues = Array.isArray(bonus.bs_v) ? bonus.bs_v.flat(Infinity) : [];
    for (const value of bonusValues) {
      const jackpot = String(value).toLowerCase();
      if (jackpot === "mini") branches.add("mini-jackpot");
      if (jackpot === "major") branches.add("major-jackpot");
    }
    const bonusLeft = Number(bonus.rounds_left);
    if (Number.isFinite(bonusLeft)) {
      if (previousBonusLeft !== undefined && Array.isArray(bonus.new_bs) && bonus.new_bs.length > 0 && bonusLeft >= previousBonusLeft) {
        branches.add("hold-win-respin-reset");
      }
      previousBonusLeft = bonusLeft;
    }
    if (Number(bonus.bs_count) === 15) {
      branches.add("grand-full-board");
      branches.add("grand-jackpot");
    }
  }
  if (branches.has("freespins")) branches.add("free-spins");
  if (branches.has("respins")) branches.add("hold-and-win");
  return [...branches].sort();
}
