import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeDefinition } from "../src/game-definition";
import { collectStaticUrls, launcherHTML, partitionResourceFailures } from "../src/static-downloader";
import { STATIC_TARGET } from "../config";

test("static downloader 默认写入本地 Docker 资源目录", () => {
  assert.match(STATIC_TARGET.replaceAll("\\", "/"), /\/api_new_docker\/api_new\/client\/game\/oaks\/static$/);
  assert.doesNotMatch(STATIC_TARGET.replaceAll("\\", "/"), /\/api_new\/api_new_docker\//);
});

test("官方版本包中已下线的兼容资源保留审计证据但不阻断真实网络矩阵", () => {
  const result = partitionResourceFailures([
    {
      url: "https://static.3oaks.com/gs/clients_goreel/coin_princess_x1000/3oaks.v26.8.6/assets/packs/mp3/spin.mp3",
      status: 404,
      error: "404 Not Found",
      discoveredFrom: "https://static.3oaks.com/gs/clients_goreel/coin_princess_x1000/3oaks.v26.8.6/src/game.js",
    },
    {
      url: "https://static.3oaks.com/gs/clients_goreel/coin_princess_x1000/3oaks.v26.8.6/assets/packs/webm/spin.webm",
      status: 503,
      error: "503 Service Unavailable",
      discoveredFrom: "https://static.3oaks.com/gs/clients_goreel/coin_princess_x1000/3oaks.v26.8.6/src/game.js",
    },
    {
      url: "https://static.3oaks.com/gs/clients_goreel/coin_princess_x1000/3oaks.v26.8.6/MANIFEST",
      status: 404,
      error: "404 Not Found",
      discoveredFrom: "entry",
    },
  ]);
  assert.equal(result.unavailableDeclaredResources.length, 1);
  assert.equal(result.unavailableDeclaredResources[0].url.endsWith("/mp3/spin.mp3"), true);
  assert.equal(result.failed.length, 2);
});

test("static downloader 按动态客户端生成去重资源和启动器", () => {
  const definition = parseRuntimeDefinition("3_super_hot_teapots", {
    desktop: { client_url: "https://static.3oaks.com/gs/clients_hraymo/3_super_hot_teapots/3oaks.v26.8.1/", revision: "client", server_url: "//example.com/gs/3_super_hot_teapots/{QUEUE}/", version: "3oaks.v26.8.1" },
    gr: { static_path: "https://static.3oaks.com/gs/gamerunner/6.1.10/", revision: "runner" },
    promo_widget: { static_path: "//static.3oaks.com/3oaks/gs/promo-widget/3.0.1/", revision: "promo" },
    options: { protocol: "goreel", vendor: "HRAYMO", i18n: { en: "3 Super Hot Teapots", zh: "3 Super Hot Teapots" } },
  });
  const game = { ...definition, slug: "3_super_hot_teapots", title: "3 Super Hot Teapots" };
  const urls = collectStaticUrls(game, { runnerIndex: 'src:"index.js";src:"index.js";src:"assets/i18n/";src:"ui-new/textures/gr_ui_new_textures.json"' });
  assert.equal(urls.filter((url) => url.pathname.endsWith("/index.js")).length, 1);
  assert.equal(urls.some((url) => url.pathname.endsWith("/assets/i18n/")), false);
  assert.equal(urls.some((url) => url.pathname.includes("/gamerunner/6.1.10/ui-new/")), false);
  assert.match(launcherHTML(game), /game:'3_super_hot_teapots'/);
  assert.match(launcherHTML(game), /clients_hraymo/);
  assert.match(launcherHTML(game), /show_replay_button:'0'/);
  assert.equal(urls.some((url) => url.pathname.endsWith("/assets/i18n/en.json")), false);
  assert.equal(urls.some((url) => url.pathname.endsWith("/assets/i18n/zh.json")), false);
  assert.equal(urls.some((url) => url.pathname.endsWith("/assets/i18n/de.json")), false);
});

test("static downloader 不从 KENDOO 客户端脚本猜测源素材路径", () => {
  const definition = parseRuntimeDefinition("coinup_volcano", {
    desktop: { client_url: "https://static.3oaks.com/gs/clients_kendoo/coinup_volcano/v1/", server_url: "//example.com/{QUEUE}/", version: "v1" },
    gr: { static_path: "https://static.3oaks.com/gs/gamerunner/1/" },
    options: { protocol: "goreel", vendor: "KENDOO", i18n: { en: "Coin UP Volcano" } },
  });
  const urls = collectStaticUrls({ ...definition, slug: "coinup_volcano", title: "Coin UP Volcano" }, {
    clientGame: 'url:"images/paytable/mega_bonus_game.png"',
  });
  assert.equal(urls.some((url) => url.pathname.includes("mega_bonus_game.png")), false);
});
