import type { Browser } from "playwright";
import { NETWORK_CONCURRENCY, NETWORK_SETTLE_MS, NETWORK_TIMEOUT_MS } from "../config";
import type { RegistryGame } from "./catalog";

export const DEVICE_PROFILES = {
  "desktop-1920": {
    viewport: { width: 1920, height: 1080 },
    isMobile: false,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  },
  "desktop-1366": {
    viewport: { width: 1366, height: 768 },
    isMobile: false,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  },
  "mobile-portrait": {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36",
  },
  "mobile-landscape": {
    viewport: { width: 844, height: 390 },
    isMobile: true,
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36",
  },
} as const;

export type DeviceProfileName = keyof typeof DEVICE_PROFILES;

export interface NetworkRun {
  locale: string;
  profile: DeviceProfileName;
}

export interface NetworkResource {
  url: string;
  status: number;
  size: number;
  contentType: string;
  runs: string[];
}

export interface NetworkFailure {
  url: string;
  run: string;
  status?: number;
  error: string;
}

export interface NetworkRunResult extends NetworkRun {
  key: string;
  staticRequests: number;
  failedRequests: number;
  durationMs: number;
}

export interface NetworkMatrixReport {
  brand: "3 OAKS";
  slug: string;
  generatedAt: string;
  locales: string[];
  profiles: DeviceProfileName[];
  runs: NetworkRunResult[];
  resources: NetworkResource[];
  failed: NetworkFailure[];
}

export function buildRuns(locales: string[]): NetworkRun[] {
  const unique = [...new Set(locales.filter(Boolean))].sort();
  const baseLocale = unique.includes("en") ? "en" : unique[0] ?? "en";
  const runs: NetworkRun[] = (Object.keys(DEVICE_PROFILES) as DeviceProfileName[])
    .map((profile) => ({ locale: baseLocale, profile }));
  for (const locale of unique) {
    if (locale !== baseLocale) runs.push({ locale, profile: "desktop-1366" });
  }
  return runs;
}

function staticUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.hostname !== "static.3oaks.com") return undefined;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

export async function captureNetworkMatrix(game: RegistryGame, browser: Browser): Promise<NetworkMatrixReport> {
  const discovery = game.discovery;
  if (!discovery) throw new Error(`${game.slug} 缺少能力发现结果`);
  const resources = new Map<string, NetworkResource>();
  const failures: NetworkFailure[] = [];
  const runs = buildRuns(discovery.locales);
  const runResults: NetworkRunResult[] = new Array(runs.length);
  const captureRun = async (run: NetworkRun, runIndex: number): Promise<void> => {
    const key = `${run.locale}:${run.profile}`;
    const profile = DEVICE_PROFILES[run.profile];
    const startedAt = Date.now();
    let staticRequests = 0;
    let failedRequests = 0;
    const context = await browser.newContext({
      viewport: profile.viewport,
      isMobile: profile.isMobile,
      hasTouch: profile.isMobile,
      userAgent: profile.userAgent,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.on("response", (response) => {
      const url = staticUrl(response.url());
      if (!url) return;
      staticRequests++;
      const status = response.status();
      const size = Number(response.headers()["content-length"] ?? 0);
      const contentType = response.headers()["content-type"] ?? "";
      if (status < 200 || status >= 300) {
        failedRequests++;
        failures.push({ url, run: key, status, error: `HTTP ${status}` });
        return;
      }
      const prior = resources.get(url);
      if (prior) {
        if (!prior.runs.includes(key)) prior.runs.push(key);
        prior.size = Math.max(prior.size, size);
      } else {
        resources.set(url, { url, status, size, contentType, runs: [key] });
      }
    });
    page.on("requestfailed", (request) => {
      const url = staticUrl(request.url());
      if (!url) return;
      failedRequests++;
      failures.push({ url, run: key, error: request.failure()?.errorText ?? "request failed" });
    });
    try {
      const playUrl = new URL(discovery.playUrl);
      playUrl.searchParams.set("lang", run.locale);
      await page.goto(playUrl.href, { waitUntil: "domcontentloaded", timeout: NETWORK_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: NETWORK_TIMEOUT_MS }).catch(() => undefined);
      await page.waitForTimeout(NETWORK_SETTLE_MS);
    } catch (error) {
      failedRequests++;
      failures.push({ url: "navigation", run: key, error: (error as Error).message.split("\n")[0] });
    } finally {
      await context.close();
    }
    if (staticRequests === 0) {
      failedRequests++;
      failures.push({ url: "static.3oaks.com", run: key, error: "冷启动未观察到任何官方静态资源请求" });
    }
    runResults[runIndex] = { ...run, key, staticRequests, failedRequests, durationMs: Date.now() - startedAt };
  };
  for (let start = 0; start < runs.length; start += NETWORK_CONCURRENCY) {
    const batch = runs.slice(start, start + NETWORK_CONCURRENCY);
    await Promise.all(batch.map((run, offset) => captureRun(run, start + offset)));
  }
  const report: NetworkMatrixReport = {
    brand: "3 OAKS",
    slug: game.slug,
    generatedAt: new Date().toISOString(),
    locales: [...discovery.locales].sort(),
    profiles: Object.keys(DEVICE_PROFILES) as DeviceProfileName[],
    runs: runResults,
    resources: [...resources.values()].map((item) => ({ ...item, runs: item.runs.sort() })).sort((a, b) => a.url.localeCompare(b.url)),
    failed: failures.sort((a, b) => `${a.run}:${a.url}`.localeCompare(`${b.run}:${b.url}`)),
  };
  const serialized = JSON.stringify(report).toLowerCase();
  for (const forbidden of ["session_id", "set-cookie", "authorization", "secret-token", "secret-queue"]) {
    if (serialized.includes(forbidden)) throw new Error(`网络矩阵包含敏感字段: ${forbidden}`);
  }
  return report;
}
