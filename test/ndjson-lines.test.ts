import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:buffer';
import { countNdjsonLines } from '../src/ndjson-lines';
import { readDocuments } from '../oaks';

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
    assert.equal((await readDocuments(file)).length, rows);
    await fs.writeFile(file, '\n{"sourceRoundHash":"one"}\r\n  \n{"sourceRoundHash":"two"}');
    assert.equal(await countNdjsonLines(file), 2);
    assert.deepEqual((await readDocuments(file)).map(x => x.sourceRoundHash), ['one', 'two']);
    await fs.writeFile(file, '{broken');
    await assert.rejects(readDocuments(file), /无法恢复/);
    await assert.rejects(readDocuments(path.join(dir, 'missing')), { code: 'ENOENT' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
