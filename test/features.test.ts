import assert from "node:assert/strict";
import test from "node:test";
import { classifyRound, discoverFeatureInventory, featureNames, INVENTORY_SCHEMA_VERSION } from "../src/features";
import { parseRuntimeDefinition } from "../src/game-definition";

test("features 只用实际状态证据识别免费旋转、重触发、锁定重转和 jackpot", () => {
  const frames = [
    { context: { current: "freespins", last_action: "spin", freespins: { rounds_granted: 8 }, round_finished: false } },
    { context: { current: "freespins", last_action: "freespin", freespins: { rounds_granted: 10 }, round_finished: false } },
    { context: { current: "bonus", last_action: "bonus_init", bonus: { rounds_left: 3, bs_v: [["mini", 2]] }, round_finished: false } },
  ];
  assert.deepEqual(featureNames(frames), ["free-retrigger", "free-spins", "hold-and-win", "jackpot:mini"]);
  const evidence = classifyRound(frames).find((item) => item.name === "jackpot:mini")!;
  assert.deepEqual(evidence.frameIndexes, [2]);
  assert.match(evidence.statePaths[0], /bonus\.bs_v/);
  assert.equal(featureNames([{ context: { current: "spins", board: [["mini"]] } }]).includes("jackpot:mini"), false);
});

test("features inventory 将购买、booster、wheel 和 jackpot 子分支独立登记", () => {
  const capabilities = parseRuntimeDefinition("game", {
    desktop: { client_url: "https://static.3oaks.com/gs/clients_test/game/v1/", server_url: "https://demo.test/{QUEUE}/" },
    options: { i18n: { en: "Game" }, allow_shop: "1" },
  });
  const inventory = discoverFeatureInventory(capabilities, {
    context: { current: "spins", actions: ["spin", "buy_spin"], available_buy_bonus: [1, 2], spins: { bet_per_line: 4, lines: 25 } },
    settings: {
      buy_bonus_prices: { 1: 30, 2: 75 },
      booster_prices: { 1: 1.25 },
      jackpots: { grand: 1000, mini: 15 },
      wheel_values: ["mini", "major"],
    },
  });
  assert.equal(inventory.required.includes("buy-bonus:1"), true);
  assert.equal(inventory.required.includes("buy-bonus:2"), true);
  assert.equal(inventory.required.includes("booster:1"), true);
  assert.equal(inventory.required.includes("jackpot:grand"), true);
  assert.equal(inventory.required.includes("wheel:major"), true);
  assert.equal(inventory.required.includes("bonus-buy"), false);
  assert.equal(inventory.schemaVersion, INVENTORY_SCHEMA_VERSION);
  assert.match(inventory.buyModesFingerprint, /1:1:30/);
});

test("features inventory 不把没有模式的通用 bonus-buy 当作门槛", () => {
  const capabilities = parseRuntimeDefinition("game", {
    desktop: { client_url: "https://static.3oaks.com/gs/clients_test/game/v1/", server_url: "https://demo.test/{QUEUE}/" },
    options: { i18n: { en: "Game" }, allow_shop: "1" },
  });
  capabilities.featureHints = ["bonus-buy"];
  const inventory = discoverFeatureInventory(capabilities, {
    context: { current: "spins", actions: ["spin", "buy_spin"], spins: { bet_per_line: 4, lines: 25 } },
    settings: {},
  });
  assert.equal(inventory.required.includes("bonus-buy"), false);
});

test("features 购买分支只相信首帧 buy_spin 参数，不误用后续内部 selected_mode", () => {
  const frames = [
    { context: { current: "bonus", last_action: "buy_spin", last_args: { selected_mode: 1 }, bonus: { selected_mode: 2 } } },
    { context: { current: "bonus", last_action: "buy_spin", last_args: {}, bonus: { selected_mode: 3 } } },
  ];
  assert.equal(featureNames(frames).includes("buy-bonus:1"), true);
  assert.equal(featureNames(frames).includes("buy-bonus:2"), false);
  assert.equal(featureNames(frames).includes("buy-bonus:3"), false);
  assert.equal(featureNames([{ context: {
    current: "bonus", last_action: "buy_spin", last_args: { selected_mode: 0 }, bonus: {},
  } }]).includes("buy-bonus:0"), true);
});
