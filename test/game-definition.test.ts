import assert from "node:assert/strict";
import test from "node:test";
import { discoverCapabilities, parseBuyModes, parseRuntimeDefinition, resolveDemoEndpoint } from "../src/game-definition";
import { sessionSpinSettings } from "../src/protocol";

test("game definition 识别不同客户端家族与动态版本", () => {
  const base = {
    desktop: { client_url: "https://static.3oaks.com/gs/clients_goreel/sun_of_egypt/3oaks.v26.6.8/", revision: "client-rev", server_url: "//betman-demo.head.3oaks.com/betman-demo/gs/sun_of_egypt/desktop/{QUEUE}/demo/", version: "3oaks.v26.6.8" },
    gr: { static_path: "https://static.3oaks.com/gs/gamerunner/6.1.10/", revision: "runner-rev" },
    promo_widget: { static_path: "//static.3oaks.com/3oaks/gs/promo-widget/3.0.1/", revision: "promo-rev" },
    options: { protocol: "goreel", vendor: "GOREEL" },
  };
  const goreel = parseRuntimeDefinition("sun_of_egypt", base);
  const hraymo = parseRuntimeDefinition("3_super_hot_teapots", {
    ...base,
    desktop: { ...base.desktop, client_url: "https://static.3oaks.com/gs/clients_hraymo/3_super_hot_teapots/3oaks.v26.8.1/", version: "3oaks.v26.8.1" },
  });
  assert.equal(goreel.clientFamily, "clients_goreel");
  assert.equal(goreel.runnerUrl, "https://static.3oaks.com/gs/gamerunner/6.1.10/");
  assert.equal(hraymo.clientFamily, "clients_hraymo");
  assert.equal(hraymo.clientVersion, "3oaks.v26.8.1");
  assert.equal(resolveDemoEndpoint(goreel.serverTemplate, "abc"), "https://betman-demo.head.3oaks.com/betman-demo/gs/sun_of_egypt/desktop/abc/demo/");
});

test("capabilities 解析桌面移动端、语言和真实 start 设置且不泄漏会话字段", async () => {
  const launch = {
    desktop: { client_url: "https://static.3oaks.com/gs/clients_goreel/sun_of_egypt/v1/", server_url: "https://demo.test/{QUEUE}/", version: "v1" },
    mobile: { client_url: "https://static.3oaks.com/gs/clients_goreel/sun_of_egypt/v2/", server_url: "https://demo.test/{QUEUE}/mobile/", version: "v2" },
    gr: { static_path: "https://static.3oaks.com/gs/gamerunner/1/" },
    promo_widget: { static_path: "https://static.3oaks.com/gs/promo-widget/1/" },
    options: {
      token: "secret-token",
      queue: "secret-queue",
      i18n: { zh: "太阳神殿", en: "Sun of Egypt", bg: "Sun of Egypt", de: "Sun of Egypt" },
      allow_shop: "1",
      disable_buy_bonus: "0",
      allow_gamble: "0",
      allow_autoplay: "1",
      quickspin: "1",
    },
  };
  const html = `})(window, ${JSON.stringify(launch)}, "//betman-demo.head.3oaks.com/betman-demo/game/runner_config/");`;
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes("/play?")) return new Response(html, { status: 200, headers: { "set-cookie": "demo=value; Path=/" } });
    if (url.includes("gsc=login")) return Response.json({ status: { code: "OK" }, session_id: "secret-session", user: { huid: "secret-user" } });
    if (url.includes("gsc=start")) return Response.json({
      status: { code: "OK" },
      context: { current: "spins", available_buy_bonus: [1], spins: { bet_per_line: 4, lines: 25, round_bet: 100 } },
      settings: { lines: [25], bets: [1, 2, 4], bet_factor: [25], buy_bonus_prices: { 1: 30 }, booster_prices: { 2: 1.25 }, jackpots: [] },
    });
    return new Response("not found", { status: 404 });
  };
  const capabilities = await discoverCapabilities("sun_of_egypt", fetcher as typeof fetch);
  assert.deepEqual(capabilities.locales, ["bg", "de", "en", "zh"]);
  assert.equal(capabilities.desktop.version, "v1");
  assert.equal(capabilities.mobile.version, "v2");
  assert.deepEqual(capabilities.settings.lines, [25]);
  assert.deepEqual(capabilities.settings.bets, [1, 2, 4]);
  assert.deepEqual(capabilities.settings.betFactor, [25]);
  assert.deepEqual(capabilities.settings.buyBonusPrices, { 1: 30 });
  assert.deepEqual(capabilities.settings.boosterPrices, { 2: 1.25 });
  assert.deepEqual(capabilities.settings.availableBuyBonus, [1]);
  assert.equal(capabilities.options.bonusBuy, true);
  const serialized = JSON.stringify(capabilities);
  for (const secret of ["secret-token", "secret-queue", "secret-session", "secret-user", "demo=value"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("session start 覆盖目录里的保守下注参数", () => {
  const settings = sessionSpinSettings({
    context: { current: "base", base: { bet_per_line: 10, lines: 25, round_bet: 250 } },
  }, { betPerLine: 1, lines: 25, defaultBet: 25 });
  assert.deepEqual(settings, { betPerLine: 10, lines: 25, defaultBet: 250 });
});

test("session start 缺少参数时使用目录回退值", () => {
  const settings = sessionSpinSettings({ context: {} }, { betPerLine: 2, lines: 20, defaultBet: 40 });
  assert.deepEqual(settings, { betPerLine: 2, lines: 20, defaultBet: 40 });
});

test("buy mode discovery 同时支持一基对象和零基数组", () => {
  assert.deepEqual(parseBuyModes({ buy_bonus_prices: { 1: 30, 2: 75 } }), [
    { providerMode: 1, spinType: 1, price: 30, source: "map" },
    { providerMode: 2, spinType: 2, price: 75, source: "map" },
  ]);
  assert.deepEqual(parseBuyModes({ buy_bonus_price: [65, 200, 150, 400] }), [
    { providerMode: 0, spinType: 1, price: 65, source: "array" },
    { providerMode: 1, spinType: 2, price: 200, source: "array" },
    { providerMode: 2, spinType: 3, price: 150, source: "array" },
    { providerMode: 3, spinType: 4, price: 400, source: "array" },
  ]);
});

test("buy mode discovery 拒绝冲突字段和非法价格", () => {
  assert.throws(
    () => parseBuyModes({ buy_bonus_prices: { 1: 30 }, buy_bonus_price: [65] }),
    /购买模式字段冲突/,
  );
  assert.throws(() => parseBuyModes({ buy_bonus_price: [0, 100] }), /价格必须大于 0/);
  assert.throws(() => parseBuyModes({ buy_bonus_prices: { 0: 30 } }), /模式编号必须为正整数/);
});
