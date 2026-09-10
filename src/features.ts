import type { GameCapabilities } from "./catalog";
import type { JSONMap } from "./protocol";
import { discoverShop } from "./shop";

export interface FeatureEvidence {
  name: string;
  frameIndexes: number[];
  statePaths: string[];
  summaries: string[];
}

export interface FeatureInventory {
  schemaVersion: number;
  buyModesFingerprint: string;
  declared: string[];
  playable: string[];
  observed: string[];
  required: string[];
}

export const INVENTORY_SCHEMA_VERSION = 2;

function addEvidence(
  result: Map<string, FeatureEvidence>,
  name: string,
  frameIndex: number,
  statePath: string,
  summary: string,
): void {
  const evidence = result.get(name) ?? { name, frameIndexes: [], statePaths: [], summaries: [] };
  if (!evidence.frameIndexes.includes(frameIndex)) evidence.frameIndexes.push(frameIndex);
  if (!evidence.statePaths.includes(statePath)) evidence.statePaths.push(statePath);
  if (!evidence.summaries.includes(summary)) evidence.summaries.push(summary);
  result.set(name, evidence);
}

function jackpotNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flat(Infinity).map(String).map((item) => item.toLowerCase()).filter((item) => ["mini", "minor", "major", "grand", "royal"].includes(item));
  if (!value || typeof value !== "object") return [];
  return [...Object.keys(value as object), ...Object.values(value as object).map(String)]
    .map((item) => item.toLowerCase())
    .filter((item) => ["mini", "minor", "major", "grand", "royal"].includes(item));
}

export function classifyRound(frames: JSONMap[]): FeatureEvidence[] {
  const result = new Map<string, FeatureEvidence>();
  let priorFreeGranted: number | undefined;
  for (const [index, frame] of frames.entries()) {
    const context = frame.context ?? {};
    const current = String(context.current ?? "").toLowerCase();
    const lastAction = String(context.last_action ?? "").toLowerCase();
    if (current.includes("free") || context.freespins || context.free_spins) {
      addEvidence(result, "free-spins", index, `data.${index}.context.${current || "freespins"}`, "进入免费旋转状态");
    }
    if (current.includes("respin") || context.respins) {
      addEvidence(result, "respin", index, `data.${index}.context.${current || "respins"}`, "进入重转状态");
    }
    if (current.includes("bonus") || context.bonus) {
      addEvidence(result, "hold-and-win", index, `data.${index}.context.${current || "bonus"}`, "进入 bonus/锁定重转状态");
    }
    if (current.includes("wheel") || context.wheel) {
      addEvidence(result, "wheel", index, `data.${index}.context.${current || "wheel"}`, "进入转盘状态");
    }
    if (index === 0 && lastAction === "buy_spin") {
      addEvidence(result, "bonus-buy", index, `data.${index}.context.last_action`, "官方 buy_spin 动作已执行");
      const selectedMode = Number(context.last_args?.selected_mode);
      if (Number.isInteger(selectedMode) && selectedMode >= 0) {
        addEvidence(result, `buy-bonus:${selectedMode}`, index, `data.${index}.context.last_args.selected_mode`, `购买模式 ${selectedMode}`);
      }
    }
    const freeGranted = Number(context.freespins?.rounds_granted ?? context.free_spins?.rounds_granted);
    if (Number.isFinite(freeGranted)) {
      if (priorFreeGranted !== undefined && freeGranted > priorFreeGranted) {
        addEvidence(result, "free-retrigger", index, `data.${index}.context.freespins.rounds_granted`, "免费旋转次数增加");
      }
      priorFreeGranted = freeGranted;
    }
    const bonus = context.bonus ?? {};
    for (const jackpot of jackpotNames(bonus.bs_v)) {
      addEvidence(result, `jackpot:${jackpot}`, index, `data.${index}.context.bonus.bs_v`, `bonus 盘面命中 ${jackpot}`);
    }
    const wheelValues = [context.wheel?.result, context.wheel?.value, context[current]?.wheel_result].filter((value) => value !== undefined);
    for (const value of wheelValues) addEvidence(result, `wheel:${String(value).toLowerCase()}`, index, `data.${index}.context.wheel`, `转盘结果 ${String(value)}`);
    const boosterMode = Number(index === 0 && lastAction === "spin" && context.last_args?.ante_bet ? context.last_args?.selected_mode : 0);
    if (Number.isInteger(boosterMode) && boosterMode > 0) {
      addEvidence(result, `booster:${boosterMode}`, index, `data.${index}.context.last_args.booster_mode`, `增强模式 ${boosterMode}`);
    }
  }
  return [...result.values()].map((entry) => ({
    ...entry,
    frameIndexes: entry.frameIndexes.sort((a, b) => a - b),
    statePaths: entry.statePaths.sort(),
    summaries: entry.summaries.sort(),
  })).sort((left, right) => left.name.localeCompare(right.name));
}

export function featureNames(frames: JSONMap[]): string[] {
  return classifyRound(frames).map((item) => item.name);
}

export function discoverFeatureInventory(capabilities: GameCapabilities, start: JSONMap, clientTexts = ""): FeatureInventory {
  const declared = new Set(capabilities.featureHints);
  const playable = new Set<string>();
  const settings = start.settings ?? {};
  const context = start.context ?? {};
  const shop = discoverShop(start);
  if (Array.isArray(context.actions) && context.actions.includes("spin")) playable.add("base");
  if (Number(settings.respins_granted) > 0) {
    declared.add("hold-and-win");
    declared.add("respin");
  }
  if (settings.fs_retrigger || /free[_ -]?spin/i.test(clientTexts)) declared.add("free-spins");
  if (settings.fs_retrigger || /retrigger/i.test(clientTexts)) declared.add("free-retrigger");
  for (const jackpot of jackpotNames(settings.jackpots ?? settings.bonus_symbols)) declared.add(`jackpot:${jackpot}`);
  if (Array.isArray(settings.wheel_values)) {
    declared.add("wheel");
    for (const value of settings.wheel_values) declared.add(`wheel:${String(value).toLowerCase()}`);
  }
  for (const entry of shop.buyBonuses) {
    declared.add("bonus-buy");
    declared.add(entry.feature);
    if (Array.isArray(context.actions) && context.actions.includes("buy_spin")) playable.add(entry.feature);
  }
  for (const entry of shop.boosters) {
    declared.add("booster");
    declared.add(entry.feature);
  }
  const terminals = [...declared].filter((feature) => {
    if (feature === "jackpot") return ![...declared].some((item) => item.startsWith("jackpot:"));
    if (feature === "bonus-buy") return false;
    if (feature === "booster") return ![...declared].some((item) => item.startsWith("booster:"));
    if (feature === "wheel") return ![...declared].some((item) => item.startsWith("wheel:"));
    return true;
  });
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    buyModesFingerprint: shop.buyBonuses
      .map((mode) => `${mode.providerMode}:${mode.spinType}:${mode.price}`)
      .join("|"),
    declared: [...declared].sort(),
    playable: [...playable].sort(),
    observed: [],
    required: [...new Set([...terminals, ...playable].filter((feature) => feature !== "base"))].sort(),
  };
}
