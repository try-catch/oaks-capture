import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { spawnSync, fork } from 'node:child_process';
import { installCaptureRuntime, PendingRound } from '../src/capture-runtime';

const root = path.resolve(__dirname, '..');
const run = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
// 节点身份用于出口熔断，线程身份 <节点>.<线程> 用于游戏租约。
const node = process.env.OAKS_WORKER ?? 'control';
const threadIndex = process.env.OAKS_THREAD_INDEX ?? '';
const worker = threadIndex === '' ? node : `${node}.${threadIndex}`;
let slug = '';
let pending: PendingRound | undefined;
let requestKey: string | undefined;
let deadline = 0;
let stopping = false;
let egress = process.env.OAKS_EGRESS ?? '';
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

function rpc(op: string, data: Record<string, unknown> = {}): any {
  const result = spawnSync('ssh', ['-F', process.env.OAKS_SSH_CONFIG!, 'oaks-store',
    'sudo python3 /api/api_new/tools/capture-oaks/actions/coordinator.py'], {
    input: JSON.stringify({ op, run, worker, node, slug, runner: { name: process.env.RUNNER_NAME, environment: process.env.RUNNER_ENVIRONMENT, egress }, ...data }), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 45_000,
  });
  if (result.error) throw new Error('测试服持久化通道不可用');
  let response: any;
  try { response = JSON.parse(result.stdout); } catch { throw new Error('测试服协调器未返回有效确认'); }
  if (!response.ok) throw new Error(`协调器拒绝操作: ${response.error}`);
  if (result.status !== 0) throw new Error('测试服持久化失败');
  return response.result;
}

function syncFiles(): void {
  const directory = path.join(root, 'output', slug);
  const files: Record<string, string> = {};
  for (const name of ['feature-inventory.json', 'start-template.json', 'coverage.json', 'mode-coverage.json', 'capture-checkpoint.json', 'validation-report.json', 'data-manifest.json', 'mongo-audit-test.json']) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) files[name] = fs.readFileSync(file, 'utf8');
  }
  rpc('files', { files });
}

function stopped(): boolean { return stopping || Date.now() >= deadline; }
function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function requireProviderAuthorization(): void {
  if (process.env.OAKS_PROVIDER_AUTHORIZED !== 'true') {
    throw new Error('真实采集需要服务商书面授权并设置 OAKS_PROVIDER_AUTHORIZED=true');
  }
}
function requireGithubHosted(): void {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.platform !== 'linux') {
    throw new Error('采集仅允许在 GitHub-hosted Linux Runner 执行');
  }
  if (['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some(key => process.env[key])) {
    throw new Error('采集 Runner 不允许配置出口代理');
  }
}
function installDurability(): void {
  installCaptureRuntime({
    pending: () => pending,
    savePending: value => { rpc('pending', { value }); pending = value; },
    requestStep: (id, step) => { requestKey = crypto.createHash('sha256').update(`${slug}:${id}:${step}`).digest('hex'); },
    writeDocument: document => { rpc('append', { document, line: JSON.stringify(document) }); },
    acknowledge: document => { rpc('ack', { hash: document.sourceRoundHash }); pending = undefined; requestKey = undefined; },
    syncFiles,
    shouldStop: stopped,
  });
  const officialFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    if (stopped()) throw new Error('ACTIONS_BUDGET');
    const url = String(input);
    if (!/^https:\/\//.test(url)) throw new Error('只允许 HTTPS 官方请求');
    const key = requestKey ?? crypto.randomBytes(32).toString('hex');
    const request = { url, method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)), body: options.body };
    while (true) {
      if (stopped()) throw new Error('ACTIONS_BUDGET');
      const permit = rpc('permit', { key, request });
      if (permit.cached) return new Response(Buffer.from(permit.cached.body, 'base64'), { status: permit.cached.status, headers: permit.cached.headers });
      if (permit.halted) throw new Error('ACTIONS_HALTED');
      if (permit.stop) throw new Error(permit.until > Date.now() ? 'ACTIONS_RATE_LIMIT' : 'ACTIONS_BUDGET');
      if (permit.granted) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, permit.wait)));
    }
    // 不设置 HTTP/SOCKS 代理：真实 fetch 在 GitHub-hosted Runner 内执行。
    const response = await officialFetch(input, { ...options, signal: AbortSignal.timeout(20_000) });
    const body = Buffer.from(await response.arrayBuffer());
    const headers = Object.fromEntries(response.headers);
    const settled = rpc('response', { key, response: { status: response.status, headers, body: body.toString('base64') } });
    if (settled.halted) throw new Error('ACTIONS_HALTED');
    if (response.status === 429) throw new Error('ACTIONS_RATE_LIMIT');
    // 已由 fetch 解压，重建响应时移除传输编码元数据。
    delete headers['content-encoding'];
    delete headers['content-length'];
    return new Response(body, { status: response.status, headers });
  };
}

const quotaArgs = ['--target-per-feature', '10', '--normal-rounds', '100000', '--target-per-mode', '10000'];

