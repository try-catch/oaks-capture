import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { readRegistry } from "./catalog-sync";
import { STATIC_TARGET } from "./config";
import { selectGames } from "./src/cli";
import { captureNetworkMatrix, NetworkMatrixReport } from "./src/network-matrix";
import { crawlResourceGraph } from "./src/resource-graph";
import { partitionResourceFailures } from "./src/static-downloader";

async function atomicJSON(filename: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.part-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filename);
}

async function main(): Promise<void> {
  const selected = selectGames(process.argv.slice(2), await readRegistry());
  const mirrorOnly = process.argv.includes("--mirror-only");
  const gameConcurrency = Math.max(1, Math.min(4, Number(process.env.OAKS_NETWORK_GAME_CONCURRENCY ?? 2) || 1));
  const browser = mirrorOnly ? undefined : await chromium.launch({ headless: true }).catch(async (bundledError: Error) => {
      try {
        return await chromium.launch({ headless: true, channel: "chrome" });
      } catch (chromeError) {
        throw new Error(`无法启动 Playwright Chromium 或系统 Chrome: ${bundledError.message}; ${(chromeError as Error).message}`);
      }
    });
  const failures: Array<{ slug: string; error: string }> = [];
  let completed = 0;
  const processGame = async (game: (typeof selected)[number]): Promise<void> => {
    try {
      const reportPath = path.join(STATIC_TARGET, game.slug, "network-matrix.json");
      const report: NetworkMatrixReport = mirrorOnly
        ? JSON.parse(await fs.readFile(reportPath, "utf8")) as NetworkMatrixReport
        : await captureNetworkMatrix(game, browser!);
      const graph = await crawlResourceGraph(report.resources.map((item) => new URL(item.url)), fetch, {
        concurrency: 8,
        allowedHosts: new Set(["static.3oaks.com"]),
        target: STATIC_TARGET,
      });
      const mirrorFailures = partitionResourceFailures(graph.failed);
      const result = { ...report, mirror: { downloaded: graph.files.length, ...mirrorFailures } };
      await atomicJSON(reportPath, result);
      completed++;
      console.log(`[network ${completed}/${selected.length}] ${game.slug} runs=${report.runs.length} resources=${report.resources.length} failed=${report.failed.length + mirrorFailures.failed.length} unavailable=${mirrorFailures.unavailableDeclaredResources.length}`);
      if (report.failed.length || mirrorFailures.failed.length) failures.push({ slug: game.slug, error: `${report.failed.length + mirrorFailures.failed.length} 个请求失败` });
    } catch (error) {
      completed++;
      failures.push({ slug: game.slug, error: (error as Error).message });
      console.warn(`[network failed ${completed}/${selected.length}] ${game.slug}: ${(error as Error).message}`);
    }
  };
  try {
    for (let start = 0; start < selected.length; start += gameConcurrency) {
      await Promise.all(selected.slice(start, start + gameConcurrency).map(processGame));
    }
  } finally {
    await browser?.close();
  }
  console.log(JSON.stringify({ brand: "3 OAKS", completed: selected.length - failures.length, failed: failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
