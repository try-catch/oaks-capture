"""协调器客户端：把标准输入按行转发给常驻守护进程，再把响应写回标准输出。

Runner 侧保持“一条 SSH 连接 + 按 JSON 行收发”的既有通道，只是对端从这里
变成共享守护进程，因此状态与并发控制都在一个进程内完成，不必再逐请求
读写状态文件。
"""
import argparse
import json
from pathlib import Path
import socket
import sys


def fallback(root, line):
    """守护进程未运行：退化为单次调用，采集仍有可用通路。"""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from coordinator import Store
    print(json.dumps({'ok': True, 'result': Store(root).call(json.loads(line))}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument('--socket', default=None)
    options = parser.parse_args()
    socket_path = Path(options.socket) if options.socket else Path(options.root) / 'output' / '.actions' / 'coordinator.sock'

    connection = None
    if socket_path.exists():
        try:
            candidate = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            candidate.connect(str(socket_path))
            connection = candidate
        except OSError:
            connection = None

    for raw in sys.stdin.buffer:
        line = raw.strip()
        if not line:
            continue
        if connection is None:
            fallback(options.root, line.decode('utf-8'))
            continue
        stream = connection.makefile('rwb')
        stream.write(line + b'\n')
        stream.flush()
        response = stream.readline()
        stream.close()
        if not response:
            print(json.dumps({'ok': False, 'error': '协调守护进程已断开'}), flush=True)
            sys.exit(1)
        sys.stdout.buffer.write(response)
        sys.stdout.buffer.flush()

    if connection is not None:
        connection.close()


if __name__ == '__main__':
    main()
