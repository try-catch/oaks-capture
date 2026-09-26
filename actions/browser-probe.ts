import crypto from 'node:crypto';
import { chromium } from 'playwright';

// 单节点对照诊断：使用原生 Chromium，不修改指纹、不复用外部 Cookie，也不允许旋转。
export async function probeBrowserSession(slug: string, rpc: (op: string, data?: Record<string, unknown>) => any): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = new Map<object, string>();
  const commands = new Set<string>();
  let settled = false;
  let resolveResult!: (value: string) => void;
  const result = new Promise<string>(resolve => { resolveResult = resolve; });
  const finish = (value: string) => { if (!settled) { settled = true; resolveResult(value); } };
  const timer = setTimeout(() => finish('timeout'), 90_000);
  try {
    await page.route('**/*', async route => {
      const request = route.request();
      const command = new URL(request.url()).searchParams.get('gsc');
      if (!command) { await route.continue(); return; }
      if (settled || !['login', 'start'].includes(command) || commands.has(command)) {
        await route.abort(); return;
      }
      commands.add(command);
      const key = crypto.randomBytes(32).toString('hex');
      try {
        while (!settled) {
          const permit = rpc('permit', { key });
          if (permit.stop || permit.halted) { finish('coordinator_stop'); break; }
          if (permit.granted) {
            requests.set(request, key);
            await route.continue(); return;
          }
          await new Promise(resolve => setTimeout(resolve, Math.min(1000, permit.wait)));
        }
      } catch { finish('coordinator_error'); }
      await route.abort();
    });
    page.on('response', response => {
      const key = requests.get(response.request());
      if (!key) return;
      requests.delete(response.request());
      void (async () => {
        const headers = await response.allHeaders();
        const status = response.status();
        let code: string | undefined;
        try { code = (await response.json()).status?.code; } catch { /* 拒绝页不输出正文 */ }
        const command = new URL(response.url()).searchParams.get('gsc');
        const usable = response.ok() && code === 'OK';
        rpc('response', { key, status, usable, retryAfter: headers['retry-after'] ?? '',
          businessCode: code && /^[A-Z_]{1,64}$/.test(code) ? code : status >= 400 ? `HTTP_${status}` : 'INVALID_JSON' });
        console.log(JSON.stringify({ phase: 'browser-probe', slug, command, status,
          outcome: usable ? 'OK' : 'rejected', edge: /cloudflare/i.test(headers.server ?? '') ? 'cloudflare' : 'other' }));
        if (!usable) finish(`rejected_${status}`);
        else if (command === 'start') finish('session-ready');
      })().catch(() => finish('response_error'));
    });
    page.on('requestfailed', request => {
      const key = requests.get(request);
      if (!key) return;
      requests.delete(request);
      try { rpc('response', { key, status: 0, usable: false, businessCode: 'FETCH_ERROR' }); } catch { /* end 清理许可 */ }
      finish('network_failed');
    });
    await page.goto(`https://3oaks.com/game/${encodeURIComponent(slug)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const outcome = await result;
    console.log(JSON.stringify({ phase: 'browser-probe', slug, outcome }));
    if (outcome !== 'session-ready') throw new Error(`BROWSER_PROBE_${outcome}`);
  } finally {
    clearTimeout(timer);
    settled = true;
    await browser.close();
  }
}
