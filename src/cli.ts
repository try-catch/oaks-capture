import { OaksRegistry, RegistryGame } from "./catalog";

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function selectGames(args: string[], registry: OaksRegistry): RegistryGame[] {
  const active = registry.games.filter((game) => game.active);
  if (args.includes("--all")) return active;
  const slug = value(args, "--game") ?? "sun_of_egypt";
  const game = registry.games.find((candidate) => candidate.slug === slug && candidate.active);
  if (!game) throw new Error(`3 OAKS 注册表中不存在启用游戏: ${slug}`);
  return [game];
}

export function stringOption(args: string[], name: string, fallback: string): string {
  return value(args, name) ?? fallback;
}

export function numberOption(args: string[], name: string, fallback: number): number {
  const raw = value(args, name);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`参数 ${name} 非法: ${raw}`);
  return parsed;
}
