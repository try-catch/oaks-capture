import assert from 'node:assert/strict';
import test from 'node:test';
import { applyGgxSpinParams } from '../src/shop';
import { extractGgxLaunchUrl, isGgxLaunchUrl, parseGgxLaunch } from '../src/ggx-launch';

const LAUNCH = 'https://three-oaks.thefanz.net/game_start.do?gameCode=china_festival&token=a1b2c3d4e5f60718293a4b5c6d7e8f90&lang=zh&exit_url=https%3a%2f%2fwww.goldengatex.cc';

test('只接受指定游戏在 goldengatex 启动域的 game_start.do 地址', () => {
  assert.equal(isGgxLaunchUrl(LAUNCH, 'china_festival'), true);
  assert.equal(isGgxLaunchUrl(LAUNCH, 'sun_of_egypt'), false);
  assert.equal(isGgxLaunchUrl('https://three-oaks.thefanz.net/other.do?gameCode=china_festival&token=a1b2c3d4e5f60718293a4b5c6d7e8f90', 'china_festival'), false);
  assert.equal(isGgxLaunchUrl('https://evil.example/game_start.do?gameCode=china_festival&token=a1b2c3d4e5f60718293a4b5c6d7e8f90', 'china_festival'), false);
  assert.equal(isGgxLaunchUrl(LAUNCH.replace('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'short-token'), 'china_festival'), false);
});

test('从试玩页 HTML 提取启动地址并拒绝异站内容', () => {
  const html = `<script>let GAME={playUrl:'${LAUNCH}',playFun:'1'};</script>`;
  assert.equal(extractGgxLaunchUrl(html, 'china_festival'), LAUNCH);
  assert.throws(() => extractGgxLaunchUrl('<p>暂无游戏</p>', 'china_festival'), /GGX_SOURCE_UNAVAILABLE/);
});

test('解析 game_start.do 内嵌端点：desktop.server_url 即协议地址', () => {
  const html = `desktop: {
                client_url: "https://static.3oaks.com/gs/clients_goreel/china_festival/3oaks.v25.4.1/",
                revision: "ee855aa5",
                server_url: "https://three-oaks.thefanz.net/gs/china_festival/desktop/a1b2c3d4e5f60718293a4b5c6d7e8f90/prod/",
                use_cdn: true
            }`;
  const parsed = parseGgxLaunch(html, LAUNCH);
  assert.equal(parsed.endpoint, 'https://three-oaks.thefanz.net/gs/china_festival/desktop/a1b2c3d4e5f60718293a4b5c6d7e8f90/prod/');
  assert.equal(parsed.token, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert.throws(() => parseGgxLaunch('no config', LAUNCH), /GGX_CONFIG_INVALID/);
  assert.throws(() => parseGgxLaunch(html, LAUNCH.replace('gameCode=china_festival', 'gameCode=sun_of_egypt')), /GGX_ENDPOINT_INVALID/);
});

test('ggx 购买动作保留合法最低投注并携带当前会话倍数', () => {
  const actions = applyGgxSpinParams([
    { name: 'spin', params: { bet_per_line: 50, lines: 25 } },
    { name: 'buy_spin', params: { bet_per_line: 50, lines: 25, selected_mode: 1 } },
  ], [20]);
  assert.deepEqual(actions[0], { name: 'spin', params: { bet_per_line: 50, lines: 25 } });
  assert.deepEqual(actions[1].params, { bet_per_line: 50, lines: 25, selected_mode: 1, bet_factor: 20 });
  // 会话未声明倍数时不猜测。
  const fallback = applyGgxSpinParams([{ name: 'buy_spin', params: { selected_mode: 2 } }], undefined);
  assert.equal(fallback[0].params.bet_factor, undefined);
});
