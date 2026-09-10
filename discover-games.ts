import { readRegistry, writeRegistry } from "./catalog-sync";
import { discoverGame } from "./src/game-definition";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const registry = await readRegistry();
  const requested = argument("--game");
  const selected = requested
    ? registry.games.filter((game) => game.slug === requested)
    : process.argv.includes("--all")
      ? registry.games.filter((game) => game.active)
      : registry.games.filter((game) => game.slug === "sun_of_egypt");
  if (!selected.length) throw new Error(`没有找到要发现的 3 OAKS 游戏: ${requested ?? ""}`);

  const failures: Array<{ slug: string; error: string }> = [];
  for (const [index, game] of selected.entries()) {
    try {
      game.discovery = await discoverGame(game.slug);
      await writeRegistry(registry);
      console.log(`[discover ${index + 1}/${selected.length}] ${game.slug} ${game.discovery.clientFamily}/${game.discovery.clientVersion}`);
    } catch (error) {
      failures.push({ slug: game.slug, error: (error as Error).message });
      console.warn(`[discover failed] ${game.slug}: ${(error as Error).message}`);
    }
  }
  console.log(JSON.stringify({ brand: "3 OAKS", discovered: selected.length - failures.length, failed: failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
