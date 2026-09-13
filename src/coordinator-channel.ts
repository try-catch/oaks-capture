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
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    // 阻塞读写要求管道处于阻塞模式，否则 readSync 会抛 EAGAIN。
    for (const stream of [child.stdout, child.stdin]) {
      const handle = (stream as unknown as { _handle?: { setBlocking?: (value: boolean) => void } })?._handle;
      if (handle?.setBlocking) handle.setBlocking(true);
    }
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
    fs.writeSync(stdin, payload + '\n');
    return this.read(stdout);
  }

  private read(stdout: number): ChannelResponse {
    const chunk = Buffer.alloc(256 * 1024);
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        return JSON.parse(line) as ChannelResponse;
      }
      const read = fs.readSync(stdout, chunk, 0, chunk.length, null);
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
