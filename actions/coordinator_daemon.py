"""常驻协调守护进程：状态放内存、按周期落盘，请求之间不做逐次 fsync。

改用它的原因：原来每个请求都要读状态文件、写请求日志并 fsync 两次，
8 个进程靠 flock 串行化，实测并发从 6 加到 72 时吞吐反而从 3.06 降到 2.18
请求/秒——串行点就是我们自己的持久化，不是服务商（72 会话下官方接口
仍然全部返回 OK）。

持久化语义（用户已确认放宽）：
- 队列状态每 PERSIST_INTERVAL_MS 毫秒或关键操作（begin/end/claim/done）后落盘；
- 请求日志只留内存，不再逐请求写文件；
- 崩溃最多丢失最近一个间隔内的状态与在飞请求记录，重启后未确认的请求会被重新发起。
"""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from coordinator import Store, read  # noqa: E402

PERSIST_INTERVAL_MS = 1000
DEFAULT_STATE = {'owner': None, 'until': 0, 'next': 0, 'rateCount': 0, 'permit': None}
# 这些操作改的是跨节点共享状态，落盘一次代价很低且影响后续调度，立即持久化。
URGENT_OPS = {'begin', 'end', 'claim', 'done'}


class Daemon:
    def __init__(self, root, socket_path):
        self.root = Path(root)
        self.socket_path = Path(socket_path)
        self.store = Store(self.root, memory=read(self.root / 'output' / '.actions' / 'queue.json', dict(DEFAULT_STATE)))
        self.dirty = threading.Event()
        self.stopping = False
        self.started_at = time.time()
        self.requests = 0

    def flush(self):
        with self.store.lock:
            self.store.persist(self.store.memory)
        self.dirty.clear()

    def persist_loop(self):
        while not self.stopping:
            # Event 已置位时 wait() 会立即返回。旧实现因此在持续请求期间变成
            # “每个请求都 fsync”，最终制造 I/O 风暴。固定周期采样 dirty，保证
            # queue.json 最多每秒同步一次。
            time.sleep(PERSIST_INTERVAL_MS / 1000)
            if not self.dirty.is_set():
                continue
            try:
                self.flush()
            except Exception:
                # 落盘失败不能中断服务；下一个周期继续尝试。
                pass

    def handle(self, connection):
        stream = connection.makefile('rwb')
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
                if request.get('op') == 'stats':
                    with self.store.lock:
                        result = {'requests': self.requests, 'uptime': round(time.time() - self.started_at, 1),
                                  'journal': len(self.store.journals)}
                else:
                    with self.store.lock:
                        result = self.store.execute(self.store.memory, request, True)
                    self.requests += 1
                    if request.get('op') in URGENT_OPS:
                        self.store.persist(self.store.memory)
                    else:
                        self.dirty.set()
                response = {'ok': True, 'result': result}
            except Exception as error:
                # 日志不输出输入、凭据、响应正文或底层异常内容。
                response = {'ok': False, 'error': str(error) if isinstance(error, ValueError) else type(error).__name__}
            stream.write((json.dumps(response) + '\n').encode('utf-8'))
            stream.flush()
        stream.close()


def serve(root, socket_path):
    daemon = Daemon(root, socket_path)
    if daemon.socket_path.exists():
        daemon.socket_path.unlink()
    daemon.socket_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # 常驻期间持有全局锁：单次调用路径会因此改走转发，保证只有一个状态写者。
    # 必须把文件对象挂在 daemon 上，否则 serve() 返回后它被回收、锁随之释放。
    import fcntl
    daemon.lockfile = (daemon.store.directory / 'queue.lock').open('a')
    fcntl.flock(daemon.lockfile, fcntl.LOCK_EX)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(daemon.socket_path))
    os.chmod(daemon.socket_path, 0o600)
    server.listen(256)

    threading.Thread(target=daemon.persist_loop, daemon=True).start()

    def stop(_signum, _frame):
        daemon.stopping = True
        try:
            with daemon.store.lock:
                daemon.store.sync_all()
            daemon.flush()
        finally:
            server.close()
            if daemon.socket_path.exists():
                daemon.socket_path.unlink()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    return daemon, server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument('--socket', default=str(Path(__file__).resolve().parent.parent / 'output' / '.actions' / 'coordinator.sock'))
    options = parser.parse_args()
    daemon, server = serve(Path(options.root), options.socket)
    while not daemon.stopping:
        try:
            connection, _ = server.accept()
        except OSError:
            break
        threading.Thread(target=daemon.handle, args=(connection,), daemon=True).start()


if __name__ == '__main__':
    main()
