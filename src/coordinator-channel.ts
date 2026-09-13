import fs from 'node:fs';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';

export interface ChannelCommands {
  /** 常驻模式：一条连接上连续收发 JSON 行。 */
  persistent: string[];
  /** 回退模式：每次调用新起一个进程。 */
  oneShot: string[];
}

export interface ChannelResponse {
  ok: boolean;
  result?: any;
  error?: string;
}

// 非阻塞管道上的短等待：用 Atomics.wait 同步睡眠，避免忙等占满 CPU。
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
function sleepBriefly(): void { Atomics.wait(SLEEP, 0, 0, 2); }

/**
 * 协调通道。常驻模式下在一条 ssh 长连接上按 JSON 行收发，把单次往返从
 * 1-2 秒（新起 ssh+sudo+python）降到毫秒级；任何异常都退回单次调用。
 * 每条线程独占一个实例与一条管道，因此管道内永远是单调的请求-响应。
 */
export class CoordinatorChannel {
  private child?: ChildProcess;
  private buffer = '';

  constructor(
    private readonly commands: ChannelCommands,
    private readonly persistent = true,
    private readonly timeoutMs = 45_000,
  ) {}

  call(payload: string): ChannelResponse {
    if (!this.persistent) return this.oneShot(payload);
    try {
      if (!this.child) this.start();
      return this.exchange(payload);
    } catch {
      this.close();
      return this.oneShot(payload);
    }
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
    this.buffer = '';
  }

  private start(): void {
    const [command, ...args] = this.commands.persistent;
    // 管道保持非阻塞：阻塞读没有超时，一旦对端不响应会永久卡住整条线程。
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    child.on('exit', () => { if (this.child === child) this.child = undefined; });
    this.child = child;
    this.buffer = '';
  }

  private exchange(payload: string): ChannelResponse {
    const child = this.child!;
    // 子进程管道的 `.fd` 是 undefined，真正可用的是 handle 上的 fd（实测为数值）。
    const stdin = (child.stdin as unknown as { _handle?: { fd?: number } })?._handle?.fd;
    const stdout = (child.stdout as unknown as { _handle?: { fd?: number } })?._handle?.fd;
    if (typeof stdin !== 'number' || typeof stdout !== 'number') throw new Error('协调通道缺少管道描述符');
    this.write(stdin, payload);
    return this.read(stdout);
  }

  private write(stdin: number, payload: string): void {
    const data = Buffer.from(payload + '\n', 'utf8');
    const deadline = Date.now() + this.timeoutMs;
    let offset = 0;
    while (offset < data.length) {
      try {
        offset += fs.writeSync(stdin, data, offset, data.length - offset);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
        if (Date.now() > deadline) throw new Error('协调通道写入超时');
        sleepBriefly();
      }
    }
  }

  private read(stdout: number): ChannelResponse {
    const chunk = Buffer.alloc(256 * 1024);
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        return JSON.parse(line) as ChannelResponse;
      }
      let read: number;
      try {
        read = fs.readSync(stdout, chunk, 0, chunk.length, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
        if (Date.now() > deadline) throw new Error('协调通道读取超时');
        sleepBriefly();
        continue;
      }
      if (read === 0) throw new Error('协调通道已关闭');
      this.buffer += chunk.subarray(0, read).toString('utf8');
    }
  }

  private oneShot(payload: string): ChannelResponse {
    const [command, ...args] = this.commands.oneShot;
    const result = spawnSync(command, args, { input: payload, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: this.timeoutMs });
    if (result.error) throw new Error('测试服持久化通道不可用');
    try { return JSON.parse(result.stdout) as ChannelResponse; } catch { throw new Error('测试服协调器未返回有效确认'); }
  }
}
