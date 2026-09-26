import { chromium, type Browser, type Page } from 'playwright';
import { REQUEST_TIMEOUT_MS } from '../config';
import { ProtocolHttpError } from './protocol';

// 每个 worker 进程独享一个原生浏览器上下文；不同节点、线程不共享 Cookie 或试玩用户。
let session: Promise<{ browser: Browser; page: Page }> | undefined;

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
  return { command, kind };
}

async function browserPage(): Promise<Page> {
  session ??= (async () => {
    const browser = await chromium.launch({ headless: true });
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
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url() === url && response.request().method() === method,
        { timeout: REQUEST_TIMEOUT_MS }),
      page.evaluate(async request => {
        try {
          const response = await fetch(request.url, { method: request.method, headers: request.headers,
            body: request.body, credentials: 'same-origin', signal: AbortSignal.timeout(request.timeout) });
          await response.arrayBuffer();
        } catch { /* HTTP/CORS 拒绝仍通过浏览器网络响应交给原有协议错误处理 */ }
      }, { url, method, headers: Object.fromEntries(headers), body, timeout: REQUEST_TIMEOUT_MS }),
    ]);
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
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
};
