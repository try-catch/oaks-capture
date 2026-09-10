import assert from "node:assert/strict";
import test from "node:test";
import { emptyRegistry, syncCatalog } from "../src/catalog";
import { selectGames } from "../src/cli";
import { validateCommonRound } from "../src/validators/common";
import { validateGameRound } from "../src/validators";

const registry = syncCatalog(emptyRegistry(), [
  { name: "sun_of_egypt", title_text: "Sun of Egypt", has_page: true, provider: "3oaks" },
  { name: "other", title_text: "Other", has_page: true, provider: "3oaks" },
]);

test("select games 支持单游戏和全目录", () => {
  assert.deepEqual(selectGames(["--game", "sun_of_egypt"], registry).map((game) => game.slug), ["sun_of_egypt"]);
  assert.equal(selectGames(["--all"], registry).length, 2);
});

test("validator 将通用动作链与 Sun of Egypt jackpot 规则分层", () => {
  const frames: any[] = [{ status: { code: "OK" }, context: {
    current: "bonus", last_action: "spin", actions: ["spin"], round_finished: true,
    bonus: { total_win: 1, round_win: 1, rounds_left: 0, bs_count: 15, bs_v: [["mini"]] },
  } }];
  assert.doesNotThrow(() => validateCommonRound(frames, 25));
  const sun = registry.games.find((game) => game.slug === "sun_of_egypt")!;
  assert.throws(() => validateGameRound(sun, frames, 25), /Hold & Win/);
});
