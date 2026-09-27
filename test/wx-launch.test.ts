import assert from 'node:assert/strict';
import test from 'node:test';
import { isWxLaunchUrl } from '../src/wx-launch';

test('只接受指定游戏在 wx 站的 HTTPS 启动页', () => {
  assert.equal(isWxLaunchUrl('https://3oaks.ssgfivegame.com/api/v1/games/lucky_penny_2/play?token=x', 'lucky_penny_2'), true);
  assert.equal(isWxLaunchUrl('https://3oaks.ssgfivegame.com/api/v1/games/grand/play', 'lucky_penny_2'), false);
  assert.equal(isWxLaunchUrl('http://3oaks.ssgfivegame.com/api/v1/games/lucky_penny_2/play', 'lucky_penny_2'), false);
});
