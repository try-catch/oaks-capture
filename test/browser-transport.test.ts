import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { browserFetch, closeBrowserTransport, fetchFailureDiagnostic, requestMetadata, safeNetworkFailure } from '../src/browser-transport';

test('请求诊断只保留来源主机和固定协议字段', () => {
  assert.deepEqual(requestMetadata({origin:'https://3oaks.com',referer:'https://3oaks.com/game/grand?token=secret',
    'content-type':'text/plain','sec-fetch-site':'cross-site','user-agent':'Chrome/142 token=secret',cookie:'secret'}),
    {origin:'3oaks.com',referer:'3oaks.com',contentType:'text/plain',fetchSite:'cross-site',browserMajor:'142'});
  assert.deepEqual(requestMetadata({Origin:'https://3oaks.com',Referer:'https://3oaks.com/',
    'Content-Type':'text/plain','Sec-Fetch-Site':'same-site','User-Agent':'Chrome/153'}),
    {origin:'3oaks.com',referer:'3oaks.com',contentType:'text/plain',fetchSite:'same-site',browserMajor:'153'});
});

test('网络失败诊断区分阶段且不泄露URL或异常内容', () => {
  assert.equal(safeNetworkFailure('net::ERR_CONNECTION_RESET'), 'net::ERR_CONNECTION_RESET');
  assert.equal(safeNetworkFailure('net::ERR_FAILED token=secret'), 'other_network_failure');
  assert.equal(safeNetworkFailure(undefined), 'none');
  const error = new Error('page.waitForResponse: Timeout 20000ms token=secret');
  assert.deepEqual(fetchFailureDiagnostic('https://3oaks.com/?gsc=login&token=secret', error),
    { command: 'login', kind: 'response_timeout' });
  assert.deepEqual(fetchFailureDiagnostic('https://3oaks.com/?gsc=secret', error),
    { command: 'unknown', kind: 'response_timeout' });
  assert.deepEqual(fetchFailureDiagnostic('secret', new Error('secret')),
    { command: 'unknown', kind: 'fetch_failed' });
  assert.deepEqual(fetchFailureDiagnostic('https://3oaks.com/', new DOMException('secret', 'AbortError')),
    { command: 'launch', kind: 'aborted' });
  assert.equal(fetchFailureDiagnostic('https://3oaks.com/?gsc=start', new DOMException('', 'TimeoutError')).kind, 'timeout');
});

test('原生浏览器传输保留响应、限速头并隔离客户端请求头', async () => {
  const original = chromium.launch;
  let launches = 0, closes = 0, status = 200;
  let fail = false, failedStatus = 403;
  let lateHeaders = false;
  const listeners = new Map<string, (request: any) => void>();
  const networkListeners = new Map<string, (event: any) => void>();
  let detached = 0;
  let sent: any;
  const payload = Buffer.from('{"status":{"code":"OK"},"value":"完整响应"}');
  const page = {
    context: () => ({ newCDPSession: async () => ({
      on: (event: string, listener: (event: any) => void) => { networkListeners.set(event, listener); },
      send: async () => {}, detach: async () => {
        detached++; networkListeners.clear();
        if (fail) await new Promise(() => {}); // 浏览器关闭后的清理挂起不得吞掉原始异常。
      },
    }) }),
    on: (event: string, listener: (request: any) => void) => { listeners.set(event, listener); },
    off: (event: string) => { listeners.delete(event); },
    goto: async () => ({ ok: () => true }),
    waitForResponse: async () => {
      if (fail) {
        return await new Promise<any>(() => {}); // 没有 response 事件，必须由网络失败路径结束。
      }
      return ({
      allHeaders: async () => ({ 'retry-after': '3600', 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '12', 'set-cookie': 'demo=one; Path=/\nother=two; Path=/' }),
      body: async () => payload, status: () => status, ok: () => status === 200,
    }); },
    evaluate: async (_: unknown, request: any) => {
      sent = request;
      if (fail) {
        networkListeners.get('Network.requestWillBeSent')?.({ requestId: 'one', request: { url: request.url, method: request.method } });
        const extra = () => networkListeners.get('Network.responseReceivedExtraInfo')?.({ requestId: 'one', statusCode: failedStatus, headers: { 'Retry-After': '3600' } });
        if (!lateHeaders) extra();
        const native = { url: () => request.url, method: () => request.method,
          failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }) };
        listeners.get('request')?.(native);
        listeners.get('requestfailed')?.(native);
        networkListeners.get('Network.loadingFailed')?.({ requestId: 'one', errorText: 'net::ERR_CONNECTION_RESET',
          corsErrorStatus: failedStatus ? { corsError: 'MissingAllowOriginHeader' } : undefined });
        if (lateHeaders) extra();
        return 'type_error';
      }
      return 'resolved';
    },
  };
  chromium.launch = (async () => {
    launches++;
    return { newContext: async () => ({ newPage: async () => page }), close: async () => { closes++; } };
  }) as unknown as typeof chromium.launch;
  try {
    await assert.rejects(browserFetch('https://example.com/'), /只允许官方/);
    await assert.rejects(browserFetch('https://3oaks.com/', { signal: AbortSignal.abort() }), /abort/i);
    assert.equal(launches, 0);
    const response = await browserFetch('https://betman-demo.head.3oaks.com/demo/?gsc=login', {
      method: 'POST', body: '{"command":"login"}',
      headers: { 'content-type': 'text/plain', origin: 'https://wrong.example', cookie: 'other-session', 'user-agent': 'fake' },
    });
    assert.equal(await response.text(), payload.toString());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('retry-after'), '3600');
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(sent.headers, { 'content-type': 'text/plain' });
    assert.equal(sent.body, '{"command":"login"}');
    status = 429;
    const limited = await browserFetch('https://3oaks.com/');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '3600');
    assert.equal(launches, 1);
    await closeBrowserTransport();
    assert.equal(closes, 1);
    await browserFetch('https://3oaks.com/');
    assert.equal(launches, 2);
    fail = true;
    const denied = await browserFetch('https://3oaks.com/?gsc=login&token=secret');
    assert.equal(denied.status, 403);
    assert.equal(await denied.text(), '');
    failedStatus = 429;
    lateHeaders = true;
    const corsLimited = await browserFetch('https://3oaks.com/?gsc=login&token=secret');
    assert.equal(corsLimited.status, 429);
    assert.equal(corsLimited.headers.get('retry-after'), '3600');
    failedStatus = 0;
    lateHeaders = false;
    await assert.rejects(browserFetch('https://3oaks.com/?gsc=login&token=secret'), error => {
      assert.deepEqual(fetchFailureDiagnostic('https://3oaks.com/?gsc=login', error), {
        command: 'login', kind: 'fetch_failed', network: 'net::ERR_CONNECTION_RESET',
        pageFetch: 'type_error', requestSeen: true,
        httpStatus: 0, cors: 'none', blocked: 'none',
      });
      return true;
    });
    assert.equal(listeners.size, 0);
    assert.equal(networkListeners.size, 0);
    assert.equal(detached, 6);
  } finally { await closeBrowserTransport(); chromium.launch = original; }
});
