import { readRegistry } from "./catalog-sync";
import { STATIC_TARGET } from "./config";
import { selectGames } from "./src/cli";
import { discoverGame } from "./src/game-definition";
import { downloadGameStatic } from "./src/static-downloader";

async function main(): Promise<void> {
  const selected = selectGames(process.argv.slice(2), await readRegistry());
  const failures: Array<{ slug: string; error: string }> = [];
  for (const [index, game] of selected.entries()) {
    try {
      const discovery = await discoverGame(game.slug);
      const report = await downloadGameStatic({ ...discovery, slug: game.slug, title: game.title }, STATIC_TARGET);
      console.log(`[resources ${index + 1}/${selected.length}] ${game.slug} ${report.downloaded}/${report.expected} failed=${report.failed.length} unavailable=${report.unavailableDeclaredResources.length}`);
      if (report.failed.length) failures.push({ slug: game.slug, error: `${report.failed.length} 个资源失败` });
    } catch (error) {
      failures.push({ slug: game.slug, error: (error as Error).message });
      console.warn(`[resources failed] ${game.slug}: ${(error as Error).message}`);
    }
  }
  console.log(JSON.stringify({ brand: "3 OAKS", completed: selected.length - failures.length, failed: failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
