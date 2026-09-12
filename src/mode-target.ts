import type { RegistryGame } from "./catalog";
import { roundSpinType } from "./protocol";

export interface ModeQuota {
  counts: Record<number, number>;
  targets: Record<number, number>;
  missing: number[];
}

export function declaredModeTypes(game: RegistryGame): number[] {
  if (!game.discovery) throw new Error(`${game.slug} 缺少已核实的官方能力定义`);
  const settings = game.discovery.settings;
  const buys = settings.buyModes?.length
    ? settings.buyModes.map((mode) => mode.spinType)
    : Object.keys(settings.buyBonusPrices ?? {}).map(Number);
  const boosters = Object.keys(settings.boosterPrices ?? {}).map((mode) => 1000 + Number(mode));
  return [...new Set([0, ...buys, ...boosters])]
    .filter((mode) => Number.isInteger(mode) && mode >= 0)
    .sort((left, right) => left - right);
}

export function auditModeQuota(
  game: RegistryGame,
  documents: Array<Record<string, any>>,
  normalTarget: number,
  specialTarget: number,
): ModeQuota {
  const types = declaredModeTypes(game);
  const targets = Object.fromEntries(types.map((type) => [type, type === 0 ? normalTarget : specialTarget]));
  const counts: Record<number, number> = Object.fromEntries(types.map((type) => [type, 0]));
  for (const document of documents) {
    if (document.testOnly === true || !Array.isArray(document.data)) continue;
    const type = roundSpinType(document.data, Number(document.buy ?? 0));
    if (type in counts) counts[type] += 1;
  }
  return { counts, targets, missing: types.filter((type) => counts[type] < targets[type]) };
}
