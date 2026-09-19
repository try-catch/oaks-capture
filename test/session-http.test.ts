import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchText, ProtocolHttpError, ProtocolStatusError } from '../src/protocol';
import { permanentSessionError } from '../oaks';

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
