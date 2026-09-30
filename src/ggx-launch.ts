// goldengatex 对照测试源的启动链路（2026-09-30 实机核实）：
//   1. 试玩页 /mobile/index/play/id/<id>.html 每次铸造一枚一次性令牌；
//   2. 页面内嵌 game_start.do?gameCode=<官方slug>&token=<令牌> 跳转地址；
//   3. game_start.do 的 launcher 配置含完整协议端点 desktop.server_url（令牌嵌入路径）。
// 该源为纯测试环境：登录返回固定试玩余额（约 100 PHP），新令牌重新登录即刷新；
// 全部令牌共享一个全局演示会话，采集必须单线程串行，不得并发。
// 与 wx 源不同：game_start.do 可直接 fetch（实测无浏览器挑战），无需 Playwright。
import fs from "node:fs";
import path from "node:path";

export const GGX_SITE = "https://www.goldengatex.cc";
export const GGX_LAUNCH_HOST = "three-oaks.thefanz.net";
const GGX_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";

interface GgxCatalogEntry { playId: number }
interface GgxCatalogFile { games: Record<string, GgxCatalogEntry> }

export function readGgxCatalog(): Record<string, GgxCatalogEntry> {
  const file = path.resolve(__dirname, "../games/ggx-catalog.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as GgxCatalogFile;
  return parsed.games ?? {};
}

export function isGgxLaunchUrl(value: string, slug: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === GGX_LAUNCH_HOST &&
      url.pathname === "/game_start.do" && url.searchParams.get("gameCode") === slug &&
      /^[0-9a-f]{32}$/.test(String(url.searchParams.get("token") ?? ""));
  } catch {
    return false;
  }
}

export function ggxPlayPageUrl(slug: string): string {
  const entry = readGgxCatalog()[slug];
  if (!entry?.playId) throw new Error("GGX_GAME_UNKNOWN");
  return `${GGX_SITE}/mobile/index/play/id/${entry.playId}.html`;
}

// 从试玩页地址反查 slug（openSession 只有 definition.playUrl，无 slug 字段）。
export function ggxSlugFromPlayPageUrl(value: string): string {
  const match = new URL(value).pathname.match(/^\/mobile\/index\/play\/id\/(\d+)\.html$/);
  if (!match) throw new Error("GGX_LINK_INVALID");
  const catalog = readGgxCatalog();
  const slug = Object.keys(catalog).find((key) => String(catalog[key]?.playId) === match[1]);
  if (!slug) throw new Error("GGX_GAME_UNKNOWN");
  return slug;
}

// 从试玩页 HTML 提取 game_start.do 启动地址（含本次令牌）。
export function extractGgxLaunchUrl(html: string, slug: string): string {
  const match = html.match(new RegExp(`https://${GGX_LAUNCH_HOST.replace(/\./g, "\\.")}/game_start\\.do\\?[^\\s"'<>]+`));
  if (!match) throw new Error("GGX_SOURCE_UNAVAILABLE");
  const url = match[0].replace(/&amp;/g, "&");
  if (!isGgxLaunchUrl(url, slug)) throw new Error("GGX_LINK_INVALID");
  return url;
}

export interface GgxEndpoint { endpoint: string; token: string }

// 解析 game_start.do 内嵌 launcher 配置：desktop.server_url 即 gsc 协议端点，
// 路径固定 /gs/<gameCode>/desktop/<令牌>/prod/，与官方 demo 的 {QUEUE} 模板不同。
export function parseGgxLaunch(html: string, launchUrl: string): GgxEndpoint {
  const match = html.match(/desktop:\s*\{[^}]*?server_url:\s*"([^"]+)"/);
  if (!match) throw new Error("GGX_CONFIG_INVALID");
  const endpoint = new URL(match[1]);
  const launch = new URL(launchUrl);
  const gameCode = String(launch.searchParams.get("gameCode"));
  const token = String(launch.searchParams.get("token"));
  if (endpoint.hostname !== GGX_LAUNCH_HOST ||
    endpoint.pathname !== `/gs/${encodeURIComponent(gameCode)}/desktop/${token}/prod/`) {
    throw new Error("GGX_ENDPOINT_INVALID");
  }
  return { endpoint: endpoint.href, token };
}

async function fetchGgxText(url: string, stage: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": GGX_UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GGX_${stage}_HTTP_${response.status}`);
  return response.text();
}

// 试玩页 → game_start.do → 协议端点。只返回地址与解析结果，不打印令牌或正文。
export async function ggxLaunchEndpoint(slug: string): Promise<GgxEndpoint & { launchUrl: string }> {
  const launchUrl = extractGgxLaunchUrl(await fetchGgxText(ggxPlayPageUrl(slug), "LINK"), slug);
  const html = await fetchGgxText(launchUrl, "LAUNCH");
  return { ...parseGgxLaunch(html, launchUrl), launchUrl };
}

// 可用性预检：旧站式“先确认源仍提供该游戏，再恢复历史”。失败码与 wx 源同形。
export async function ggxLaunchUrl(slug: string): Promise<string> {
  return (await ggxLaunchEndpoint(slug)).launchUrl;
}
