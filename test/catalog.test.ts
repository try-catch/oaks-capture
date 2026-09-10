import assert from "node:assert/strict";
import test from "node:test";
import { emptyRegistry, fetchOfficialCatalog, syncCatalog } from "../src/catalog";

test("catalog 保持稳定 ID 并只追加分配", () => {
  const existing = emptyRegistry();
  const result = syncCatalog(existing, [
    { name: "new_game", title_text: "New Game", has_page: true, provider: "3oaks", release_date: "2026-09-01" },
    { name: "sun_of_egypt", title_text: "Sun of Egypt", has_page: true, provider: "3oaks", release_date: "2019-11-28" },
  ]);
  assert.equal(result.games.find((game) => game.slug === "sun_of_egypt")?.gameId, 32601);
  assert.equal(result.games.find((game) => game.slug === "new_game")?.gameId, 32602);
});

test("catalog 分页、去重并过滤非 3oaks 页面", async () => {
  const seen: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    seen.push(url.searchParams.get("page_num") ?? "");
    const page = Number(url.searchParams.get("page_num"));
    return new Response(JSON.stringify({ data: { total_pages: 2, items: page === 1 ? [
      { name: "one", title_text: "One", has_page: true, provider: "3oaks" },
      { name: "ignored", title_text: "Ignored", has_page: false, provider: "3oaks" },
    ] : [
      { name: "one", title_text: "One", has_page: true, provider: "3oaks" },
      { name: "two", title_text: "Two", has_page: true, provider: "3oaks" },
    ] } }), { status: 200 });
  };
  const games = await fetchOfficialCatalog(fetcher as typeof fetch);
  assert.deepEqual(seen, ["1", "2"]);
  assert.deepEqual(games.map((game) => game.name), ["one", "two"]);
});
