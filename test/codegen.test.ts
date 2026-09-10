import assert from "node:assert/strict";
import test from "node:test";
import { emptyRegistry } from "../src/catalog";
import { renderPlatform } from "../src/codegen";

test("平台生成保持 Sun 编号并且结果确定", () => {
  const registry = emptyRegistry();
  registry.games[0].discovery = {
    discoveredAt: "2026-09-09T00:00:00.000Z", playUrl: "https://example.invalid", clientUrl: "https://example.invalid", clientFamily: "goreel", clientVersion: "v1", clientRevision: "r1", serverTemplate: "https://example.invalid", runnerUrl: "https://example.invalid", runnerRevision: "r1", promoUrl: "https://example.invalid", promoRevision: "r1", protocol: "gamerunner", vendor: "3 OAKS",
    desktop: { clientUrl: "https://example.invalid", version: "v1", revision: "r1", serverTemplate: "https://example.invalid", useCdn: true },
    mobile: { clientUrl: "https://example.invalid", version: "v1", revision: "r1", serverTemplate: "https://example.invalid", useCdn: true },
    locales: ["en", "zh"], settings: {
      lines: [25], bets: [1, 4], betFactor: [25], denominator: 100,
      buyModes: [
        { providerMode: 0, spinType: 1, price: 65, source: "array" },
        { providerMode: 3, spinType: 4, price: 400, source: "array" },
      ],
    },
    options: { shop: false, bonusBuy: false, gamble: false, autoplay: true, turbo: true }, featureHints: [], resourceRoots: [], defaultBet: 100, betPerLine: 4, lines: 25,
  };
  const first = renderPlatform(registry);
  const second = renderPlatform(registry);
  assert.match(first.constants, /OAKS_SUN_OF_EGYPT uint16 = 32601/);
  assert.equal(first.gameInfoCount, 1);
  assert.deepEqual(first, second);
  assert.match(first.chipsFile, /BetSize: \[\]float32\{0\.25, 1\}/);
  assert.match(first.chipsFile, /BuyMode\{ProviderMode: 0, SpinType: 1, Price: 65\}/);
  assert.match(first.chipsFile, /BuyMode\{ProviderMode: 3, SpinType: 4, Price: 400\}/);
  assert.match(first.chipsFile, /func GetBuyMode\(config GameConfig, providerMode int\)/);
  assert.match(first.chipsFile, /config\.BuyModes = append\(\[\]BuyMode\(nil\), config\.BuyModes\.\.\.\)/);
});
