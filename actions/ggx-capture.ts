// goldengatex 对照测试入口：不走协调器（不 begin/claim/permit，不占用生产配额与租约），
// 单线程串行采集；数据写入隔离库（OAKS_MONGO_DB，默认 oaks_ggx_test），文档自带
// source=goldengatex 试玩页地址，验证兼容后再决定是否并入生产采集。
// 安全门禁与真实采集一致：仅 GitHub-hosted Linux Runner、禁止出口代理、需服务商授权变量。
// 每个游戏派生独立子进程：oaks.ts 的命令行参数在模块加载时求值，且单游戏故障
// 不应拖垮整个对照测试。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { MongoClient } from "mongodb";
import { MONGO_COLLECTION } from "../config";
import { ggxPlayPageUrl } from "../src/ggx-launch";
import type { RegistryGame } from "../src/catalog";

const root = path.resolve(__dirname, "..");

function requireGithubHosted(): void {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || process.platform !== "linux") {
    throw new Error("ggx 对照测试仅允许在 GitHub-hosted Linux Runner 执行");
  }
  if (["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some(key => process.env[key])) {
    throw new Error("采集 Runner 不允许配置出口代理");
  }
}

function requireProviderAuthorization(): void {
  if (process.env.OAKS_PROVIDER_AUTHORIZED !== "true") {
    throw new Error("真实采集需要服务商书面授权并设置 OAKS_PROVIDER_AUTHORIZED=true");
  }
}

interface SpecEntry { slug: string; modes: number[] }

// OAKS_GGX_SPEC="china_festival:1,3_hot_chillies:1,coin_volcano:1,2"
export function parseSpec(value: string): SpecEntry[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [slug, modes] = part.split(":");
    const parsed = (modes ?? "").split("/").join(",").split(",").map(Number)
      .filter((mode) => Number.isInteger(mode) && mode > 0);
    if (!slug || !parsed.length) throw new Error(`OAKS_GGX_SPEC 条目无效: ${part}`);
    return { slug, modes: parsed };
  });
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, "<url>").slice(0, 160);
}

// 游戏:模式条目的模式必须是 registry 声明的购买模式，避免把会话缺失的模式当目标。
// registry 的 settings.buyModes 常缺失，此时从 buyBonusPrices 键取模式号（同 oaks.ts 口径）。
function declaredModes(game: RegistryGame): number[] {
  const settings = game.discovery?.settings as Record<string, unknown> | undefined;
  const buyModes = settings?.buyModes as Array<{ spinType?: number }> | undefined;
  const spinTypes = Array.isArray(buyModes) && buyModes.length
    ? buyModes.map((mode) => Number(mode.spinType))
    : Object.keys((settings?.buyBonusPrices as Record<string, unknown> | undefined) ?? {}).map(Number);
  return spinTypes.filter((mode) => Number.isInteger(mode) && Number(mode) > 0);
}

async function main(): Promise<void> {
  requireGithubHosted();
  requireProviderAuthorization();
  if (!process.env.OAKS_MONGO_URI) throw new Error("缺少受控 Mongo 连接");
  process.env.OAKS_TEST_MONGO_URI = process.env.OAKS_MONGO_URI;
  const spec = parseSpec(process.env.OAKS_GGX_SPEC ?? "");
  const roundsPerGame = Math.max(1, Number(process.env.OAKS_GGX_ROUNDS ?? 25));
  const budgetMs = Math.max(5, Number(process.env.OAKS_GGX_MINUTES ?? 35)) * 60_000;
  const startedAt = Date.now();
  // ggx 全部令牌共享一个全局演示会话：整个测试只允许单线程串行，不得并发。
  const { readRegistry } = await import("../catalog-sync");
  const registry = await readRegistry();
  const summary: Record<string, unknown>[] = [];
  const mongo = new MongoClient(process.env.OAKS_MONGO_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 1 });
  try {
  await mongo.connect();
  const collection = mongo.db(process.env.OAKS_MONGO_DB ?? "oaks_ggx_test").collection(MONGO_COLLECTION);
  const before = await collection.countDocuments();
  for (const { slug, modes } of spec) {
    if (Date.now() - startedAt > budgetMs) {
      console.log(JSON.stringify({ phase: "budget-stop", note: "总时长预算耗尽，跳过剩余游戏" }));
      break;
    }
    const game = registry.games.find((candidate) => candidate.slug === slug);
    if (!game?.discovery) {
      console.log(JSON.stringify({ phase: "game-skip", slug, reason: "REGISTRY_MISSING" }));
      continue;
    }
    const available = declaredModes(game);
    const wanted = modes.filter((mode) => available.includes(mode));
    if (!wanted.length) {
      console.log(JSON.stringify({ phase: "game-skip", slug, reason: "MODES_NOT_DECLARED", declared: available }));
      continue;
    }
    // 可用性预检：目录缺失或站点不可达直接跳过，不拖垮其余游戏。
    let playUrl: string;
    try { playUrl = ggxPlayPageUrl(slug); }
    catch (error) {
      console.log(JSON.stringify({ phase: "game-skip", slug, reason: reasonOf(error) }));
      continue;
    }
    const gameStartedAt = new Date().toISOString();
    const startedMs = Date.now();
    // playUrl 经环境变量传入子进程：子进程内 oaks.ts 把 definition.playUrl 指向试玩页，
    // 每次重新登录都会重新铸造令牌并刷新测试余额。
    const result = spawnSync(process.execPath, ["-r", "ts-node/register", "oaks.ts",
      "--game", slug, "--rounds", String(roundsPerGame),
      "--normal-rounds", "0", "--target-per-mode", "10000", "--mode-types", wanted.join(",")], {
      cwd: root,
      stdio: "inherit",
      timeout: Math.max(60_000, budgetMs - (Date.now() - startedAt)),
      env: { ...process.env, OAKS_SOURCE: "ggx", OAKS_GGX_PLAY_URL: playUrl },
    });
    const outcome = result.status === 0 ? "ok"
      : result.status === 1 ? "rounds-budget-or-failed"
      : `exit-${result.status}`;
    summary.push({ slug, modes: wanted, outcome, startedAt: gameStartedAt, seconds: Math.round((Date.now() - startedMs) / 1000) });
    console.log(JSON.stringify({ phase: "game-done", slug, outcome, status: result.status }));
  }
  const inserted = await collection.countDocuments() - before;
  console.log(JSON.stringify({ phase: "ggx-test-complete", database: process.env.OAKS_MONGO_DB ?? "oaks_ggx_test", inserted, summary }));
  if (inserted <= 0) throw new Error("GGX_NO_NEW_MONGO_ROUNDS");
  } finally { await mongo.close(); }
}

main().catch((error) => {
  console.error(JSON.stringify({ phase: "ggx-test-abort", reason: reasonOf(error) }));
  process.exitCode = 1;
});
