import json
import socket
from pathlib import Path
import tempfile
import threading
import unittest

from coordinator import Store, atomic
from coordinator_daemon import serve
from coordinator_daemon import Daemon  # noqa: F401  (显式依赖，避免改名后静默失效)


def request(socket_path, payloads):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.connect(str(socket_path))
    stream = client.makefile('rwb')
    responses = []
    for payload in payloads:
        stream.write((json.dumps(payload) + '\n').encode())
        stream.flush()
        responses.append(json.loads(stream.readline()))
    stream.close()
    client.close()
    return responses


class DaemonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        atomic(self.root / 'games/registry.json', {'games': [{'slug': 'one'}, {'slug': 'two'}]})
        atomic(self.root / 'output/actions-handoff.json',
               {'migrationState': 'stopped', 'retryNotBefore': '2020-01-01T00:00:00+00:00', 'slug': 'one'})
        self.socket_path = self.root / 'output/.actions/coordinator.sock'
        daemon, server = serve(self.root, self.socket_path)
        self.daemon = daemon
        self.stopping = False

        def loop():
            while not daemon.stopping:
                try:
                    connection, _ = server.accept()
                except OSError:
                    break
                threading.Thread(target=daemon.handle, args=(connection,), daemon=True).start()

        self.thread = threading.Thread(target=loop, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.daemon.stopping = True
        try:
            self.daemon.flush()
        except Exception:
            pass
        self.temp.cleanup()

    def test_one_connection_serves_many_requests_without_per_request_persistence(self):
        responses = request(self.socket_path, [
            {'op': 'begin', 'run': '100-1', 'threads': 8, 'nodes': 20, 'maxClaims': 4},
            {'op': 'claim', 'run': '100-1', 'worker': '1'},
            {'op': 'claim', 'run': '100-1', 'worker': '2'},
            {'op': 'status', 'run': '100-1'},
            {'op': 'stats', 'run': '100-1'},
        ])
        self.assertTrue(all(r['ok'] for r in responses))
        self.assertEqual(responses[1]['result']['slug'], 'one')
        self.assertEqual(responses[2]['result']['slug'], 'two')
        self.assertEqual(responses[3]['result']['owner'], '100-1')
        # 同一个进程连续处理了全部请求：这正是吞吐来源（begin/claim/claim/status 计入 4 次）。
        self.assertEqual(responses[4]['result']['requests'], 4)

    def test_two_connections_share_one_in_memory_state(self):
        request(self.socket_path, [{'op': 'begin', 'run': '100-1', 'threads': 8, 'nodes': 20, 'maxClaims': 8}])
        first = request(self.socket_path, [{'op': 'claim', 'run': '100-1', 'worker': '1'}])[0]
        second = request(self.socket_path, [{'op': 'claim', 'run': '100-1', 'worker': '2'}])[0]
        self.assertEqual(first['result']['slug'], 'one')
        # 第二条连接看得到第一条连接造成的认领，说明状态确实共享。
        self.assertEqual(second['result']['slug'], 'two')

    def test_state_is_persisted_for_urgent_ops(self):
        request(self.socket_path, [{'op': 'begin', 'run': '100-1', 'threads': 8, 'nodes': 20, 'maxClaims': 4}])
        persisted = json.loads((self.root / 'output/.actions/queue.json').read_text())
        self.assertEqual(persisted['owner'], '100-1')

    def test_append_groups_fsync_and_done_flushes_remainder(self):
        request(self.socket_path, [
            {'op': 'begin', 'run': '100-1', 'threads': 1, 'nodes': 1, 'maxClaims': 1},
            {'op': 'claim', 'run': '100-1', 'worker': '1'},
        ])
        payloads = []
        for number in range(3):
            document = {'game': 'one', 'sourceRoundHash': format(number, '064x'), 'data': [number]}
            payloads.append({'op': 'append', 'run': '100-1', 'worker': '1', 'slug': 'one',
                             'document': document, 'line': json.dumps(document)})
        self.assertTrue(all(item['ok'] for item in request(self.socket_path, payloads)))
        self.assertEqual(self.daemon.store.unsynced['one'], 3)
        done = request(self.socket_path, [
            {'op': 'done', 'run': '100-1', 'worker': '1', 'slug': 'one', 'status': 'incomplete', 'count': 3},
        ])[0]
        self.assertTrue(done['ok'])
        self.assertNotIn('one', self.daemon.store.unsynced)

    def test_legacy_container_check_tolerates_missing_container(self):
        # 本机没有 docker / 容器不存在时不得让 begin 报 CalledProcessError。
        state = Store(self.root).load()
        Store(self.root).check_legacy_container(state, 1)

    def test_missing_socket_makes_single_shot_path_raise_clear_error(self):
        from coordinator import forward_to_daemon
        self.socket_path.unlink()
        with self.assertRaises(ValueError):
            forward_to_daemon({'op': 'status'})


if __name__ == '__main__':
    unittest.main()
