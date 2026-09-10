import crypto from "node:crypto";
import { REQUEST_TIMEOUT_MS } from "../config";
import { BuyMode, GameDiscovery, RuntimeTarget } from "./catalog";

export type JSONMap = Record<string, any>;

function absoluteUrl(value: string, base = "https://3oaks.com"): string {
  if (!value) return "";
  return new URL(value.startsWith("//") ? `https:${value}` : value, base).href;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanOption(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numericList(value: unknown, fallback: number[] = []): number[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const result = values.map(Number).filter((item) => Number.isFinite(item) && item > 0);
  return [...new Set(result.length ? result : fallback)].sort((left, right) => left - right);
}

function numericRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [String(key), Number(item)] as const)
    .filter(([, item]) => Number.isFinite(item) && item > 0)
    .sort(([left], [right]) => Number(left) - Number(right)));
}

function validPrice(value: unknown, label: string): number {
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`${label} 价格必须大于 0`);
  return price;
}

function assertUniqueBuyModes(modes: BuyMode[]): BuyMode[] {
  const providerModes = new Set<number>();
  const spinTypes = new Set<number>();
  for (const mode of modes) {
    if (providerModes.has(mode.providerMode)) throw new Error(`购买模式 providerMode 重复: ${mode.providerMode}`);
    if (spinTypes.has(mode.spinType)) throw new Error(`购买模式 spinType 重复: ${mode.spinType}`);
    providerModes.add(mode.providerMode);
    spinTypes.add(mode.spinType);
  }
  return modes.sort((left, right) => left.spinType - right.spinType);
}

export function parseBuyModes(settings: JSONMap): BuyMode[] {
  const mapped = settings.buy_bonus_prices;
  const array = settings.buy_bonus_price;
  const hasMap = mapped !== undefined && mapped !== null;
  const hasArray = array !== undefined && array !== null;
  if (hasMap && hasArray) throw new Error("购买模式字段冲突: buy_bonus_prices 与 buy_bonus_price 不能同时出现");
  if (hasMap) {
    if (typeof mapped !== "object" || Array.isArray(mapped)) throw new Error("buy_bonus_prices 必须是对象");
    return assertUniqueBuyModes(Object.entries(mapped as Record<string, unknown>).map(([key, value]) => {
      const providerMode = Number(key);
      if (!Number.isInteger(providerMode) || providerMode <= 0) throw new Error(`购买模式编号必须为正整数: ${key}`);
      return { providerMode, spinType: providerMode, price: validPrice(value, `购买模式 ${key}`), source: "map" as const };
    }));
  }
  if (hasArray) {
    if (!Array.isArray(array) || array.length === 0) throw new Error("buy_bonus_price 必须是非空数组");
    return assertUniqueBuyModes(array.map((value, providerMode) => ({
      providerMode,
      spinType: providerMode + 1,
      price: validPrice(value, `购买模式 ${providerMode}`),
      source: "array" as const,
    })));
  }
  return [];
}

function runtimeTarget(raw: JSONMap): RuntimeTarget {
  return {
    clientUrl: absoluteUrl(String(raw.client_url ?? "")),
    version: String(raw.version ?? ""),
    revision: String(raw.revision ?? ""),
    serverTemplate: absoluteUrl(String(raw.server_url ?? "")),
    useCdn: booleanOption(raw.use_cdn),
  };
}

function safeFeatureHints(start: JSONMap): string[] {
  const settings = start.settings ?? {};
  const context = start.context ?? {};
  const hints = new Set<string>();
  const keys = new Set([...Object.keys(settings), ...Object.keys(context)].map((key) => key.toLowerCase()));
  if ([...keys].some((key) => key.includes("free") || key.startsWith("fs_"))) hints.add("free-spins");
  if ([...keys].some((key) => key.includes("respin"))) hints.add("respin");
  if ([...keys].some((key) => key.includes("jackpot"))) hints.add("jackpot");
  if ([...keys].some((key) => key.includes("wheel"))) hints.add("wheel");
  if (parseBuyModes(settings).length > 0) hints.add("bonus-buy");
  return [...hints].sort();
}

