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

export function buildPlayableActions(start: JSONMap, shop: ShopInventory): PlayAction[] {
  const context = start.context ?? {};
  const state = context.current ? context[context.current] ?? {} : {};
  const betPerLine = Number(state.bet_per_line ?? 1);
  const lines = Number(state.lines ?? 1);
  const availableActions = new Set((Array.isArray(context.actions) ? context.actions : []).map(String));
  const actions: PlayAction[] = [];
  if (availableActions.has("spin")) actions.push({ name: "spin", params: { bet_per_line: betPerLine, lines } });
  if (availableActions.has("spin")) {
    for (const entry of shop.boosters) {
      actions.push({ name: "spin", params: { bet_per_line: betPerLine, lines, ante_bet: entry.price, selected_mode: entry.providerMode } });
    }
  }
  if (availableActions.has("buy_spin")) {
    for (const entry of shop.buyBonuses) {
      actions.push({
        name: "buy_spin",
        params: { bet_per_line: betPerLine, lines, selected_mode: entry.providerMode },
        spinType: entry.spinType,
      });
    }
  }
  return actions;
}
