import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = path.resolve(__dirname, '..');
const capture = fs.readFileSync(path.join(root, 'oaks.ts'), 'utf8');
const history = capture.slice(capture.indexOf('  for await (const document of readDocuments(ndjson))'), capture.indexOf('  priorModes.clear();'));
const worker = fs.readFileSync(path.join(root, 'actions/worker.ts'), 'utf8');
const handler = worker.slice(worker.indexOf('async function handleWxLaunchFailure'), worker.indexOf('// 单个线程独占一个游戏租约'));
const js = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('恢复混合历史保留测试样本但只统计正式配额，仍拒绝其他游戏和无效局', async () => {
  const formal = { gameId: 1, game: 'fixture', sourceRoundHash: 'formal', data: [], buy: 0, bet: 1 };
  const directed = { ...formal, sourceRoundHash: 'directed', testOnly: true };
  let validated = 0;
  const run = (documents: any[]) => vm.runInNewContext(js(`(async()=>{
    let priorCount=0,lastDocument;const modeQuota=true,game={gameId:1,slug:'fixture'},ndjson='unused';
    const counts={},hashes=new Set(),actionEvidence={},modeCounts={},priorModes=new Map();
    ${history}
    return {priorCount,modeCounts,hashes:hashes.size};})()`), {
    readDocuments: async function* () { yield* documents; },
    countCoverage: (docs: any[], _counts: any, hashes: Set<string>) => docs.forEach(d => hashes.add(d.sourceRoundHash)),
    collectActionEvidence() {}, roundSpinType: () => 0,
    validateGameRound: (_game: any, frames: any[]) => { validated++; if (frames.length) throw new Error('invalid round'); },
  });
  const result = await run([formal, directed]);
  assert.equal(result.priorCount, 2); assert.equal(result.hashes, 2);
  assert.equal(result.modeCounts[0], 1); assert.equal(validated, 2);
  await assert.rejects(run([{ ...directed, game: 'other' }]), /不属于本游戏/);
  await assert.rejects(run([{ ...directed, data: [{}] }]), /invalid round/);
});

test('入口浏览器关闭先清理再交回退避租约，不停止其他游戏；未知错误仍失败', async () => {
  const events: string[] = [];
  const sandbox: any = { process: { env: {}, exitCode: 0 }, reasonOf: (e: Error) => e.message,
    closeBrowserTransport: async () => { events.push('close'); },
    rpc: (_op: string, value: any) => { events.push(value.status); }, realLog() {},
    numberFromEnv: () => 0, setTimeout: (fn: () => void) => fn(), worker: '1.0', slug: 'fixture' };
  const run = (message: string) => vm.runInNewContext(js(`${handler}\nhandleWxLaunchFailure(new Error(${JSON.stringify(message)}))`), sandbox);
  assert.equal(await run('page.waitForResponse: Target page, context or browser has been closed'), true);
  assert.deepEqual(events, ['close', 'retryable']); assert.equal(sandbox.process.exitCode, 0);
  events.length = 0;
  assert.equal(await run('unexpected'), false); assert.deepEqual(events, ['failed']);
  assert.equal(sandbox.process.exitCode, 1);
});
