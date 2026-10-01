import type { JSONMap } from "./protocol";
import { parseBuyModes } from "./game-definition";

export interface ShopEntry {
  providerMode: number;
  spinType?: number;
  price: number;
  feature: string;
}

export interface ShopInventory {
  buyBonuses: ShopEntry[];
  boosters: ShopEntry[];
}

export interface PlayAction {
  name: string;
  params: Record<string, number | string>;
  spinType?: number;
}

function entries(value: unknown, prefix: string): ShopEntry[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .map(([id, price]) => ({ providerMode: Number(id), price: Number(price), feature: `${prefix}:${id}` }))
    .filter((entry) => Number.isInteger(entry.providerMode) && entry.providerMode > 0 && Number.isFinite(entry.price) && entry.price > 0)
    .sort((left, right) => left.providerMode - right.providerMode);
}

export function discoverShop(start: JSONMap): ShopInventory {
  const settings = start.settings ?? {};
  const available = new Set((Array.isArray(start.context?.available_buy_bonus) ? start.context.available_buy_bonus : [])
    .map(Number).filter((mode: number) => Number.isInteger(mode) && mode >= 0));
  const buyBonuses = parseBuyModes(settings)
    .filter((entry) => available.size === 0 || available.has(entry.providerMode))
    .map((entry) => ({
      providerMode: entry.providerMode,
      spinType: entry.spinType,
      price: entry.price,
      feature: `buy-bonus:${entry.providerMode}`,
    }));
  return {
    buyBonuses,
    boosters: entries(settings.booster_prices, "booster"),
  };
}

// 金额、线数和计费倍数均从会话允许列表取最低正数，不依赖列表排序。
function minimumAllowed(value: unknown, fallback: number): number {
  const values = (Array.isArray(value) ? value : [value]).map(Number).filter(v => Number.isFinite(v) && v > 0);
  return values.length ? Math.min(...values) : fallback;
}

// ggx 只补会话声明的计费倍数，保留 buildPlayableActions 选出的合法最低投注。
// 不能为迁就试玩余额而使用 bets 之外的 1，否则服务端返回 CLIENT_ERROR。
export function applyGgxSpinParams(actions: PlayAction[], betFactor: unknown): PlayAction[] {
  const factor = minimumAllowed(betFactor, NaN);
  return actions.map((action) => action.name === "buy_spin" && Number.isFinite(factor) && factor > 0
    ? { ...action, params: { ...action.params, bet_factor: factor } }
    : action);
}

export function buildPlayableActions(start: JSONMap, shop: ShopInventory, clientFamily?: string, omitBuyFactor = new Set<number>(), stringBuyMode = new Set<number>()): PlayAction[] {
  const context = start.context ?? {};
  const state = context.current ? context[context.current] ?? {} : {};
  // 普通、加注和购买统一使用最低合法投注与最低可选线数。
  const betPerLine = minimumAllowed(start.settings?.bets, Number(state.bet_per_line ?? 1));
  const lines = minimumAllowed(start.settings?.lines, Number(state.lines ?? 1));
  // 官方客户端购买请求会单独传 bet_factor；部分游戏的计费倍数不等于线数。
  // Kendoo 的购买入口直接调用 sendPlayAsync，官方请求不包含 bet_factor。
  const betFactor = minimumAllowed(start.settings?.bet_factor, NaN);
  const betParams = { bet_per_line: betPerLine, lines };
  const availableActions = new Set((Array.isArray(context.actions) ? context.actions : []).map(String));
  const actions: PlayAction[] = [];
  if (availableActions.has("spin")) actions.push({ name: "spin", params: { ...betParams } });
  if (availableActions.has("spin")) {
    for (const entry of shop.boosters) {
      actions.push({ name: "spin", params: { ...betParams, ante_bet: entry.price, selected_mode: entry.providerMode } });
    }
  }
  if (availableActions.has("buy_spin")) {
    for (const entry of shop.buyBonuses) {
      actions.push({
        name: "buy_spin",
        params: { ...betParams, ...(clientFamily !== "clients_kendoo" && (entry.spinType === undefined || !omitBuyFactor.has(entry.spinType)) && Number.isFinite(betFactor) && betFactor > 0 ? { bet_factor: betFactor } : {}), selected_mode: Array.isArray(start.settings?.buy_bonus_price) || (entry.spinType !== undefined && stringBuyMode.has(entry.spinType)) ? entry.providerMode.toString() : entry.providerMode },
        spinType: entry.spinType,
      });
    }
  }
  return actions;
}
