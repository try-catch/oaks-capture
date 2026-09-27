import { chromium, type Browser, type Page, type Request as BrowserRequest } from 'playwright';
import { REQUEST_TIMEOUT_MS } from '../config';
import { ProtocolHttpError } from './protocol';

// 每个 worker 进程独享一个原生浏览器上下文；不同节点、线程不共享 Cookie 或试玩用户。
let session: Promise<{ browser: Browser; page: Page }> | undefined;
const browserFailures = new WeakMap<Error, { network: string; pageFetch: string; requestSeen: boolean; httpStatus: number; cors: string; blocked: string }>();

export function safeNetworkFailure(value: string | undefined): string {
  return ['net::ERR_FAILED', 'net::ERR_ABORTED', 'net::ERR_TIMED_OUT', 'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_CLOSED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_HTTP2_PROTOCOL_ERROR', 'net::ERR_BLOCKED_BY_CLIENT'].includes(value ?? '')
    ? value! : value ? 'other_network_failure' : 'none';
}

// 只比较协议相关的固定元信息；令牌、Cookie、完整 URL 和原始 UA 不进入日志。
export function requestMetadata(headers: Record<string, string>): Record<string, string> {
  headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const host = (value: string | undefined) => {
    try { return value ? new URL(value).hostname : 'none'; } catch { return 'invalid'; }
  };
  const site = headers['sec-fetch-site'] ?? '';
  return {
    origin: host(headers.origin), referer: host(headers.referer),
    contentType: headers['content-type'] === 'text/plain' ? 'text/plain' : 'other',
    fetchSite: ['same-origin', 'same-site', 'cross-site', 'none'].includes(site) ? site : 'missing',
    browserMajor: /Chrome\/(\d+)/.exec(headers['user-agent'] ?? '')?.[1] ?? 'other',
  };
}

// 公开诊断只输出白名单阶段与固定类别，不携带 URL、令牌或原始异常。
export function fetchFailureDiagnostic(url: string, error: unknown): { command: string; kind: string } {
  let command = 'unknown';
  try {
    const value = new URL(url).searchParams.get('gsc') ?? 'launch';
    if (['launch', 'login', 'start', 'play', 'logout'].includes(value)) command = value;
  } catch { /* 非法 URL 也不得回显 */ }
  const message = error instanceof Error ? error.message : '';
  const kind = /page\.waitForResponse: Timeout/.test(message) ? 'response_timeout'
    : error instanceof Error && error.name === 'TimeoutError' ? 'timeout'
    : error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'fetch_failed';
  return { command, kind, ...(error instanceof Error ? browserFailures.get(error) : undefined) };
}

async function browserPage(): Promise<Page> {
  session ??= (async () => {
    const browser = await chromium.launch({ headless: true,
      ...(process.env.OAKS_BROWSER_CHANNEL === 'chrome' ? { channel: 'chrome' as const } : {}) });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const response = await page.goto('https://3oaks.com/', { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS });
      if (!response?.ok()) throw new ProtocolHttpError('BROWSER_BOOTSTRAP_HTTP_' + response?.status(), response?.status() ?? 0, 0);
      return { browser, page };
    } catch (error) { await browser.close(); throw error; }
  })().catch(error => { session = undefined; throw error; });
  return (await session).page;
}

export async function closeBrowserTransport(): Promise<void> {
  const current = session;
  session = undefined;
  if (current) await current.then(value => value.browser.close()).catch(() => {});
}

