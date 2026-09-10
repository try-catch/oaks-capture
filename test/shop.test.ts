import assert from "node:assert/strict";
import test from "node:test";
import { buildPlayableActions, discoverShop } from "../src/shop";

test("shop 只为官方可用 selected_mode 构造 buy_spin", () => {
  const start = {
    context: { current: "spins", actions: ["spin", "buy_spin"], available_buy_bonus: [1, 3], spins: { bet_per_line: 4, lines: 25 } },
    settings: { buy_bonus_prices: { 1: 30, 2: 75, 3: 150 }, booster_prices: { 1: 1.25 } },
  };
  const shop = discoverShop(start);
  assert.deepEqual(shop.buyBonuses.map((entry) => entry.providerMode), [1, 3]);
  assert.deepEqual(buildPlayableActions(start, shop), [
    { name: "spin", params: { bet_per_line: 4, lines: 25 } },
    { name: "spin", params: { bet_per_line: 4, lines: 25, ante_bet: 1.25, selected_mode: 1 } },
    { name: "buy_spin", params: { bet_per_line: 4, lines: 25, selected_mode: 1 }, spinType: 1 },
    { name: "buy_spin", params: { bet_per_line: 4, lines: 25, selected_mode: 3 }, spinType: 3 },
  ]);
});

test("shop 为零基数组构造官方模式和正整数分桶", () => {
  const start = {
    context: { current: "spins", actions: ["spin", "buy_spin"], spins: { bet_per_line: 10, lines: 5 } },
    settings: { buy_bonus_price: [65, 200, 150, 400] },
  };
  const shop = discoverShop(start);
  assert.deepEqual(shop.buyBonuses[0], {
    providerMode: 0, spinType: 1, price: 65, feature: "buy-bonus:0",
  });
  const actions = buildPlayableActions(start, shop);
  assert.deepEqual(actions[1], {
    name: "buy_spin",
    params: { bet_per_line: 10, lines: 5, selected_mode: 0 },
    spinType: 1,
  });
  assert.deepEqual(actions.at(-1), {
    name: "buy_spin",
    params: { bet_per_line: 10, lines: 5, selected_mode: 3 },
    spinType: 4,
  });
});
