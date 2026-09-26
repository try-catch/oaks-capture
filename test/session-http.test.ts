import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchText, openSession, ProtocolHttpError, ProtocolStatusError } from '../src/protocol';
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

test('官网启动页 404 只隔离当前游戏', async () => {
  const original = globalThis.fetch;
  try {
    let requests = 0;
    globalThis.fetch = async (url) => {
      requests += 1;
      assert.equal(String(url), 'https://3oaks.com/api/v1/games/sun_of_egypt/play?lang=en');
      return new Response('', { status: 404 });
    };
    await assert.rejects(openSession({ playUrl: 'https://3oaks.com/api/v1/games/sun_of_egypt/play?lang=en' } as any), error => {
      assert.ok(error instanceof ProtocolHttpError);
      assert.equal(error.status, 404);
      assert.equal(error.message, 'PLAY_PAGE_HTTP_404');
      assert.equal(gameRegistrationUnavailable(error), true);
      return true;
    });
    assert.equal(requests, 1);
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

test('官网启动配置直接连接官方试玩 API，不请求旧测试站', async () => {
  const original = globalThis.fetch;
  try {
    const urls: string[] = [];
    globalThis.fetch = async (input, options) => {
      const url = String(input);
      urls.push(url);
      if (urls.length === 1) return new Response(`})(window, ${JSON.stringify({
        options: {queue: 'queue', token: 'private'},
        desktop: {server_url: '//betman-demo.head.3oaks.com/betman-demo/gs/sun_of_egypt/desktop/{QUEUE}/demo/'},
      })}, "//betman-demo.head.3oaks.com/betman-demo/game/runner_config/");`, {
        headers: { 'set-cookie': 'site=private; Expires=Sat, 03 Oct 2026 14:00:00 GMT; Path=/' },
      });
      const body = JSON.parse(String(options?.body));
      assert.equal(new Headers(options?.headers).has('cookie'), false);
      assert.equal(new Headers(options?.headers).get('origin'), 'https://3oaks.com');
      assert.equal(new Headers(options?.headers).get('referer'), 'https://3oaks.com/');
      assert.ok(Math.abs(Date.now() - body.client_command_timestamp) < 1000);
      if (body.command === 'login') return Response.json({status: {code: 'OK'}, session_id: 'session', user: {huid: 'user'}});
      return Response.json({status: {code: 'OK'}, settings: {}, context: {}});
    };
    const session = await openSession({playUrl: 'https://3oaks.com/api/v1/games/sun_of_egypt/play?lang=en', betPerLine: 1, lines: 25, defaultBet: 25} as any);
    assert.equal(session.endpoint, 'https://betman-demo.head.3oaks.com/betman-demo/gs/sun_of_egypt/desktop/queue/demo/');
    assert.equal(urls.length, 3);
    assert.equal(session.cookie, '');
    assert.ok(urls.every(url => !url.includes('wxgame99.com')));
  } finally { globalThis.fetch = original; }
});
