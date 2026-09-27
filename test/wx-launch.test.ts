import assert from 'node:assert/strict';
import test from 'node:test';
import { isWxLaunchUrl, wxLaunchUrl } from '../src/wx-launch';

test('只接受指定游戏在 wx 站的 HTTPS 启动页', () => {
  assert.equal(isWxLaunchUrl('https://3oaks.ssgfivegame.com/api/v1/games/lucky_penny_2/play?token=x', 'lucky_penny_2'), true);
  assert.equal(isWxLaunchUrl('https://3oaks.ssgfivegame.com/api/v1/games/grand/play', 'lucky_penny_2'), false);
  assert.equal(isWxLaunchUrl('http://3oaks.ssgfivegame.com/api/v1/games/lucky_penny_2/play', 'lucky_penny_2'), false);
});

test('按历史 game_link 协议直接取得指定游戏链接', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://www.wxgame99.com/api/game_link');
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.gameId, 'lucky_penny_2');
      assert.equal(body.gameBrand, '3oaks');
      assert.match(body.token, /^1001_[a-f0-9]{32}$/);
      return Response.json({ success: true, data: 'https://3oaks.ssgfivegame.com/api/v1/games/lucky_penny_2/play?token=x' });
    };
    assert.equal(await wxLaunchUrl('lucky_penny_2'),
      'https://3oaks.ssgfivegame.com/api/v1/games/lucky_penny_2/play?token=x');
  } finally { globalThis.fetch = original; }
});

test('旧站未提供该游戏时保留明确分类', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ success: false });
    await assert.rejects(wxLaunchUrl('grand'), /WX_SOURCE_UNAVAILABLE/);
  } finally { globalThis.fetch = original; }
});
