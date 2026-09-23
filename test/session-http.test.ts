import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchLaunchUrl, fetchText, launchApiEndpoint, ProtocolHttpError, ProtocolStatusError } from '../src/protocol';
import { gameRegistrationUnavailable, permanentSessionError } from '../oaks';

test('启动页 HTTP 错误保留状态和 Retry-After，不能泄露 URL token', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('', { status: 429, headers: { 'retry-after': '90' } });
    await assert.rejects(fetchText('https://example.invalid/play?token=private'), error => {
      assert.ok(error instanceof ProtocolHttpError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 90000);
      assert.equal(error.message, 'LAUNCH_HTTP_429');
      assert.equal(permanentSessionError(error), false);
      return true;
    });
  } finally { globalThis.fetch = original; }
});

test('明确拒绝和不存在的入口不重复重试，暂时性故障仍可恢复', () => {
  for (const status of [401, 403, 404, 410]) assert.equal(permanentSessionError(new ProtocolHttpError('', status, 0)), true);
  for (const code of ['GAME_NOT_ALLOWED', 'PLAYER_LOCKOUT']) assert.equal(permanentSessionError(new ProtocolStatusError(code, '')), true);
  assert.equal(permanentSessionError(new ProtocolHttpError('', 503, 0)), false);
  assert.equal(permanentSessionError(new ProtocolStatusError('SESSION_EXPIRED', '')), false);
  assert.equal(permanentSessionError(new Error('network')), false);
});

test('只跳过当前不可注册游戏，账号和节点封控不能被降级为跳过', () => {
  assert.equal(gameRegistrationUnavailable(new ProtocolHttpError('', 404, 0)), true);
  assert.equal(gameRegistrationUnavailable(new ProtocolHttpError('', 410, 0)), true);
  assert.equal(gameRegistrationUnavailable(new ProtocolStatusError('GAME_NOT_ALLOWED', '')), true);
  assert.equal(gameRegistrationUnavailable(new ProtocolHttpError('', 401, 0)), false);
  assert.equal(gameRegistrationUnavailable(new ProtocolHttpError('', 403, 0)), false);
  assert.equal(gameRegistrationUnavailable(new ProtocolStatusError('PLAYER_LOCKOUT', '')), false);
});

test('新测试站生成启动地址并拒绝非预期域名', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, options) => {
      const body = JSON.parse(String(options?.body));
      assert.equal(body.gameId, 'sun_of_egypt');
      assert.equal(body.gameBrand, '3oaks');
      return Response.json({ success: true, data: 'https://3oaks.ssgfivegame.com/api/v1/games/sun_of_egypt/play?token=secret' });
    };
    assert.match(await fetchLaunchUrl('https://3oaks.com/api/v1/games/sun_of_egypt/play?lang=en'), /ssgfivegame\.com/);
    globalThis.fetch = async () => Response.json({ success: true, data: 'https://evil.example/api/v1/games/sun_of_egypt/play?token=secret' });
    await assert.rejects(fetchLaunchUrl('https://3oaks.com/api/v1/games/sun_of_egypt/play?lang=en'), /非预期/);
  } finally { globalThis.fetch = original; }
});

test('新测试站会话使用配套 API 代理域名', () => {
  assert.equal(
    launchApiEndpoint('//betman-demo.head.3oaks.com/betman-demo/gs/sun_of_egypt/desktop/{QUEUE}/demo/', 'abc', 'https://3oaks.ssgfivegame.com/api/v1/games/sun_of_egypt/play?token=x'),
    'https://3oaks-api.ssgfivegame.com/betman-demo/gs/sun_of_egypt/desktop/abc/demo/',
  );
});