export const browserFetch: typeof fetch = async (input, options = {}) => {
  const url = input instanceof Request ? input.url : String(input);
  const target = new URL(url);
  if (target.protocol !== 'https:' || !(target.hostname === '3oaks.com' || target.hostname.endsWith('.3oaks.com'))) {
    throw new Error('浏览器采集只允许官方 HTTPS 地址');
  }
  if (options.body != null && typeof options.body !== 'string') throw new Error('浏览器采集只支持文本请求体');
  options.signal?.throwIfAborted();
  const abort = () => { void closeBrowserTransport(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const page = await browserPage();
    options.signal?.throwIfAborted();
    const method = options.method ?? 'GET';
    const headers = new Headers(options.headers);
    // 浏览器负责真实的来源、Cookie 和客户端请求头，不伪造浏览器指纹。
    for (const name of ['origin', 'referer', 'cookie', 'user-agent', 'host', 'content-length', 'accept-encoding']) headers.delete(name);
    const body = options.body as string | undefined;
    const diagnostic = { network: 'none', pageFetch: 'pending', requestSeen: false, httpStatus: 0, cors: 'none', blocked: 'none' };
    let failed = false, retryAfter = '';
    let resolveFailure!: (response: Response) => void;
    let rejectFailure!: (error: Error) => void;
    const failure = new Promise<Response>((resolve, reject) => { resolveFailure = resolve; rejectFailure = reject; });
    const settleFailure = () => {
      if (!failed || (!diagnostic.httpStatus && diagnostic.cors !== 'none')) return;
      // 只恢复失败状态及限速头，不读取或放行被 CORS 拦截的成功响应。
      if (diagnostic.httpStatus >= 400) resolveFailure(new Response(null, {
        status: diagnostic.httpStatus, headers: retryAfter ? { 'retry-after': retryAfter } : {},
      }));
      else rejectFailure(new TypeError('fetch failed'));
    };
    // CORS 拒绝时 Playwright 可能没有 response 事件；只取原生网络元数据，不输出地址、头或正文。
    const network = await page.context().newCDPSession(page);
    const requestIds = new Set<string>();
    const pendingHeaders = new Map<string, Record<string, string>>();
    const reportWireHeaders = (id: string, value: Record<string, string>) => {
      if (process.env.OAKS_HEADER_DIAG === '1' && target.searchParams.get('gsc') === 'login') {
        console.error(JSON.stringify({ phase: 'wire-request-metadata', command: 'login', ...requestMetadata(value) }));
      }
      pendingHeaders.delete(id);
    };
    network.on('Network.requestWillBeSent', event => {
      if (event.request.url === url && event.request.method === method) {
        requestIds.add(event.requestId);
        const value = pendingHeaders.get(event.requestId);
        if (value) reportWireHeaders(event.requestId, value);
      }
    });
    network.on('Network.requestWillBeSentExtraInfo', event => {
      const value = Object.fromEntries(Object.entries(event.headers ?? {}).map(([key, item]) => [key, String(item)]));
      if (requestIds.has(event.requestId)) reportWireHeaders(event.requestId, value);
      else pendingHeaders.set(event.requestId, value);
    });
    network.on('Network.responseReceivedExtraInfo', event => {
      if (!requestIds.has(event.requestId)) return;
      diagnostic.httpStatus = event.statusCode;
      retryAfter = String(Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1] ?? '');
      settleFailure();
    });
    network.on('Network.loadingFailed', event => {
      if (!requestIds.has(event.requestId)) return;
      diagnostic.network = safeNetworkFailure(event.errorText);
      const cors = event.corsErrorStatus?.corsError;
      diagnostic.cors = !cors ? 'none' : ['MissingAllowOriginHeader', 'AllowOriginMismatch',
        'InvalidAllowOriginValue', 'PreflightMissingAllowOriginHeader', 'PreflightInvalidStatus',
        'InsecurePrivateNetwork', 'InvalidResponse', 'WildcardOriginNotAllowed'].includes(cors) ? cors : 'other_cors';
      const blocked = event.blockedReason;
      diagnostic.blocked = !blocked ? 'none' : ['csp', 'mixed-content', 'origin', 'inspector',
        'subresource-filter', 'other'].includes(blocked) ? blocked : 'other_blocked';
      console.error(JSON.stringify({ phase: 'browser-network-failure', command: fetchFailureDiagnostic(url, null).command, ...diagnostic }));
      failed = true;
      settleFailure();
    });
    const matches = (request: BrowserRequest) => request.url() === url && request.method() === method;
    const onRequest = (request: BrowserRequest) => {
      if (!matches(request)) return;
      diagnostic.requestSeen = true;
      if (process.env.OAKS_HEADER_DIAG === '1' && target.searchParams.get('gsc') === 'login') {
        void request.allHeaders().then(value => console.error(JSON.stringify({ phase: 'request-metadata',
          command: 'login', ...requestMetadata(value) }))).catch(() => {});
      }
    };
    const onFailed = (request: BrowserRequest) => {
      if (matches(request)) diagnostic.network = safeNetworkFailure(request.failure()?.errorText);
    };
    page.on('request', onRequest);
    page.on('requestfailed', onFailed);
    try {
    await network.send('Network.enable');
    const result = await Promise.race([failure, Promise.all([
      page.waitForResponse(response => response.url() === url && response.request().method() === method,
        { timeout: REQUEST_TIMEOUT_MS }),
      page.evaluate(async request => {
        try {
          const response = await fetch(request.url, { method: request.method, headers: request.headers,
            body: request.body, credentials: 'same-origin', signal: AbortSignal.timeout(request.timeout) });
          await response.arrayBuffer();
          return 'resolved';
        } catch (error) {
          // 只传固定分类；原始异常可能携带 URL/令牌，不回传。
          const name = error instanceof Error ? error.name : '';
          return name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'aborted'
            : name === 'TypeError' ? 'type_error' : 'other_error';
        }
      }, { url, method, headers: Object.fromEntries(headers), body, timeout: REQUEST_TIMEOUT_MS })
        .then(result => { diagnostic.pageFetch = result; }),
    ])]);
    if (result instanceof Response) return result;
    const [response] = result;
    // 页面 JS 不能读取未被 CORS 暴露的 Retry-After；从原生网络响应保留全部限速头。
    const responseHeaders = await response.allHeaders();
    delete responseHeaders['content-encoding'];
    delete responseHeaders['content-length'];
    // Playwright 将多个 Set-Cookie 合为换行文本，不能转入 Fetch Headers；Cookie 已由浏览器独立管理。
    delete responseHeaders['set-cookie'];
    let data: Buffer;
    try { data = await response.body(); }
    catch (error) { if (response.ok()) throw error; data = Buffer.alloc(0); }
    return new Response([204, 205, 304].includes(response.status()) ? null : new Uint8Array(data),
      { status: response.status(), headers: responseHeaders });
    } catch (error) {
      if (error instanceof Error) browserFailures.set(error, { ...diagnostic });
      throw error;
    } finally {
      page.off('request', onRequest);
      page.off('requestfailed', onFailed);
      // 超时可能同时关闭浏览器；清理不能卡住原始失败及 done/end 回写。
      void network.detach().catch(() => {});
      // 取消已不可能收到响应的监听等待；失败浏览器不留给下一次请求。
      if (failed) void closeBrowserTransport();
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
};
