import fs from "node:fs/promises";
import path from "node:path";
import { readRegistry } from "./catalog-sync";
import { STATIC_TARGET } from "./config";
import { RegistryGame } from "./src/catalog";
import { computeGameStatus, GamePathState, GameStatus } from "./src/status";

async function exists(target: string): Promise<boolean> {
  return Boolean(await fs.stat(target).catch(() => undefined));
}

function serviceName(game: RegistryGame): string {
  if (game.slug === "sun_of_egypt") return "oaks_SunOfEgypt";
  return `oaks_${game.slug.split("_").map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join("")}`;
}

async function pathState(game: RegistryGame): Promise<GamePathState> {
  const root = path.resolve(__dirname, "../../../oaksgames");
  const resourceAudit = await fs.readFile(path.join(STATIC_TARGET, game.slug, "resource-audit.json"), "utf8")
    .then((content) => JSON.parse(content).complete === true)
    .catch(() => false);
  return {
    serviceDirectory: await exists(path.join(root, serviceName(game))),
    staticDirectory: await exists(path.join(STATIC_TARGET, game.slug, "index.html")),
    captureFile: await exists(path.join(__dirname, "output", game.slug, `${game.slug}.ndjson`)),
    validationReport: await exists(path.join(__dirname, "output", game.slug, "validation-report.json")) ||
      await exists(path.join(__dirname, "seed-data", `${game.slug}-feature-report.json`)) ||
      (game.slug === "sun_of_egypt" && await exists(path.join(__dirname, "seed-data", "feature-report.json"))),
    resourceAudit,
  };
}

export async function buildStatusReport(): Promise<Record<string, unknown>> {
  const registry = await readRegistry();
  const games: GameStatus[] = [];
  for (const game of registry.games.filter((entry) => entry.active)) games.push(computeGameStatus(game, await pathState(game)));
  const count = (key: "discovered" | "resources" | "captured" | "validated" | "integrated") => games.filter((game) => game[key]).length;
  return {
    brand: "3 OAKS", generatedAt: new Date().toISOString(), total: games.length,
    discovered: count("discovered"), resources: count("resources"), captured: count("captured"),
    validated: count("validated"), integrated: count("integrated"), games,
  };
}

async function main(): Promise<void> {
  const report = await buildStatusReport();
  const output = path.join(__dirname, "output", "status.json");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  const { games: _games, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
