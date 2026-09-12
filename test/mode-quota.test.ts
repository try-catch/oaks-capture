import assert from "node:assert/strict";
import test from "node:test";
import { remainingModeActions, selectedModeTypes } from "../oaks";
import type { PlayAction } from "../src/shop";

const normal: PlayAction = {name: "spin", params: {}};
const buy: PlayAction = {name: "buy_spin", params: {selected_mode: 0}, spinType: 1};
const second: PlayAction = {name: "buy_spin", params: {selected_mode: 2}, spinType: 2};
const booster: PlayAction = {name: "spin", params: {selected_mode: 1, ante_bet: 2}};
const actions = [normal, buy, second, booster];
test("模式配额分别检查普通、零编号购买、第二购买与加注", () => {
  assert.deepEqual(remainingModeActions(actions, {0: 99, 1: 10, 2: 9, 1001: 10}, 100, 10), [normal, second]);
  assert.deepEqual(remainingModeActions(actions, {0: 100, 1: 10, 2: 10, 1001: 9}, 100, 10), [booster]);
  assert.deepEqual(remainingModeActions(actions, {0: 100, 1: 10, 2: 10, 1001: 10}, 100, 10), []);
});
test("只补特殊模式不要求额外普通局，但不能漏掉零样本模式", () => {
  assert.deepEqual(remainingModeActions(actions, {1: 10}, 0, 10), [second, booster]);
});

test("配额动作可按代码声明模式过滤官方隐藏入口", () => {
  const actions: PlayAction[] = [
    {name: "spin", params: {}},
    {name: "buy_spin", params: {selected_mode: 1}, spinType: 1},
  ];
  const declared = actions.filter(action => action.spinType === undefined);
  assert.deepEqual(remainingModeActions(declared, {}, 10, 10), [actions[0]]);
});

test("重试只选择审计确认缺失的代码模式", () => {
  assert.deepEqual(selectedModeTypes([0, 1, 2, 3], [0, 3]), [0, 3]);
  assert.throws(() => selectedModeTypes([0, 1], [2]), /代码未声明/);
});
