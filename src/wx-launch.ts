import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { parsePlayConfig } from './game-definition';

export function isWxLaunchUrl(value: string, slug: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
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
  let result: { success?: boolean; data?: string } | null;
  const body = await response.text();
  try { result = JSON.parse(body); }
  catch {
    // 仅记录固定分类，不能把入口返回的会话令牌或错误正文写入公开日志。
    console.error(JSON.stringify({ phase: 'wx-link-invalid-json', slug, status: response.status,
      bytes: Buffer.byteLength(body), html: /<!doctype|<html/i.test(body),
      challenge: /cf-chl-|challenge-platform/.test(body),
      accessDenied: /access.?denied|request blocked|forbidden/i.test(body),
      // 授权配置中的 true 会被 GitHub 掩码；用固定文字分类保留诊断结果。
      kind: /生成失败|generation failed/i.test(body) ? 'generation-failed' : 'unclassified',
      empty: body.trim().length === 0 }));
    throw new Error('WX_LINK_INVALID_JSON');
  }
  if (!result || typeof result !== 'object') throw new Error('WX_LINK_INVALID');
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
