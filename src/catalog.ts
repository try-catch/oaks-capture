export const CATALOG_URL = "https://3oaks.com/api/v1/games";
export const FIRST_GAME_ID = 32601;
export const LAST_GAME_ID = 32720;

export interface OfficialGame {
  has_page: boolean;
  icon_file?: string;
  logo_file?: string;
  main_logo_file?: string;
  name: string;
  provider: string;
  release_date?: string;
  title_text: string;
}

export interface RuntimeTarget {
  clientUrl: string;
  version: string;
  revision: string;
  serverTemplate: string;
  useCdn: boolean;
}

export interface BuyMode {
  providerMode: number;
  spinType: number;
  price: number;
  source: "map" | "array";
}

export interface GameCapabilities {
  discoveredAt: string;
  playUrl: string;
  desktop: RuntimeTarget;
  mobile: RuntimeTarget;
  locales: string[];
  settings: {
    lines: number[];
    bets: number[];
    betFactor: number[];
    denominator: number;
    buyModes: BuyMode[];
    buyBonusPrices?: Record<string, number>;
    boosterPrices?: Record<string, number>;
    availableBuyBonus?: number[];
  };
  options: {
    shop: boolean;
    bonusBuy: boolean;
    gamble: boolean;
    autoplay: boolean;
    turbo: boolean;
  };
  featureHints: string[];
  resourceRoots: string[];
}

export interface GameDiscovery extends GameCapabilities {
  clientUrl: string;
  clientFamily: string;
  clientVersion: string;
  clientRevision: string;
  serverTemplate: string;
  runnerUrl: string;
  runnerRevision: string;
  promoUrl: string;
  promoRevision: string;
  defaultBet: number;
  betPerLine: number;
  lines: number;
  protocol: string;
  vendor: string;
}

export interface RegistryGame {
  gameId: number;
  slug: string;
  title: string;
  active: boolean;
  releaseDate?: string;
  iconUrl?: string;
  logoUrl?: string;
  mainLogoUrl?: string;
  dbName: string;
  validator: "common" | "sun-of-egypt";
  discovery?: GameDiscovery;
}

export interface OaksRegistry {
  brand: "3 OAKS";
  provider: "3oaks";
  generatedAt: string;
  games: RegistryGame[];
}

interface CatalogResponse {
  data?: { items?: OfficialGame[]; total_pages?: number };
}

export async function fetchOfficialCatalog(fetcher: typeof fetch = fetch): Promise<OfficialGame[]> {
  const unique = new Map<string, OfficialGame>();
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const url = new URL(CATALOG_URL);
    url.searchParams.set("page_num", String(page));
    url.searchParams.set("page_items_num", "50");
    url.searchParams.set("lang", "en");
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`3 OAKS 官方目录请求失败: ${response.status} ${response.statusText}`);
    const body = await response.json() as CatalogResponse;
    totalPages = Math.max(1, Number(body.data?.total_pages ?? 1));
    for (const game of body.data?.items ?? []) {
      const slug = String(game.name ?? "").trim();
      if (game.provider === "3oaks" && game.has_page === true && slug && !unique.has(slug)) unique.set(slug, game);
    }
  }
  return [...unique.values()];
}

function mediaUrl(value?: string): string | undefined {
  if (!value) return undefined;
  return new URL(value, "https://3oaks.com").href;
}

export function emptyRegistry(): OaksRegistry {
  return {
    brand: "3 OAKS",
    provider: "3oaks",
    generatedAt: new Date(0).toISOString(),
    games: [{
      gameId: FIRST_GAME_ID,
      slug: "sun_of_egypt",
      title: "Sun of Egypt",
      active: true,
      dbName: "oaks_SunOfEgypt",
      validator: "sun-of-egypt",
    }],
  };
}

export function syncCatalog(existing: OaksRegistry, remote: OfficialGame[]): OaksRegistry {
  const games = existing.games.map((game) => ({ ...game, active: false }));
  const bySlug = new Map(games.map((game) => [game.slug, game]));
  const used = new Set(games.map((game) => game.gameId));
  let next = FIRST_GAME_ID;
  const allocate = (): number => {
    while (used.has(next) && next <= LAST_GAME_ID) next++;
    if (next > LAST_GAME_ID) throw new Error(`3 OAKS gameId 已超出 ${LAST_GAME_ID}`);
    used.add(next);
    return next++;
  };

  for (const official of remote) {
    const slug = official.name.trim();
    if (official.provider !== "3oaks" || official.has_page !== true || !slug) continue;
    const prior = bySlug.get(slug);
    const game: RegistryGame = {
      gameId: prior?.gameId ?? allocate(),
      slug,
      title: official.title_text || prior?.title || slug,
      active: true,
      releaseDate: official.release_date,
      iconUrl: mediaUrl(official.icon_file),
      logoUrl: mediaUrl(official.logo_file),
      mainLogoUrl: mediaUrl(official.main_logo_file),
      dbName: prior?.dbName ?? `oaks_${slug}`,
      validator: slug === "sun_of_egypt" ? "sun-of-egypt" : (prior?.validator ?? "common"),
      discovery: prior?.discovery,
    };
    if (prior) Object.assign(prior, game);
    else {
      games.push(game);
      bySlug.set(slug, game);
    }
  }
  games.sort((left, right) => left.gameId - right.gameId);
  return { brand: "3 OAKS", provider: "3oaks", generatedAt: new Date().toISOString(), games };
}