async function protocolCommand(
  fetcher: typeof fetch,
  endpoint: string,
  cookie: string,
  command: string,
  extra: JSONMap,
): Promise<JSONMap> {
  const response = await fetcher(`${endpoint}?gsc=${encodeURIComponent(command)}`, {
    method: "POST",
    headers: { "content-type": "text/plain", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ command, request_id: crypto.randomUUID().replaceAll("-", ""), ...extra }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${command} 请求失败: ${response.status} ${response.statusText}`);
  const body = await response.json() as JSONMap;
  if (body.status?.code && body.status.code !== "OK") throw new Error(`${command} 协议失败: ${String(body.status.code)}`);
  return body;
}

export function parsePlayConfig(html: string): JSONMap {
  const marker = "})(window, ";
  const start = html.lastIndexOf(marker);
  if (start < 0) throw new Error("无法从 play HTML 提取启动配置");
  const jsonStart = start + marker.length;
  const end = html.indexOf(', "//betman-demo.head.3oaks.com/betman-demo/game/runner_config/");', jsonStart);
  if (end < 0) throw new Error("无法定位 3 OAKS 启动配置结尾");
  return JSON.parse(html.slice(jsonStart, end));
}

export function parseRuntimeDefinition(slug: string, launch: JSONMap): GameDiscovery {
  const desktopRaw = launch.desktop ?? {};
  const mobileRaw = launch.mobile ?? desktopRaw;
  const desktop = runtimeTarget(desktopRaw);
  const mobile = runtimeTarget(mobileRaw);
  const clientUrl = desktop.clientUrl;
  const client = new URL(clientUrl);
  const pathParts = client.pathname.split("/").filter(Boolean);
  const family = pathParts.find((part) => part.startsWith("clients_")) ?? "";
  const version = String(desktop.version ?? pathParts.at(-1) ?? "");
  const options = launch.options ?? {};
  const runnerUrl = absoluteUrl(String(launch.gr?.static_path ?? ""));
  const promoUrl = absoluteUrl(String(launch.promo_widget?.static_path ?? ""));
  const locales = Object.keys(options.i18n ?? {}).sort();
  return {
    discoveredAt: new Date().toISOString(),
    playUrl: `https://3oaks.com/api/v1/games/${encodeURIComponent(slug)}/play?lang=en`,
    desktop,
    mobile,
    locales,
    settings: {
      lines: numericList(options.lines, [positiveNumber(options.lines, 25)]),
      bets: numericList(options.bets),
      betFactor: numericList(options.bet_factor),
      denominator: positiveNumber(options.denominator, 100),
      buyModes: [],
    },
    options: {
      shop: booleanOption(options.allow_shop),
      bonusBuy: booleanOption(options.allow_shop) && !booleanOption(options.disable_buy_bonus),
      gamble: booleanOption(options.allow_gamble),
      autoplay: booleanOption(options.allow_autoplay),
      turbo: booleanOption(options.quickspin),
    },
    featureHints: [],
    resourceRoots: [...new Set([desktop.clientUrl, mobile.clientUrl, runnerUrl, promoUrl].filter(Boolean))],
    clientUrl,
    clientFamily: family,
    clientVersion: version,
    clientRevision: desktop.revision,
    serverTemplate: desktop.serverTemplate,
    runnerUrl,
    runnerRevision: String(launch.gr?.revision ?? ""),
    promoUrl,
    promoRevision: String(launch.promo_widget?.revision ?? ""),
    defaultBet: positiveNumber(options.default_bet ?? options.bet, 25),
    betPerLine: positiveNumber(options.bet_per_line, 1),
    lines: positiveNumber(options.lines, 25),
    protocol: String(options.protocol ?? "goreel"),
    vendor: String(options.vendor ?? family.replace(/^clients_/, "").toUpperCase()),
  };
}

export async function discoverCapabilities(slug: string, fetcher: typeof fetch = fetch): Promise<GameDiscovery> {
  if (!/^[a-z0-9_]+$/.test(slug)) throw new Error(`非法 3 OAKS slug: ${slug}`);
  const playUrl = `https://3oaks.com/api/v1/games/${encodeURIComponent(slug)}/play?lang=en`;
  const response = await fetcher(playUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`3 OAKS ${slug} 启动页请求失败: ${response.status} ${response.statusText}`);
  const launch = parsePlayConfig(await response.text());
  const definition = parseRuntimeDefinition(slug, launch);
  const queue = String(launch.options?.queue ?? "");
  const token = String(launch.options?.token ?? "");
  if (!queue || !token) throw new Error(`3 OAKS ${slug} 启动配置缺少临时会话参数`);
  const endpoint = resolveDemoEndpoint(definition.desktop.serverTemplate, queue);
  const cookie = response.headers.get("set-cookie")?.split(",").map((part) => part.split(";")[0]).join("; ") ?? "";
  const login = await protocolCommand(fetcher, endpoint, cookie, "login", { token, language: "en" });
  const start = await protocolCommand(fetcher, endpoint, cookie, "start", {
    session_id: login.session_id,
    mode: "play",
    huid: login.user?.huid,
  });
  const context = start.context ?? {};
  const state = context.current ? context[context.current] ?? {} : {};
  const settings = start.settings ?? {};
  const discoveredSettings = {
    lines: numericList(settings.lines, numericList(state.lines, definition.settings.lines)),
    bets: numericList(settings.bets, definition.settings.bets),
    betFactor: numericList(settings.bet_factor, definition.settings.betFactor),
    denominator: positiveNumber(settings.denominator, definition.settings.denominator),
    buyModes: parseBuyModes(settings),
    buyBonusPrices: numericRecord(settings.buy_bonus_prices),
    boosterPrices: numericRecord(settings.booster_prices),
    availableBuyBonus: numericList(context.available_buy_bonus, []),
  };
  return {
    ...definition,
    playUrl,
    settings: {
      ...discoveredSettings,
    },
    featureHints: safeFeatureHints(start),
    defaultBet: positiveNumber(state.round_bet, definition.defaultBet),
    betPerLine: positiveNumber(state.bet_per_line, definition.betPerLine),
    lines: positiveNumber(state.lines, discoveredSettings.lines[0] ?? definition.lines),
  };
}

export function resolveDemoEndpoint(serverTemplate: string, queue: string): string {
  if (!queue) throw new Error("3 OAKS session queue 为空");
  const endpoint = absoluteUrl(serverTemplate).replaceAll("%7BQUEUE%7D", "{QUEUE}").replaceAll("{QUEUE}", encodeURIComponent(queue));
  return endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
}

export async function discoverGame(slug: string, fetcher: typeof fetch = fetch): Promise<GameDiscovery> {
  return discoverCapabilities(slug, fetcher);
}
