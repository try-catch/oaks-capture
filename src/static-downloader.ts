import fs from "node:fs/promises";
import path from "node:path";
import { LANGUAGE_MAP, REQUESTED_LANGUAGES, REQUEST_TIMEOUT_MS } from "../config";
import { GameDiscovery } from "./catalog";
import { crawlResourceGraph, ResourceFailure, ResourceRecord } from "./resource-graph";

export interface StaticGame extends GameDiscovery {
  slug: string;
  title: string;
}

export interface RuntimeTexts {
  clientGame?: string;
  clientLibs?: string;
  runnerIndex?: string;
  runnerCore?: string;
}

export interface DownloadReport {
  brand: "3 OAKS";
  slug: string;
  downloaded: number;
  expected: number;
  failed: ResourceFailure[];
  unavailableDeclaredResources: ResourceFailure[];
  clientVersion: string;
  runnerRevision: string;
  promoRevision: string;
  supportedLocales: string[];
  unsupportedLocales: string[];
  files: ResourceRecord[];
}

const VERSIONED_PACK_PATH = /\/gs\/clients_[^/]+\/[^/]+\/[^/]+\/assets\/packs\//i;

/**
 * 3 OAKS 的编译清单会保留已经从 CDN 下线的兼容格式（常见为 mp3/ogg）和旧图包项。
 * 这些声明项需要留在报告中供审计，但不能阻止后续真实浏览器网络矩阵继续验证。
 * 入口文件、非 404/410 错误以及清单外资源仍然是硬失败。
 */
export function partitionResourceFailures(failures: ResourceFailure[]): {
  failed: ResourceFailure[];
  unavailableDeclaredResources: ResourceFailure[];
} {
  const failed: ResourceFailure[] = [];
  const unavailableDeclaredResources: ResourceFailure[] = [];
  for (const failure of failures) {
    const pathname = new URL(failure.url).pathname;
    const isUnavailableDeclaration = failure.discoveredFrom !== "entry" &&
      (failure.status === 404 || failure.status === 410) && VERSIONED_PACK_PATH.test(pathname);
    (isUnavailableDeclaration ? unavailableDeclaredResources : failed).push(failure);
  }
  return { failed, unavailableDeclaredResources };
}

function addUrl(urls: Map<string, URL>, value: string, base: string): void {
  const clean = value.trim().replace(/^\.\//, "");
  if (!clean || clean.endsWith("/") || clean.startsWith("../fonts/") ||
      clean.startsWith("ui-new/textures/gr_ui_new_textures.") || /^(?:data:|blob:)/i.test(clean)) return;
  try {
    const url = new URL(clean.startsWith("//") ? `https:${clean}` : clean, base);
    if (url.protocol === "http:" || url.protocol === "https:") urls.set(url.href, url);
  } catch { /* 忽略脚本中并非 URL 的动态片段。 */ }
}

export function collectStaticUrls(game: StaticGame, texts: RuntimeTexts): URL[] {
  const urls = new Map<string, URL>();
  for (const file of ["MANIFEST", "init.js", "src/libs.js", "src/game.js", "thumbs/en.jpg"]) addUrl(urls, file, game.clientUrl);
  for (const file of [
    "index.js", "gr.js", "integrations/wl.js", "css/font-awesome.min.css", "css/fonts.css",
    "fonts/Gilroy/Gilroy-Bold.woff2", "fonts/Gilroy/Gilroy-Regular.woff2",
    "canvas_assets_avif/ui-new/textures/gr_ui_new_textures.json",
    "canvas_assets_avif/ui-new/textures/gr_ui_new_textures.avif",
  ]) addUrl(urls, file, game.runnerUrl);
  for (const image of ["TURBO", "QUICK", "MENU", "PAYTABLE", "SOUND", "SPIN", "BETS_PLUS", "AUTOPLAY", "STOP_DEFAULT", "BETS_MINUS", "CLOSE", "ARROWS", "HISTORY", "REPLAY"]) {
    addUrl(urls, `images/${image}.png`, game.runnerUrl);
  }
  if (game.promoUrl) {
    addUrl(urls, "external-promo.js", game.promoUrl);
  }

  const patterns = [
    /(?:url|src):["']([^"']+)["']/g,
    /["']((?:assets|fonts|i18n|integrations|canvas_assets[^"']*)\/[^"']+\.(?:avif|png|jpe?g|webp|json|webm|mp3|ogg|woff2?|ttf|svg|js))["']/g,
  ];
  for (const [text, base] of [
    [texts.clientGame, game.clientUrl], [texts.clientLibs, game.clientUrl],
    [texts.runnerIndex, game.runnerUrl], [texts.runnerCore, game.runnerUrl],
  ] as const) {
    if (!text) continue;
    if (game.clientFamily === "clients_kendoo" && base === game.clientUrl) continue;
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) addUrl(urls, match[1], base);
  }
  return [...urls.values()].sort((left, right) => left.href.localeCompare(right.href));
}

async function textOrEmpty(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return response.ok ? await response.text() : "";
  } catch { return ""; }
}

