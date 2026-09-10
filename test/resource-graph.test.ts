import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { crawlResourceGraph } from "../src/resource-graph";

test("resource graph 递归发现、循环去重并明确报告 404", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "oaks-resource-"));
  const responses = new Map<string, { body: string; type: string; status?: number }>([
    ["https://static.test/init.js", { body: 'import "./assets/en.json"; const image="./assets/mobile.webp"; const atlas="./assets/page.atlas"; const missing="./assets/missing.png";', type: "application/javascript" }],
    ["https://static.test/assets/en.json", { body: '{"back":"../init.js"}', type: "application/json" }],
    ["https://static.test/assets/mobile.webp", { body: "binary-image", type: "image/webp" }],
    ["https://static.test/assets/page.atlas", { body: "texture.png\nsize:100,100\nregion/fake.png name\nbounds:0,0,1,1", type: "text/plain" }],
    ["https://static.test/assets/texture.png", { body: "atlas-image", type: "image/png" }],
    ["https://static.test/assets/missing.png", { body: "missing", type: "text/plain", status: 404 }],
  ]);
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const fixture = responses.get(String(input));
    if (!fixture) return new Response("missing fixture", { status: 404 });
    return new Response(fixture.body, { status: fixture.status ?? 200, headers: { "content-type": fixture.type } });
  };
  try {
    const graph = await crawlResourceGraph([new URL("https://static.test/init.js")], fetcher as typeof fetch, {
      concurrency: 2,
      allowedHosts: new Set(["static.test"]),
      target,
    });
    assert.deepEqual(graph.files.map((file) => file.url), [
      "https://static.test/assets/en.json",
      "https://static.test/assets/mobile.webp",
      "https://static.test/assets/page.atlas",
      "https://static.test/assets/texture.png",
      "https://static.test/init.js",
    ]);
    assert.equal(graph.failed.length, 1);
    assert.equal(graph.failed[0].status, 404);
    assert.equal(graph.failed[0].url, "https://static.test/assets/missing.png");
    assert.equal(graph.files.every((file) => file.size > 0 && /^[a-f0-9]{64}$/.test(file.sha256)), true);
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("resource graph 拒绝非允许主机", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "oaks-resource-host-"));
  try {
    const graph = await crawlResourceGraph([new URL("https://evil.test/a.js")], fetch as typeof fetch, {
      concurrency: 1,
      allowedHosts: new Set(["static.test"]),
      target,
    });
    assert.equal(graph.files.length, 0);
    assert.match(graph.failed[0].error, /允许列表/);
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("resource graph 接受服务器用 Content-Length 明确声明的空占位文件", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "oaks-resource-empty-"));
  const fetcher = async (): Promise<Response> => new Response("", {
    status: 200,
    headers: { "content-type": "application/javascript", "content-length": "0" },
  });
  try {
    const graph = await crawlResourceGraph([new URL("https://static.test/src/libs.js")], fetcher as typeof fetch, {
      concurrency: 1,
      allowedHosts: new Set(["static.test"]),
      target,
    });
    assert.equal(graph.failed.length, 0);
    assert.equal(graph.files.length, 1);
    assert.equal(graph.files[0].size, 0);
    assert.equal(graph.files[0].emptyAllowed, true);
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("resource graph 按 KENDOO resourceMap 下载真实变体而非源素材逻辑路径", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "oaks-resource-kendoo-"));
  const root = "https://static.test/gs/clients_kendoo/game/v1/";
  const mapUrl = `${root}json/resourceMap.runpack.json`;
  const map = {
    formatVersion: 1,
    resources: {
      "images/main/bg.jpg": { variants: { default: { optimized: { path: "resources/images/main/bg.jpg", size: 10 }, avif: { path: "mirror_resources/default/avif/images/main/bg.avif", size: 5 } } } },
      "mechanics/main/normal.json": 12,
      "spines/logo/logo.json": 24,
      "sounds/mp3/spin.mp3": 36,
    },
  };
  const valid = new Set([
    mapUrl,
    `${root}resources/images/main/bg.jpg`,
    `${root}mirror_resources/default/avif/images/main/bg.avif`,
    `${root}json/mechanics/main/normal.json`,
    `${root}resources/spines/logo/logo.json`,
    `${root}resources/sounds/mp3/spin.mp3`,
  ]);
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (!valid.has(url)) return new Response("missing", { status: 404 });
    return new Response(url === mapUrl ? JSON.stringify(map) : "asset", {
      status: 200,
      headers: { "content-type": url.endsWith(".json") ? "application/json" : "application/octet-stream" },
    });
  };
  try {
    const graph = await crawlResourceGraph([new URL(mapUrl)], fetcher as typeof fetch, {
      concurrency: 3,
      allowedHosts: new Set(["static.test"]),
      target,
    });
    assert.equal(graph.failed.length, 0);
    assert.deepEqual(graph.files.map((file) => file.url), [...valid].sort());
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("resource graph 按 GOREEL 图包目录推导 WebP 和 AVIF 图集而非源 PNG", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "oaks-resource-atlas-"));
  const roots = [
    "https://static.test/gs/clients_goreel/game/v1/assets/packs/720_webp/symbols-0.json",
    "https://static.test/gs/clients_goreel/game/v1/assets/packs/720_avif/symbols-0.json",
  ];
  const expected = new Set([
    ...roots,
    "https://static.test/gs/clients_goreel/game/v1/assets/packs/720_webp/symbols-0.webp",
    "https://static.test/gs/clients_goreel/game/v1/assets/packs/720_avif/symbols-0.avif",
  ]);
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (!expected.has(url)) return new Response("missing", { status: 404 });
    const body = url.endsWith(".json") ? '{"meta":{"image":"symbols.png"}}' : "asset";
    return new Response(body, { headers: { "content-type": url.endsWith(".json") ? "application/json" : "application/octet-stream" } });
  };
  try {
    const graph = await crawlResourceGraph(roots.map((url) => new URL(url)), fetcher as typeof fetch, {
      concurrency: 2,
      allowedHosts: new Set(["static.test"]),
      target,
    });
    assert.equal(graph.failed.length, 0);
    assert.deepEqual(graph.files.map((file) => file.url), [...expected].sort());
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});
