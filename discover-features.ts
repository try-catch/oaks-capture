import fs from "node:fs/promises";
import path from "node:path";
import { readRegistry } from "./catalog-sync";
import { STATIC_TARGET } from "./config";
import { selectGames } from "./src/cli";
import { discoverFeatureInventory } from "./src/features";
import { sanitizeProtocolData } from "./src/mongo-store";
import { openSession } from "./src/protocol";

async function main(): Promise<void> {
  const selected = selectGames(process.argv.slice(2), await readRegistry());
  const failures: Array<{ slug: string; error: string }> = [];
  for (const [index, game] of selected.entries()) {
    try {
      if (!game.discovery) throw new Error("缺少能力发现结果");
      const session = await openSession(game.discovery);
      const gameJs = path.join(STATIC_TARGET, new URL(game.discovery.clientUrl).pathname.replace(/^\/+/, ""), "src", "game.js");
      const clientTexts = await fs.readFile(gameJs, "utf8").catch(() => "");
      const inventory = discoverFeatureInventory(game.discovery, session.start, clientTexts);
      const outputDir = path.join(__dirname, "output", game.slug);
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, "feature-inventory.json"), `${JSON.stringify({ brand: "3 OAKS", gameId: game.gameId, slug: game.slug, generatedAt: new Date().toISOString(), ...inventory }, null, 2)}\n`);
      await fs.writeFile(path.join(outputDir, "start-template.json"), `${JSON.stringify(sanitizeProtocolData(session.start), null, 2)}\n`);
      console.log(`[features ${index + 1}/${selected.length}] ${game.slug} required=${inventory.required.join(",") || "none"}`);
    } catch (error) {
      failures.push({ slug: game.slug, error: (error as Error).message });
      console.warn(`[features failed] ${game.slug}: ${(error as Error).message}`);
    }
  }
  console.log(JSON.stringify({ brand: "3 OAKS", completed: selected.length - failures.length, failed: failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
