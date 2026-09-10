import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { spawnSync } from 'node:child_process';
import { installCaptureRuntime, PendingRound } from '../src/capture-runtime';

const root = path.resolve(__dirname, '..');
const run = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
const worker = process.env.OAKS_WORKER ?? 'control';
let slug = '';
let pending: PendingRound | undefined;
let requestKey: string | undefined;
let deadline = 0;
let stopping = false;
let egress = '';
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

function rpc(op: string, data: Record<string, unknown> = {}): any {
  const result = spawnSync('ssh', ['-F', process.env.OAKS_SSH_CONFIG!, 'oaks-store',
    'sudo python3 /api/api_new/tools/capture-oaks/actions/coordinator.py'], {
    input: JSON.stringify({ op, run, worker, slug, runner: { name: process.env.RUNNER_NAME, environment: process.env.RUNNER_ENVIRONMENT, egress }, ...data }), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 45_000,
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
  for (const name of ['feature-inventory.json', 'start-template.json', 'coverage.json', 'capture-checkpoint.json', 'validation-report.json', 'data-manifest.json', 'mongo-audit-test.json']) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) files[name] = fs.readFileSync(file, 'utf8');
  }
  rpc('files', { files });
}

function stopped(): boolean { return stopping || Date.now() >= deadline; }
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
      if (permit.stop) throw new Error(permit.until > Date.now() ? 'ACTIONS_RATE_LIMIT' : 'ACTIONS_BUDGET');
      if (permit.granted) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, permit.wait)));
    }
    // 不设置 HTTP/SOCKS 代理：真实 fetch 在 GitHub-hosted Runner 内执行。
    const response = await officialFetch(input, { ...options, signal: AbortSignal.timeout(20_000) });
    const body = Buffer.from(await response.arrayBuffer());
    const headers = Object.fromEntries(response.headers);
    rpc('response', { key, response: { status: response.status, headers, body: body.toString('base64') } });
    if (response.status === 429) throw new Error('ACTIONS_RATE_LIMIT');
    // 已由 fetch 解压，重建响应时移除传输编码元数据。
    delete headers['content-encoding'];
    delete headers['content-length'];
    return new Response(body, { status: response.status, headers });
  };
}

async function main(): Promise<void> {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.platform !== 'linux') {
    throw new Error('采集仅允许在 GitHub-hosted Linux Runner 执行');
  }
  const mode = process.argv[2];
  if (mode === 'begin') { console.log(JSON.stringify(rpc('begin', { githubToken: process.env.OAKS_GITHUB_TOKEN }))); return; }
  if (mode === 'end') { console.log(JSON.stringify(rpc('end'))); return; }
  if (mode === 'status') { console.log(JSON.stringify(rpc('status'))); return; }
  if (mode === 'check') {
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
  if (['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some(key => process.env[key])) {
    throw new Error('采集 Runner 不允许配置出口代理');
  }
  const address = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(10_000) }).then(response => response.text());
  if (!isIP(address.trim())) throw new Error('无法核实 Runner 出口');
  egress = address.trim();
  console.log(JSON.stringify({ worker, runnerEnvironment: process.env.RUNNER_ENVIRONMENT, egress }));
  if (!process.env.OAKS_MONGO_URI) throw new Error('缺少受控 Mongo 连接');
  process.env.OAKS_TEST_MONGO_URI = process.env.OAKS_MONGO_URI;
  process.argv = [process.execPath, __filename, '--rounds', '500', '--target-per-feature', '10'];
  const { readRegistry } = await import('../catalog-sync');
  const { captureGame } = await import('../oaks');
  const registry = await readRegistry();
  installDurability();
  while (!stopping) {
    const claimed = rpc('claim');
    if (claimed.stop) break;
    if (claimed.wait) {
      await new Promise(resolve => setTimeout(resolve, claimed.wait));
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
    try {
      // 原工具日志仅在临时内存处理，公开 Actions 日志只输出计数和状态。
      const originalLog = console.log;
      const originalWarn = console.warn;
      console.log = console.warn = () => {};
      try { await captureGame(game); status = 'captured'; }
      finally { console.log = originalLog; console.warn = originalWarn; }
      for (const script of ['validate-data.ts', 'audit-mongo.ts', 'finalize-data.ts']) {
        const args = ['-r', 'ts-node/register', script, '--game', slug, '--target-per-feature', '10'];
        if (script !== 'validate-data.ts') args.push('--target', 'test');
        const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'pipe', timeout: 120_000, env: process.env });
        if (result.status !== 0) throw new Error('正式数据验收失败');
      }
      status = 'accepted';
    } catch (error) {
      const message = (error as Error).message;
      if (message === 'ACTIONS_RATE_LIMIT' || message === 'ACTIONS_BUDGET') { status = 'paused'; stopping = true; }
      else if (!message.includes('达到本轮上限')) { status = 'failed'; stopping = true; process.exitCode = 1; }
    } finally {
      syncFiles();
      const file = path.join(directory, `${slug}.ndjson`);
      const count = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
      rpc('done', { status, count });
      console.log(JSON.stringify({ worker, slug, status, count }));
    }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 10_000));
  }
}

main().catch(() => { console.error('Actions 采集安全停止，请检查测试服协调状态；未输出凭据或官方响应。'); process.exitCode = 1; });
