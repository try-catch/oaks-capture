import { spawnSync } from "node:child_process";
import path from "node:path";
import { readRegistry } from "./catalog-sync";
import { numberOption, selectGames, stringOption } from "./src/cli";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const games = selectGames(args, await readRegistry());
  const api = stringOption(args, "--api", "https://api.oaks-test.com");
  const token = stringOption(args, "--token", process.env.OAKS_AUDIT_TOKEN ?? "");
  if (!token) throw new Error("请通过 --token 或 OAKS_AUDIT_TOKEN 提供临时测试 token");
  const rounds = numberOption(args, "--rounds", 2);
  const profiles = stringOption(args, "--profiles", "desktop,mobile").split(",").map((item) => item.trim()).filter(Boolean);
  const completed: Array<{ slug: string; profile: string }> = [];
  for (const game of games) {
    if (!game.discovery) throw new Error(`${game.slug} 缺少 discovery`);
    for (const profile of profiles) {
      const output = path.join("output", game.slug, `local-audit-${profile}.json`);
      const child = spawnSync(process.execPath, ["-r", "ts-node/register", path.join(__dirname, "audit-local.ts"),
        "--api", api, "--token", token, "--game", game.slug, "--rounds", String(rounds),
        "--bet", String(game.discovery.defaultBet), "--bet-per-line", String(game.discovery.betPerLine),
        "--lines", String(game.discovery.lines), "--output", output], { cwd: __dirname, stdio: "inherit" });
      if (child.status !== 0) throw new Error(`${game.slug}/${profile} 协议验收失败，退出码 ${child.status}`);
      completed.push({ slug: game.slug, profile });
      console.log(`[local audit ${completed.length}/${games.length * profiles.length}] ${game.slug}/${profile}`);
    }
  }
  console.log(JSON.stringify({ brand: "3 OAKS", games: games.length, profiles, completed: completed.length }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
