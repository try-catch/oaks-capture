import fs from "node:fs/promises";
import path from "node:path";
import { emptyRegistry, fetchOfficialCatalog, OaksRegistry, syncCatalog } from "./src/catalog";

export const REGISTRY_PATH = path.resolve(__dirname, "games/registry.json");

export async function readRegistry(): Promise<OaksRegistry> {
  try {
    return JSON.parse(await fs.readFile(REGISTRY_PATH, "utf8")) as OaksRegistry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw error;
  }
}

export async function writeRegistry(registry: OaksRegistry): Promise<void> {
  await fs.mkdir(path.dirname(REGISTRY_PATH), { recursive: true });
  const temporary = `${REGISTRY_PATH}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`);
  await fs.rename(temporary, REGISTRY_PATH);
}

async function main(): Promise<void> {
  const current = await readRegistry();
  const official = await fetchOfficialCatalog();
  const next = syncCatalog(current, official);
  await writeRegistry(next);
  const active = next.games.filter((game) => game.active);
  const sun = active.find((game) => game.slug === "sun_of_egypt");
  console.log(`3 OAKS 官方目录同步完成：active=${active.length} total=${next.games.length} Sun of Egypt=${sun?.gameId ?? "missing"}`);
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
