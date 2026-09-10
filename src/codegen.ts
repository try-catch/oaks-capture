import type { BuyMode, OaksRegistry, RegistryGame } from "./catalog";

export interface PlatformRender {
  constants: string;
  gameMapEntries: string;
  serviceFile: string;
  chipsFile: string;
  gameInfoCount: number;
}

function activeGames(registry: OaksRegistry): RegistryGame[] {
  return registry.games.filter((game) => game.active).sort((left, right) => left.gameId - right.gameId);
}

export function constantName(slug: string): string {
  return `OAKS_${slug.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function comment(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\/\//g, "/ /");
}

function stringSlice(values: string[]): string {
  return `[]string{${values.map(quote).join(", ")}}`;
}

function float32Slice(values: number[]): string {
  return `[]float32{${values.map((value) => Number(value.toFixed(6))).join(", ")}}`;
}

function priceMap(values: Record<string, number> | undefined, allowed?: number[]): string {
  const allowedSet = allowed?.length ? new Set(allowed) : undefined;
  const entries = Object.entries(values ?? {})
    .map(([key, value]) => [Number(key), Number(value)] as const)
    .filter(([key, value]) => Number.isInteger(key) && key > 0 && Number.isFinite(value) && value > 0 && (!allowedSet || allowedSet.has(key)))
    .sort(([left], [right]) => left - right);
  return `map[uint16]float32{${entries.map(([key, value]) => `${key}: ${Number(value.toFixed(6))}`).join(", ")}}`;
}

function effectiveBuyModes(game: RegistryGame): BuyMode[] {
  const settings = game.discovery?.settings;
  if (!settings) return [];
  const discovered = Array.isArray(settings.buyModes)
    ? settings.buyModes
    : Object.entries(settings.buyBonusPrices ?? {}).map(([mode, price]) => ({
      providerMode: Number(mode), spinType: Number(mode), price: Number(price), source: "map" as const,
    }));
  const allowed = settings.availableBuyBonus?.length ? new Set(settings.availableBuyBonus) : undefined;
  return discovered
    .filter((mode) => Number.isInteger(mode.providerMode) && mode.providerMode >= 0
      && Number.isInteger(mode.spinType) && mode.spinType > 0
      && Number.isFinite(mode.price) && mode.price > 0
      && (!allowed || allowed.has(mode.providerMode)))
    .sort((left, right) => left.spinType - right.spinType);
}

function buyModeSlice(modes: BuyMode[]): string {
  return `[]BuyMode{${modes.map((mode) => `BuyMode{ProviderMode: ${mode.providerMode}, SpinType: ${mode.spinType}, Price: ${Number(mode.price.toFixed(6))}}`).join(", ")}}`;
}

function legacyBuyBonusPrices(modes: BuyMode[]): string {
  const entries = modes.filter((mode) => mode.providerMode > 0 && mode.providerMode === mode.spinType);
  return `map[uint16]float32{${entries.map((mode) => `${mode.spinType}: ${Number(mode.price.toFixed(6))}`).join(", ")}}`;
}

function selectedFactor(game: RegistryGame): number {
  const settings = game.discovery?.settings;
  if (!settings) throw new Error(`${game.slug} 缺少 discovery.settings`);
  const index = settings.lines.indexOf(game.discovery?.lines ?? settings.lines[0]);
  return Number(settings.betFactor[index >= 0 ? index : 0] ?? settings.lines[index >= 0 ? index : 0]);
}

function gameConfig(game: RegistryGame): { lines: number; factor: number; denominator: number; bets: number[] } {
  const discovery = game.discovery;
  if (!discovery) throw new Error(`${game.slug} 缺少 discovery`);
  const factor = selectedFactor(game);
  const denominator = Number(discovery.settings.denominator);
  if (!Number.isInteger(discovery.lines) || discovery.lines <= 0 || !Number.isFinite(factor) || factor <= 0 || !Number.isFinite(denominator) || denominator <= 0) {
    throw new Error(`${game.slug} 投注配置非法`);
  }
  return {
    lines: discovery.lines,
    factor,
    denominator,
    bets: discovery.settings.bets.map((bet) => Number((bet * factor / denominator).toFixed(6))),
  };
}

export function renderPlatform(registry: OaksRegistry): PlatformRender {
  const games = activeGames(registry);
  const names = games.map((game) => constantName(game.slug));
  if (new Set(names).size !== names.length) throw new Error("3 OAKS 常量名冲突");
  if (new Set(games.map((game) => game.gameId)).size !== games.length) throw new Error("3 OAKS gameId 冲突");

  const constants = games.map((game) => `\t${constantName(game.slug)} uint16 = ${game.gameId} // ${comment(game.title)}`).join("\n");
  const gameMapEntries = games.map((game) => `\t${constantName(game.slug)}: ${quote(game.title)},`).join("\n");
  const infoEntries = games.map((game) => `\t${constantName(game.slug)}: {GameID: ${constantName(game.slug)}, GameName: ${quote(game.title)}, Slug: ${quote(game.slug)}, Languages: ${stringSlice(game.discovery?.locales ?? [])}, Icon: ${quote(`/assets/oaks/${game.slug}.png`)}},`).join("\n");
  const slugEntries = games.map((game) => `\t${constantName(game.slug)}: ${quote(game.slug)},`).join("\n");
  const reverseEntries = games.map((game) => `\t${quote(game.slug)}: ${constantName(game.slug)},`).join("\n");

  const serviceFile = `// Code generated by capture-oaks/generate-platform.ts; DO NOT EDIT.\n\npackage service\n\n// OAKSGameInfo 是测试站和游戏服务共用的 3 OAKS 目录信息。\ntype OAKSGameInfo struct {\n\tGameID    uint16\n\tGameName  string\n\tSlug      string\n\tLanguages []string\n\tIcon      string\n}\n\n// OAKSGameInfoMap 包含全部启用的 3 OAKS 游戏。\nvar OAKSGameInfoMap = map[uint16]OAKSGameInfo{\n${infoEntries}\n}\n\n// GetOAKSSourceGameId 返回 3 OAKS 协议使用的游戏 slug。\nfunc GetOAKSSourceGameId(gameID uint16) string {\n\tif slug, ok := OAKSGameURLNameMap[gameID]; ok {\n\t\treturn slug\n\t}\n\treturn \"none\"\n}\n\n// GetOAKSOriginGameUrlName 返回 3 OAKS 启动地址中的游戏路径名。\nfunc GetOAKSOriginGameUrlName(gameID uint16) string {\n\treturn OAKSGameURLNameMap[gameID]\n}\n\n// GetOAKSGameId 根据远端 slug 反查内部 gameId。\nfunc GetOAKSGameId(slug string) uint16 {\n\treturn oaksGameIDMap[slug]\n}\n\n// OAKSGameURLNameMap 映射内部 gameId 与 3 OAKS 官方 slug。\nvar OAKSGameURLNameMap = map[uint16]string{\n${slugEntries}\n}\n\nvar oaksGameIDMap = map[string]uint16{\n${reverseEntries}\n}\n`;

  const configs = games.map((game) => {
    const cfg = gameConfig(game);
    const buyModes = effectiveBuyModes(game);
    return `\t${game.gameId}: {GameID: ${game.gameId}, GameName: ${quote(game.title)}, Slug: ${quote(game.slug)}, Lines: ${cfg.lines}, BetFactor: ${cfg.factor}, Denominator: ${cfg.denominator}, BetSize: ${float32Slice(cfg.bets)}, Languages: ${stringSlice(game.discovery?.locales ?? [])}, Icon: ${quote(`/assets/oaks/${game.slug}.png`)}, BuyModes: ${buyModeSlice(buyModes)}, BuyBonusPrices: ${legacyBuyBonusPrices(buyModes)}, BoosterPrices: ${priceMap(game.discovery?.settings.boosterPrices)}},`;
  }).join("\n");
  const chipsFile = `// Code generated by capture-oaks/generate-platform.ts; DO NOT EDIT.\n\npackage chips_oaks\n\n// BuyMode 将官方 selected_mode 映射到内部正整数数据分桶。\ntype BuyMode struct {\n\tProviderMode int16\n\tSpinType     uint16\n\tPrice        float32\n}\n\n// GameConfig 是单款 3 OAKS 游戏的协议和投注配置。Lines 使用 uint32，\n// 因为 Ways 游戏会公开 117649 等超过传统 uint16 线数上限的协议值。\ntype GameConfig struct {\n\tGameID         uint16\n\tGameName       string\n\tSlug           string\n\tLines          uint32\n\tBetFactor      float32\n\tDenominator    uint16\n\tBetSize        []float32\n\tLanguages      []string\n\tIcon           string\n\tBuyModes       []BuyMode\n\tBuyBonusPrices map[uint16]float32\n\tBoosterPrices  map[uint16]float32\n}\n\nvar GameConfigMap = map[uint16]GameConfig{\n${configs}\n}\n\nfunc clonePrices(source map[uint16]float32) map[uint16]float32 {\n\tresult := make(map[uint16]float32, len(source))\n\tfor key, value := range source {\n\t\tresult[key] = value\n\t}\n\treturn result\n}\n\n// GetBuyMode 按官方 selected_mode 查询内部数据分桶和价格。\nfunc GetBuyMode(config GameConfig, providerMode int) (BuyMode, bool) {\n\tfor _, mode := range config.BuyModes {\n\t\tif int(mode.ProviderMode) == providerMode {\n\t\t\treturn mode, true\n\t\t}\n\t}\n\treturn BuyMode{}, false\n}\n\nfunc GetGameConfig(gameID uint16) (GameConfig, bool) {\n\tconfig, ok := GameConfigMap[gameID]\n\tif !ok {\n\t\treturn GameConfig{}, false\n\t}\n\tconfig.BetSize = append([]float32(nil), config.BetSize...)\n\tconfig.Languages = append([]string(nil), config.Languages...)\n\tconfig.BuyModes = append([]BuyMode(nil), config.BuyModes...)\n\tconfig.BuyBonusPrices = clonePrices(config.BuyBonusPrices)\n\tconfig.BoosterPrices = clonePrices(config.BoosterPrices)\n\treturn config, true\n}\n\nfunc GetDefaultBetSize(gameID uint16) []float32 {\n\tconfig, ok := GetGameConfig(gameID)\n\tif !ok {\n\t\treturn nil\n\t}\n\treturn config.BetSize\n}\n\nfunc GetDefaultBetLevel(gameID uint16) []uint16 {\n\tif _, ok := GameConfigMap[gameID]; !ok {\n\t\treturn nil\n\t}\n\treturn []uint16{1}\n}\n\nfunc GetDefaultLevelSizeIdx(gameID uint16) (uint16, uint16) {\n\tif _, ok := GameConfigMap[gameID]; !ok {\n\t\treturn 0, 0\n\t}\n\treturn 0, 0\n}\n`;

  return { constants, gameMapEntries, serviceFile, chipsFile, gameInfoCount: games.length };
}

export function replaceServiceRegions(source: string, rendered: Pick<PlatformRender, "constants" | "gameMapEntries">): string {
  const constantsPattern = /\/\/ 3 OAKS 游戏 32601 - 32720（预留 120 个槽位）\r?\nconst \(\r?\n[\s\S]*?\r?\n\)\r?\n\r?\nvar GameMap/;
  const gameMapPattern = /\t\/\/ 3 OAKS\r?\n[\s\S]*?\r?\n}\r?\n\r?\nvar \(/;
  if (!constantsPattern.test(source) || !gameMapPattern.test(source)) throw new Error("service.go 缺少 3 OAKS 生成区边界");
  return source
    .replace(constantsPattern, `// 3 OAKS 游戏 32601 - 32720（预留 120 个槽位）\nconst (\n${rendered.constants}\n)\n\nvar GameMap`)
    .replace(gameMapPattern, `\t// 3 OAKS\n${rendered.gameMapEntries}\n}\n\nvar (`);
}
