import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { countNdjsonLines } from '../src/ndjson-lines';
import { readDocuments } from '../oaks';

async function collect(file: string) {
  const hashes: string[] = [];
  for await (const document of readDocuments(file)) hashes.push(document.sourceRoundHash);
  return hashes;
}

test('超过单字符串上限仍可计数，历史读取不吞掉损坏与缺失', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oaks-lines-'));
  const file = path.join(dir, 'synthetic.ndjson');
  try {
    const line = JSON.stringify({ sourceRoundHash: 'synthetic' }) + ' '.repeat(65536) + '\n';
    const rows = Math.ceil(constants.MAX_STRING_LENGTH / Buffer.byteLength(line)) + 1;
    const handle = await fs.open(file, 'w');
    try {
      for (let i = 0; i < rows; i++) await handle.write(line);
    } finally { await handle.close(); }
    await assert.rejects(fs.readFile(file, 'utf8'), /Invalid string length|Cannot create a string longer/);
    assert.equal(await countNdjsonLines(file), rows);
    assert.equal((await collect(file)).length, rows);
    await fs.writeFile(file, '\n{"sourceRoundHash":"one"}\r\n  \n{"sourceRoundHash":"two"}');
    assert.equal(await countNdjsonLines(file), 2);
    assert.deepEqual(await collect(file), ['one', 'two']);
    await fs.writeFile(file, '{broken');
    await assert.rejects(collect(file), /无法恢复/);
    await assert.rejects(collect(path.join(dir, 'missing')), { code: 'ENOENT' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('历史对象总量超过受限堆仍可流式读取', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oaks-heap-'));
  const file = path.join(dir, 'history.ndjson');
  try {
    const line = JSON.stringify({ sourceRoundHash: 'one', data: [{ payload: 'x'.repeat(16384) }] }) + '\n';
    const handle = await fs.open(file, 'w');
    try { for (let i = 0; i < 10000; i++) await handle.write(line); }
    finally { await handle.close(); }
    const result = execFileSync(process.execPath, ['--max-old-space-size=128', '-r', 'ts-node/register/transpile-only', '-e',
      'const {readDocuments}=require("./oaks");(async()=>{let n=0;for await(const d of readDocuments(process.argv[1]))n++;if(n!==10000)throw Error("count");console.log(n)})().catch(()=>process.exit(1))', file],
      { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 60000 });
    assert.equal(result.trim(), '10000');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
