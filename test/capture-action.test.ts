import assert from "node:assert/strict";
import test from "node:test";
import { chooseAction, retryDelayMs } from "../oaks";
import { GAME_SWITCH_DELAY_MS, SPIN_DELAY_MS } from "../config";
import type { PlayAction } from "../src/shop";
import { actionSpinType, BOOSTER_SPIN_TYPE_OFFSET, protocolAction, ProtocolHttpError, roundSpinType } from "../src/protocol";

const actions: PlayAction[] = [
  { name: "spin", params: { bet_per_line: 4, lines: 25 } },
  { name: "buy_spin", params: { bet_per_line: 4, lines: 25, selected_mode: 1 } },
  { name: "buy_spin", params: { bet_per_line: 4, lines: 25, selected_mode: 2 } },
];

test("采集器只执行当前要求且尚未达标的定向玩法", () => {
  assert.equal(chooseAction(actions, {}, 10, ["buy-bonus:2"]).params.selected_mode, 2);
  assert.equal(chooseAction(actions, { "buy-bonus:2": 10 }, 10, ["buy-bonus:2"]).name, "spin");
});

test("直接购买目标完成后继续选择能产出缺失随机分支的动作", () => {
  const counts = { "buy-bonus:1": 10, "buy-bonus:2": 10, "jackpot:grand": 0 };
  const evidence = { "buy-bonus:1": new Set(["hold-and-win", "jackpot:grand"]) };
  assert.equal(chooseAction(actions, counts, 10, ["buy-bonus:1", "buy-bonus:2", "jackpot:grand"], evidence).params.selected_mode, 1);
  assert.equal(chooseAction(actions, counts, 10, ["jackpot:grand"], {}, 0).name, "spin");
  assert.equal(chooseAction(actions, counts, 10, ["jackpot:grand"], {}, 1).params.selected_mode, 1);
});

test("普通输赢尚未齐全时优先执行基础 spin", () => {
  assert.equal(chooseAction(actions, {}, 10, ["base-loss", "base-or-feature-win", "buy-bonus:2"]).name, "spin");
});

test("购买模式和 booster 使用互不冲突的 spinType", () => {
  assert.equal(actionSpinType(actions[0]), 0);
  assert.equal(actionSpinType(actions[1]), 1);
  assert.equal(actionSpinType({ name: "spin", params: { ante_bet: 1.25, selected_mode: 1 } }), BOOSTER_SPIN_TYPE_OFFSET + 1);
  assert.equal(roundSpinType([{ context: { last_action: "spin", last_args: { ante_bet: 4, selected_mode: 2 } } }], 0), BOOSTER_SPIN_TYPE_OFFSET + 2);
  assert.equal(roundSpinType([{ context: { last_action: "buy_spin", last_args: { selected_mode: 3 } } }], 1), 3);
  const zeroBased: PlayAction = {
    name: "buy_spin", params: { bet_per_line: 10, lines: 5, selected_mode: 0 }, spinType: 1,
  };
  assert.equal(actionSpinType(zeroBased), 1);
  assert.equal(roundSpinType([{ context: { last_action: "buy_spin", last_args: { selected_mode: 0 } } }], 1), 1);
  assert.deepEqual(protocolAction(zeroBased), { name: "buy_spin", params: zeroBased.params });
  assert.equal("spinType" in protocolAction(zeroBased), false);
});

test("协议限流完整遵守 Retry-After，普通错误按指数退避", () => {
  assert.equal(retryDelayMs(new ProtocolHttpError("429", 429, 35_000), 1), 35_000);
  assert.equal(retryDelayMs(new ProtocolHttpError("429", 429, 120_000), 2), 120_000);
  assert.equal(retryDelayMs(new Error("network"), 3), 8_000);
});

test("默认采集节奏为三秒且游戏切换等待十秒", () => {
  assert.equal(SPIN_DELAY_MS, 3_000);
  assert.equal(GAME_SWITCH_DELAY_MS, 10_000);
});
