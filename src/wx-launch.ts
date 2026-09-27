import { chromium } from 'playwright';
import { parsePlayConfig } from './game-definition';

export function isWxLaunchUrl(value: string, slug: string): boolean {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === '3oaks.ssgfivegame.com' &&
    url.pathname === `/api/v1/games/${slug}/play`;
}

// 只取用户指定旧站的试玩启动页；会话令牌仅在当前进程内使用。
export async function launchFromWx(slug: string, title: string): Promise<{ url: string; html: string }> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const home = await page.goto('https://www.wxgame99.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!home?.ok()) throw new Error(`WX_HOME_HTTP_${home?.status() ?? 0}`);
    await page.getByText('3OAKS', { exact: true }).click();
    const launch = page.waitForResponse(response => isWxLaunchUrl(response.url(), slug), { timeout: 60_000 });
    await page.getByText(title, { exact: true }).click();
    const response = await launch;
    if (!response.ok()) throw new Error(`WX_LAUNCH_HTTP_${response.status()}`);
    const html = await response.text();
    const config = parsePlayConfig(html);
    if (!config.options?.token || !config.options?.queue) throw new Error('WX_LAUNCH_INVALID');
    return { url: response.url(), html };
  } finally { await browser.close(); }
}
