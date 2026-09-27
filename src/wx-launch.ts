import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { parsePlayConfig } from './game-definition';

export function isWxLaunchUrl(value: string, slug: string): boolean {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === '3oaks.ssgfivegame.com' &&
    url.pathname === `/api/v1/games/${slug}/play`;
}

// 与历史成功版本一致，直接取试玩链接；请求仍经过 worker 的共享许可和限流。
export async function wxLaunchUrl(slug: string): Promise<string> {
  const response = await fetch('https://www.wxgame99.com/api/game_link', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId: '1001', token: `1001_${crypto.randomUUID().replaceAll('-', '')}`,
      gameBrand: '3oaks', gameType: 'slot', gameId: slug, language: 'en-us' }),
  });
  if (!response.ok) throw new Error(`WX_LINK_HTTP_${response.status}`);
  const result = await response.json() as { success?: boolean; data?: string };
  if (result.success === false) throw new Error('WX_SOURCE_UNAVAILABLE');
  if (result.success !== true || typeof result.data !== 'string' || !isWxLaunchUrl(result.data, slug) ||
      !new URL(result.data).searchParams.get('token')) throw new Error('WX_LINK_INVALID');
  return result.data;
}

// 浏览器只加载最终游戏页，不再为每个进程重开站点首页和目录。
export async function launchFromWx(slug: string): Promise<{ url: string; html: string }> {
  const url = await wxLaunchUrl(slug);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!response) throw new Error('WX_LAUNCH_EMPTY');
    if (!response.ok()) throw new Error(`WX_LAUNCH_HTTP_${response.status()}`);
    const html = await response.text();
    const config = parsePlayConfig(html);
    if (!config.options?.token || !config.options?.queue) throw new Error('WX_LAUNCH_INVALID');
    return { url, html };
  } finally { await browser.close(); }
}
