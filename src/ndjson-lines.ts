import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** 按行读取历史局；读取失败必须上抛，不能伪装成空文件。 */
export async function* ndjsonLines(filename: string): AsyncGenerator<string> {
  const input = createReadStream(filename, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line.trim()) yield line;
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function countNdjsonLines(filename: string): Promise<number> {
  let count = 0;
  for await (const _line of ndjsonLines(filename)) count++;
  return count;
}
