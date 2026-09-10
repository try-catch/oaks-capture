import assert from "node:assert/strict";
import test from "node:test";
import { classify, frameCumulativeWin, nextAction, roundWin, validateRound } from "../src/protocol";

test("round 分支与赢分识别", () => {
  const frames = [
    { context: { round_finished: false, actions: ["freespin"], last_win: 380, current: "freespins", freespins: { total_win: 25 } } },
    { context: { round_finished: true, actions: ["spin"], last_win: 75, current: "freespins", freespins: { total_win: 75 } } },
  ];
  assert.equal(nextAction(frames[0]), "freespin");
  assert.equal(nextAction(frames[1]), undefined);
  assert.equal(roundWin(frames), 75);
  assert.ok(classify(frames).includes("freespins"));
});

test("当前局为 0 时不能把上一局 last_win 当成派奖", () => {
  const frames = [{
    status: { code: "OK" },
    context: {
      current: "spins", last_action: "spin", actions: ["spin"], round_finished: true,
      last_win: 475, spins: { total_win: 0, round_win: 0 },
    },
  }];
  assert.equal(roundWin(frames), 0);
  assert.equal(frameCumulativeWin(frames[0]), 0);
  assert.equal(validateRound(frames, 25).win, 0);
});

test("多帧特殊局校验动作链与累计赢分", () => {
  const frames = [
    { status: { code: "OK" }, context: { current: "spins", last_action: "spin", actions: ["freespin_init"], round_finished: false, spins: { total_win: 25 } } },
    { status: { code: "OK" }, context: { current: "freespins", last_action: "freespin_init", actions: ["freespin"], round_finished: false, freespins: { total_win: 25 } } },
    { status: { code: "OK" }, context: { current: "spins", last_action: "freespin", actions: ["spin"], round_finished: true, spins: { total_win: 75 } } },
  ];
  assert.deepEqual(validateRound(frames, 25).cumulativeWins, [25, 25, 75]);
});

test("缺失当前局结算字段时拒绝采集", () => {
  assert.throws(() => roundWin([{ context: { round_finished: true, last_win: 100 } }]), /缺少当前局/);
});

test("普通转轴出现 Mini 字样不能误报 jackpot", () => {
  const frames = [{
    context: {
      current: "spins", last_action: "spin", actions: ["spin"], round_finished: true,
      spins: { total_win: 0, round_win: 0, bs_v: [[0, "mini", 0]] },
    },
  }];
  assert.equal(classify(frames).includes("mini-jackpot"), false);
});

test("只在 Hold & Win bonus 盘面标记实际 jackpot", () => {
  const frames = [{
    context: {
      current: "bonus", last_action: "respin", actions: ["spin"], round_finished: true,
      bonus: { total_win: 5025, round_win: 5025, rounds_left: 0, bs_count: 15, bs_v: [["mini", "major"]] },
    },
  }];
  const features = classify(frames);
  assert.ok(features.includes("mini-jackpot"));
  assert.ok(features.includes("major-jackpot"));
  assert.ok(features.includes("grand-full-board"));
  assert.ok(features.includes("grand-jackpot"));
});

test("Hold & Win 按锁定 Sun 加 Mini/Major/Grand 规则校验", () => {
  const frames = [
    {
      status: { code: "OK" },
      context: {
        current: "spins", last_action: "spin", actions: ["bonus_init"], round_finished: false,
        spins: { total_win: 0, round_win: 0 },
      },
    },
    {
      status: { code: "OK" },
      context: {
        current: "bonus", last_action: "bonus_init", actions: ["spin"], round_finished: true,
        bonus: {
          total_win: 30200, round_win: 30200, rounds_left: 0, bs_count: 15,
          bs_v: [[100, "mini", "major"], [600, 0, 0]],
        },
      },
    },
  ];
  assert.equal(validateRound(frames, 25).win, 30200);
  (frames[1].context.bonus as Record<string, unknown>).round_win = 30199;
  assert.throws(() => validateRound(frames, 25), /Hold & Win 派奖不符/);
});
