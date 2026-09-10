import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readRegistry, writeRegistry } from "./catalog-sync";
import { GAME_SWITCH_DELAY_MS, STATIC_TARGET } from "./config";
import { numberOption, selectGames, stringOption } from "./src/cli";
import { discoverGame } from "./src/game-definition";
import { downloadGameStatic } from "./src/static-downloader";
import { auditGameResources } from "./audit-resources";

type Stage = "discover" | "resources" | "network" | "resource-audit" | "capture" | "validate";
const args = process.argv.slice(2);

async function atomicJSON(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, target);
}

function runTool(script: string, game: string, extraArgs: string[] = []): void {
  const result = spawnSync(process.execPath, ["-r", "ts-node/register", path.join(__dirname, script), "--game", game, ...extraArgs], {
    cwd: __dirname, stdio: "inherit", env: process.env,
  });
  if (result.status !== 0) throw new Error(`${script} 退出码 ${result.status}`);
}

async function main(): Promise<void> {
  const stage = stringOption(args, "--stage", "discover") as Stage;
  if (!["discover", "resources", "network", "resource-audit", "capture", "validate"].includes(stage)) throw new Error(`不支持的阶段: ${stage}`);
  const registry = await readRegistry();
  let games = selectGames(args.includes("--game") ? args : [...args, "--all"], registry);
  const start = stringOption(args, "--start", "");
  if (start) {
    const index = games.findIndex((game) => game.slug === start);
    if (index < 0) throw new Error(`--start 不在选择范围内: ${start}`);
    games = games.slice(index);
  }
  const limit = numberOption(args, "--limit", games.length);
  games = games.slice(0, limit);
  const continueOnFailure = args.includes("--continue-on-failure");
  const reportPath = path.join(__dirname, "output", "batch-status.json");
  const report = { brand: "3 OAKS", stage, startedAt: new Date().toISOString(), completed: [] as string[], failed: [] as Array<{ slug: string; error: string }>, nextStart: "" };

  for (const [index, game] of games.entries()) {
    try {
      if (stage === "discover") {
        game.discovery = await discoverGame(game.slug);
        await writeRegistry(registry);
      } else if (stage === "resources") {
        const discovery = game.discovery ?? await discoverGame(game.slug);
        const result = await downloadGameStatic({ ...discovery, slug: game.slug, title: game.title }, STATIC_TARGET);
        if (result.failed.length) throw new Error(`${result.failed.length} 个必需资源下载失败`);
      } else if (stage === "network") runTool("capture-network.ts", game.slug);
      else if (stage === "resource-audit") {
        const result = await auditGameResources(game);
        if (!result.complete) throw new Error("资源门禁未通过");
      } else if (stage === "capture") {
        const captureArgs = ["--target-per-feature", String(numberOption(args, "--target-per-feature", 10))];
        if (args.includes("--rounds")) captureArgs.push("--rounds", String(numberOption(args, "--rounds", 1_000_000)));
        runTool("oaks.ts", game.slug, captureArgs);
      }
      else runTool("validate-data.ts", game.slug, [
        "--file", path.join("output", game.slug, `${game.slug}.ndjson`),
        "--report", path.join("output", game.slug, "validation-report.json"),
        "--target-per-feature", String(numberOption(args, "--target-per-feature", 10)),
      ]);
      report.completed.push(game.slug);
      console.log(`[batch ${stage} ${index + 1}/${games.length}] ${game.slug} 完成`);
    } catch (error) {
      report.failed.push({ slug: game.slug, error: (error as Error).message });
      report.nextStart = game.slug;
      await atomicJSON(reportPath, { ...report, updatedAt: new Date().toISOString() });
      if (!continueOnFailure) {
        console.error(`[batch ${stage}] ${game.slug} 失败，下次使用 --start ${game.slug}`);
        process.exitCode = 1;
        return;
      }
      console.error(`[batch ${stage}] ${game.slug} 未完成，已保存恢复点并继续下一款`);
    }
    await atomicJSON(reportPath, { ...report, updatedAt: new Date().toISOString() });
    if (stage === "capture" && index + 1 < games.length && GAME_SWITCH_DELAY_MS > 0) {
      console.log(`[batch capture] 下一款将在 ${GAME_SWITCH_DELAY_MS / 1000} 秒后开始`);
      await new Promise((resolve) => setTimeout(resolve, GAME_SWITCH_DELAY_MS));
    }
  }
  await atomicJSON(reportPath, { ...report, endedAt: new Date().toISOString() });
  if (report.failed.length) process.exitCode = 1;
  console.log(`3 OAKS 批次完成：stage=${stage} completed=${report.completed.length} failed=${report.failed.length}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