function localPath(target: string, url: URL): string {
  return path.join(target, url.pathname.replace(/^\//, ""));
}

async function existingUrls(game: StaticGame, target: string): Promise<URL[]> {
  const roots = [...new Set([game.clientUrl, game.runnerUrl, game.promoUrl].filter(Boolean))];
  const urls = new Map<string, URL>();
  const visit = async (directory: string, origin: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath, origin);
      else if (entry.isFile() && !entry.name.includes(".part-")) {
        const relative = path.relative(target, fullPath).replaceAll(path.sep, "/");
        const url = new URL(`/${relative}`, origin);
        urls.set(url.href, url);
      }
    }
  };
  for (const root of roots) await visit(localPath(target, new URL(root)), new URL(root).origin);
  return [...urls.values()];
}

export function launcherHTML(game: StaticGame): string {
  const clientPath = new URL(game.clientUrl).pathname;
  const runnerPath = new URL(game.runnerUrl).pathname;
  const promoPath = game.promoUrl ? new URL(game.promoUrl).pathname : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${game.title.replaceAll("<", "&lt;")}</title><style>html,body{width:100%;height:100%;margin:0;background:#000;overflow:hidden}</style></head><body>
<script>
(function () {
  var q = new URLSearchParams(location.search);
  var localeMap = ${JSON.stringify(LANGUAGE_MAP)};
  var requested = q.get('lang') || 'en-US';
  var lang = localeMap[requested] || 'en';
  var api = (q.get('api') || 'https://demo-api-oaks.vg778.com').replace(/\\/$/, '');
  var token = q.get('token') || '';
  var base = location.origin + '${clientPath}';
  window._PROVIDER = {
    available_games: [{client_url:base,game:'${game.slug}',name:'${game.slug}',title:${JSON.stringify(game.title)}}],
    desktop:{client_url:base,log_url:'',revision:'${game.clientRevision}',server_url:api+'/${game.slug}/',use_cdn:false,version:'${game.clientVersion}'},
    mobile:{client_url:base,log_url:'',revision:'${game.clientRevision}',server_url:api+'/${game.slug}/',use_cdn:false,version:'${game.clientVersion}'},
    gr:{revision:'${game.runnerRevision}',static_path:location.origin+'${runnerPath}',use_cdn:false},
    options:{allow_autoplay:'1',allow_gamble:'0',game_name:'${game.slug}',incognito:'1',lang:lang,mobile:/Mobi|Android/i.test(navigator.userAgent)?'1':'0',profile:'default',project_name:'local',protocol:'${game.protocol}',provider:'3oaks',quickspin:'1',sound:'1',title:${JSON.stringify(game.title)},token:token,vendor:'${game.vendor}',wl:'local'},
    promo_widget:{revision:'${game.promoRevision}',static_path:location.origin+'${promoPath}',use_cdn:false},
    sentry_url:'',static_domain:location.origin,static_domains:{domains_url:'',force_domain:location.host,log_url:'',metric_url:'',timeout:1000},translations:{}
  };
  var script=document.createElement('script');script.src=location.origin+'${runnerPath}index.js?${game.runnerRevision}';document.head.appendChild(script);
})();
</script></body></html>`;
}

export async function downloadGameStatic(game: StaticGame, target: string): Promise<DownloadReport> {
  const texts: RuntimeTexts = {
    clientGame: await textOrEmpty(new URL("src/game.js", game.clientUrl).href),
    clientLibs: await textOrEmpty(new URL("src/libs.js", game.clientUrl).href),
    runnerIndex: await textOrEmpty(new URL("index.js", game.runnerUrl).href),
    runnerCore: await textOrEmpty(new URL("gr.js", game.runnerUrl).href),
  };
  const urlsByHref = new Map<string, URL>();
  for (const url of [...collectStaticUrls(game, texts), ...await existingUrls(game, target)]) urlsByHref.set(url.href, url);
  const urls = [...urlsByHref.values()];
  const graph = await crawlResourceGraph(urls, fetch, {
    concurrency: 8,
    allowedHosts: new Set(urls.map((url) => url.hostname)),
    target,
  });
  const { failed, unavailableDeclaredResources } = partitionResourceFailures(graph.failed);
  const launcherDir = path.join(target, game.slug);
  await fs.mkdir(launcherDir, { recursive: true });
  await fs.writeFile(path.join(launcherDir, "index.html"), launcherHTML(game));
  const supportedLocales = [...game.locales].sort();
  const requestedMapped = new Map(REQUESTED_LANGUAGES.map((locale) => [locale, LANGUAGE_MAP[locale]]));
  const report: DownloadReport = {
    brand: "3 OAKS", slug: game.slug, downloaded: graph.files.length,
    expected: graph.files.length + failed.length + unavailableDeclaredResources.length,
    failed, unavailableDeclaredResources,
    clientVersion: game.clientVersion, runnerRevision: game.runnerRevision, promoRevision: game.promoRevision,
    supportedLocales,
    unsupportedLocales: REQUESTED_LANGUAGES.filter((locale) => !requestedMapped.get(locale) || !supportedLocales.includes(requestedMapped.get(locale)!)),
    files: graph.files,
  };
  await fs.writeFile(path.join(launcherDir, "download-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
