import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

/** 恢复文件逐块落盘，完整接收后才替换目标；不让大文件进入 JSON 行缓冲。 */
export function restoreData(file: string, bytes: number,
  read: (offset: number, size: number) => { offset: number; data: string },
  stopped: () => boolean): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('RESTORE_SIZE');
  const temporary = file + '.restoring';
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    let offset = 0;
    while (offset < bytes) {
      if (stopped()) throw new Error('ACTIONS_BUDGET');
      const size = Math.min(512 * 1024, bytes - offset);
      const part = read(offset, size);
      const buffer = Buffer.from(part.data, 'base64');
      if (part.offset !== offset || buffer.length !== size) throw new Error('RESTORE_TRUNCATED');
      let written = 0;
      while (written < buffer.length) written += fs.writeSync(fd, buffer, written, buffer.length - written);
      offset += size;
    }
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(temporary, file);
}


/** SSH 压缩流恢复，省去大文件逐块 RPC；精确校验后才原子替换。 */
export async function restoreCompressedData(file: string, bytes: number, input: Readable, stopped: () => boolean): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('RESTORE_SIZE');
  const temporary = file + '.restoring';
  let received = 0;
  try {
    await pipeline(input, createGunzip(), new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (stopped()) return done(new Error('ACTIONS_BUDGET'));
        if (received > bytes) return done(new Error('RESTORE_TRUNCATED'));
        done(null, chunk);
      },
    }), fs.createWriteStream(temporary, {mode: 0o600}));
    if (received !== bytes) throw new Error('RESTORE_TRUNCATED');
    const fd = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, {force: true});
    throw error;
  }
}