// 单个线程独占一个游戏租约，持续恢复到配额达标或本轮预算耗尽为止。
async function runThread(): Promise<void> {
  requireGithubHosted();
  requireProviderAuthorization();
  if (!isIP(egress.trim())) throw new Error('无法核实 Runner 出口');
  egress = egress.trim();
  if (!process.env.OAKS_MONGO_URI) throw new Error('缺少受控 Mongo 连接');
  process.env.OAKS_TEST_MONGO_URI = process.env.OAKS_MONGO_URI;
  // 单次调用不再限制新增局数：由配额达标或本轮 deadline 决定何时收工。
  process.argv = [process.execPath, __filename, '--rounds', '1000000', ...quotaArgs];
  const { readRegistry } = await import('../catalog-sync');
  const { captureGame } = await import('../oaks');
  const registry = await readRegistry();
  installDurability();
  while (!stopping) {
    const claimed = rpc('claim');
    if (claimed.stop) break;
    if (claimed.wait) {
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, claimed.wait)));
      continue;
    }
    slug = claimed.slug;
    deadline = claimed.deadline;
    const game = registry.games.find(game => game.slug === slug);
    if (!game) throw new Error('Runner 目录与测试服目录不一致');
    const restored = rpc('load');
    const directory = path.join(root, 'output', slug);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [name, value] of Object.entries(restored.files)) fs.writeFileSync(path.join(directory, name), String(value), { mode: 0o600 });
    pending = restored.pending ?? undefined;
    requestKey = undefined;
    let status = 'incomplete';
    // 原工具日志仅在临时内存处理，公开 Actions 日志只输出计数和状态。
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = console.warn = () => {};
    try {
      await captureGame(game);
      console.log = originalLog;
      console.warn = originalWarn;
      for (const script of ['validate-data.ts', 'audit-mongo.ts', 'finalize-data.ts']) {
        const args = ['-r', 'ts-node/register', script, '--game', slug, ...quotaArgs];
        if (script !== 'validate-data.ts') args.push('--target', 'test');
        const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'pipe', timeout: 900_000, env: process.env });
        if (result.status !== 0) throw new Error('正式数据验收失败');
      }
      status = 'accepted';
    } catch (error) {
      const message = (error as Error).message;
      // 限速只退避当前线程，协调器已按节点记录 Retry-After；恢复点已落盘，可以继续同一游戏。
      if (message === 'ACTIONS_RATE_LIMIT') status = 'waiting';
      else if (message === 'ACTIONS_HALTED') { status = 'halted'; stopping = true; }
      else if (message === 'ACTIONS_BUDGET') { status = 'paused'; stopping = true; }
      else if (/租约不属于当前节点/.test(message)) { status = 'released'; stopping = true; }
      else if (!message.includes('达到本轮上限')) { status = 'failed'; stopping = true; process.exitCode = 1; }
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      const file = path.join(directory, `${slug}.ndjson`);
      const count = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
      // 节点被熔断时协调器会交回租约，此时本轮落盘和状态回写会被拒绝，数据已在测试服 NDJSON 中。
      try {
        syncFiles();
        rpc('done', { status, count });
      } catch {
        console.warn(JSON.stringify({ worker, slug, status, note: '租约已交回，保留已落盘数据' }));
      }
      console.log(JSON.stringify({ worker, slug, status, count }));
    }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, numberFromEnv('OAKS_GAME_SWITCH_DELAY_MS', 10_000)));
  }
}

// 单节点线程池：每个线程独立认领游戏，任一节点被官方封控时整机停机并保留数据。
async function supervise(): Promise<void> {
  requireGithubHosted();
  requireProviderAuthorization();
  egress = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(10_000) }).then(response => response.text());
  if (!isIP(egress.trim())) throw new Error('无法核实 Runner 出口');
  const threads = numberFromEnv('OAKS_THREADS', 8);
  console.log(JSON.stringify({ node, threads, runnerEnvironment: process.env.RUNNER_ENVIRONMENT, egress: egress.trim() }));
  const children = Array.from({ length: threads }, (_value, index) => fork(__filename, ['thread'], {
    execArgv: process.execArgv,
    env: { ...process.env, OAKS_THREAD_INDEX: String(index), OAKS_EGRESS: egress.trim() },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  }));
  const stop = () => { for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const codes = await Promise.all(children.map(child => new Promise<number>(resolve => child.on('exit', code => resolve(code ?? 1)))));
  if (codes.some(code => code !== 0)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'thread') { await runThread(); return; }
  if (mode === 'begin') {
    requireGithubHosted();
    requireProviderAuthorization();
    const threads = numberFromEnv('OAKS_THREADS', 8);
    const nodes = numberFromEnv('OAKS_NODES', 1);
    console.log(JSON.stringify(rpc('begin', {
      githubToken: process.env.OAKS_GITHUB_TOKEN,
      threads,
      nodes,
      nodeMs: numberFromEnv('OAKS_NODE_SPACING_MS', 250),
      throttleLimit: numberFromEnv('OAKS_THROTTLE_LIMIT', 6),
      maxInFlight: threads * nodes,
      maxClaims: threads * nodes,
      deadlineMinutes: numberFromEnv('OAKS_DEADLINE_MINUTES', 40),
    })));
    return;
  }
  if (mode === 'end') { console.log(JSON.stringify(rpc('end'))); return; }
  if (mode === 'status') { console.log(JSON.stringify(rpc('status'))); return; }
  if (mode === 'check') {
    requireGithubHosted();
    rpc('status');
    if (!process.env.OAKS_MONGO_URI) throw new Error('缺少受控 Mongo 连接');
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(process.env.OAKS_MONGO_URI, { serverSelectionTimeoutMS: 10_000 });
    try { await client.connect(); await client.db('admin').command({ ping: 1 }); }
    finally { await client.close(); }
    console.log('SSH 主机身份、协调器与 Mongo 隧道检查通过；未请求官方接口。');
    return;
  }
  if (mode !== 'capture') throw new Error('未知执行模式');
  await supervise();
}

main().catch(() => { console.error('Actions 采集安全停止，请检查测试服协调状态；未输出凭据或官方响应。'); process.exitCode = 1; });
