import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { restoreData } from '../src/restore-data';

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
