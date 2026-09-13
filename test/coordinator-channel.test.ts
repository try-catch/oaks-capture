import assert from "node:assert/strict";
import test from "node:test";
import { CoordinatorChannel } from "../src/coordinator-channel";

// 本地回显服务：读一行、回一行 JSON，用来在没有任何网络与 Runner 的情况下
// 验证阻塞管道读写的真实行为。
const ECHO = [
  "python3", "-u", "-c",
  "import sys, json\nfor line in sys.stdin:\n    payload = json.loads(line)\n    print(json.dumps({'ok': True, 'result': {'echo': payload.get('n'), 'pid': __import__('os').getpid()}}), flush=True)\n",
];

test("常驻通道可以在一行连接上连续收发多个请求", () => {
  const channel = new CoordinatorChannel({ persistent: ECHO, oneShot: ECHO }, true);
  try {
    const pids = new Set<number>();
    for (const n of [1, 2, 3]) {
      const response = channel.call(JSON.stringify({ n }));
      assert.equal(response.ok, true);
      assert.equal(response.result.echo, n);
      pids.add(response.result.pid);
    }
    // 同一个进程处理全部请求，说明没有每次新起进程。
    assert.equal(pids.size, 1);
  } finally { channel.close(); }
});

test("常驻通道往返应在毫秒级，第二次调用不再付出启动成本", () => {
  const channel = new CoordinatorChannel({ persistent: ECHO, oneShot: ECHO }, true);
  try {
    channel.call(JSON.stringify({ n: 0 }));
    const started = Date.now();
    for (const n of [1, 2, 3, 4, 5]) channel.call(JSON.stringify({ n }));
    const perCall = (Date.now() - started) / 5;
    assert.ok(perCall < 100, `每次往返应远小于 100ms，实际 ${perCall}ms`);
  } finally { channel.close(); }
});

test("显式关闭常驻模式时走单次调用，仍然可用", () => {
  const channel = new CoordinatorChannel({ persistent: ECHO, oneShot: ECHO }, false);
  const response = channel.call(JSON.stringify({ n: 7 }));
  assert.equal(response.ok, true);
  assert.equal(response.result.echo, 7);
});

test("常驻进程不响应时必须在超时内回退，不能永久卡住线程", () => {
  // 这正是线上的事故形态：阻塞读没有超时，对端不响应就永久卡在 readSync。
  const silent = ["python3", "-u", "-c", "import time; time.sleep(60)"];
  const channel = new CoordinatorChannel({ persistent: silent, oneShot: ECHO }, true, 300);
  try {
    const started = Date.now();
    const response = channel.call(JSON.stringify({ n: 11 }));
    const elapsed = Date.now() - started;
    assert.equal(response.ok, true);
    assert.equal(response.result.echo, 11);
    assert.ok(elapsed < 3000, `应在超时后立即回退，实际 ${elapsed}ms`);
  } finally { channel.close(); }
});

test("常驻进程不可用时回退到单次调用，不抛错也不卡死", () => {
  const broken = ["python3", "-c", "import sys; sys.exit(3)"];
  const channel = new CoordinatorChannel({ persistent: broken, oneShot: ECHO }, true);
  try {
    const response = channel.call(JSON.stringify({ n: 9 }));
    assert.equal(response.ok, true);
    assert.equal(response.result.echo, 9);
  } finally { channel.close(); }
});
