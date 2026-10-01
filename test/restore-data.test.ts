import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { restoreData, restoreCompressedData } from '../src/restore-data';

test('恢复分块跨 UTF-8 边界保持字节一致，失败不替换完整旧文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oaks-restore-'));
  const file = path.join(dir, 'sample.ndjson');
  const data = Buffer.from('中文恢复记录\n'.repeat(100000));
  let chunks = 0;
  try {
    restoreData(file, data.length, (offset, size) => {
      assert.ok(size <= 512 * 1024); chunks++;
      return { offset, data: data.subarray(offset, offset + size).toString('base64') };
    }, () => false);
    assert.ok(chunks > 1);
    assert.deepEqual(fs.readFileSync(file), data);
    assert.throws(() => restoreData(file, 10, offset => ({offset, data:''}), () => false), /RESTORE_TRUNCATED/);
    assert.deepEqual(fs.readFileSync(file), data);
    assert.equal(fs.existsSync(file + '.restoring'), false);
    assert.throws(() => restoreData(file, 10, () => { throw new Error('must not read'); }, () => true), /ACTIONS_BUDGET/);
    restoreData(file, 0, () => { throw new Error('must not read'); }, () => false);
    assert.equal(fs.statSync(file).size, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('压缩流恢复逐字节一致，截断、超长、损坏和停止均保留原文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oaks-stream-'));
  const file = path.join(dir, 'sample.ndjson');
  const data = Buffer.from('中文完整局记录\n'.repeat(10000));
  const compressed = gzipSync(data);
  try {
    await restoreCompressedData(file, data.length, Readable.from([compressed]), () => false);
    assert.deepEqual(fs.readFileSync(file), data);
    for (const expected of [data.length - 1, data.length + 1]) {
      await assert.rejects(restoreCompressedData(file, expected, Readable.from([compressed]), () => false), /RESTORE_TRUNCATED/);
      assert.deepEqual(fs.readFileSync(file), data);
    }
    await assert.rejects(restoreCompressedData(file, data.length, Readable.from([compressed.subarray(0, 10)]), () => false));
    await assert.rejects(restoreCompressedData(file, data.length, Readable.from([compressed]), () => true), /ACTIONS_BUDGET/);
    assert.deepEqual(fs.readFileSync(file), data);
    assert.equal(fs.existsSync(file + '.restoring'), false);
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});
