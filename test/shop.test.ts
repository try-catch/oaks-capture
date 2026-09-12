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

test("购买请求保留与线数不同的官方 bet_factor", () => {
  const start = {settings: {bet_factor: [20], buy_bonus_prices: {1: 75, 2: 150}}, context: {current: "spins", actions: ["spin", "buy_spin"], spins: {bet_per_line: 5, lines: 25}}};
  const actions = buildPlayableActions(start, discoverShop(start));
  assert.deepEqual(actions[0].params, {bet_per_line: 5, lines: 25});
  assert.deepEqual(actions[1].params, {bet_per_line: 5, lines: 25, bet_factor: 20, selected_mode: 1});
  assert.equal(actions[2].params.bet_factor, 20);
});

test("普通与加注走 Runner 参数，不混入购买专用 bet_factor", () => {
  const start = {settings: {bet_factor: [20], booster_prices: {1: 1.25}}, context: {current: "spins", actions: ["spin"], spins: {bet_per_line: 5, lines: 20}}};
  assert.deepEqual(buildPlayableActions(start, discoverShop(start)), [
    {name: "spin", params: {bet_per_line: 5, lines: 20}},
    {name: "spin", params: {bet_per_line: 5, lines: 20, ante_bet: 1.25, selected_mode: 1}},
  ]);
});

test("Kendoo 可切换线数购买不携带 bet_factor", () => {
  const start = {settings: {bet_factor: [10, 20, 30], buy_bonus_prices: {1: 50}}, context: {current: "spins", actions: ["spin", "buy_spin"], spins: {bet_per_line: 10, lines: 1}}};
  const actions = buildPlayableActions(start, discoverShop(start), "clients_kendoo");
  assert.deepEqual(actions[1].params, {bet_per_line: 10, lines: 1, selected_mode: 1});
});

test("优先使用官方允许的最低下注采集", () => {
  const start = {settings: {bets: [5, 2, 10]}, context: {current: "spins", actions: ["spin"], spins: {bet_per_line: 5, lines: 20}}};
  const actions = buildPlayableActions(start, discoverShop(start));
  assert.deepEqual(actions[0].params, {bet_per_line: 2, lines: 20});
});

test("服务拒绝 bet_factor 后可按购买档位回退官方简化参数", () => {
  const start = {settings: {bet_factor: [50], buy_bonus_prices: {1: 75}}, context: {current: "spins", actions: ["spin", "buy_spin"], spins: {bet_per_line: 2, lines: 25}}};
  const actions = buildPlayableActions(start, discoverShop(start), "clients_hraymo", new Set([1]));
  assert.deepEqual(actions[1].params, {bet_per_line: 2, lines: 25, selected_mode: 1});
});

test("服务要求字符串模式时可按购买档位回退", () => {
  const start = {settings: {buy_bonus_prices: {1: 75}}, context: {current: "spins", actions: ["spin", "buy_spin"], spins: {bet_per_line: 2, lines: 25}}};
  const actions = buildPlayableActions(start, discoverShop(start), "clients_hraymo", new Set(), new Set([1]));
  assert.deepEqual(actions[1].params, {bet_per_line: 2, lines: 25, selected_mode: "1"});
});
