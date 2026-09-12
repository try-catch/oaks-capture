import base64
import datetime as dt
import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from coordinator import CONSERVATIVE_WAIT_MS, Store, atomic, node_of, read, retry_after_ms


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        atomic(self.root / 'games/registry.json', {'games': [{'slug': 'one'}, {'slug': 'two'}]})
        atomic(self.root / 'output/actions-handoff.json', {'migrationState': 'stopped', 'retryNotBefore': '2020-01-01T00:00:00+00:00', 'slug': 'one'})
        self.store = Store(self.root)
        self.call('begin')
        self.assertEqual(self.call('claim')['slug'], 'one')
        self.key = hashlib.sha256(b'request').hexdigest()

    def tearDown(self):
        self.temp.cleanup()

    def call(self, op, **kwargs):
        return self.store.call(dict(op=op, run='100-1', worker='1', slug='one', **kwargs), check_legacy=False)

    def permit(self, worker, slug, key):
        return self.store.call(dict(op='permit', run='100-1', worker=worker, slug=slug, key=key, request={}), check_legacy=False)

    def throttle(self, worker, slug, key, retry='3600'):
        self.permit(worker, slug, key)
        return self.store.call(dict(op='response', run='100-1', worker=worker, slug=slug, key=key,
                                    response={'status': 429, 'headers': {'retry-after': retry}, 'body': ''}), check_legacy=False)

    def expand_registry(self, count):
        atomic(self.root / 'games/registry.json', {'games': [{'slug': f'g{number}'} for number in range(count)]})

    def clear_node_backoff(self):
        """模拟请求在限速生效前就已并发发出：清掉节点间隔，便于观察熔断计数。"""
        state = read(self.store.state_path)
        state['nodeUntil'] = {}
        atomic(self.store.state_path, state)

    def test_cross_run_and_worker_exclusion(self):
        with self.assertRaises(ValueError):
            self.store.call({'op': 'begin', 'run': '200-1'}, check_legacy=False)
        with self.assertRaises(ValueError):
            self.store.call({'op': 'load', 'run': '100-1', 'worker': '2', 'slug': 'one'}, check_legacy=False)
        second = self.store.call({'op': 'claim', 'run': '100-1', 'worker': '2'}, check_legacy=False)
        self.assertEqual(second['slug'], 'two')

    def test_ack_after_durable_append_and_restore(self):
        self.call('pending', value={'id': 'round', 'frames': [{'frame': 1}]})
        document = {'game': 'one', 'sourceRoundHash': 'a' * 64, 'data': [1]}
        line = json.dumps(document, separators=(',', ':'))
        self.call('append', document=document, line=line)
        self.assertEqual((self.root / 'output/one/one.ndjson').read_bytes(), (line + '\n').encode())
        self.assertTrue(self.call('append', document=document)['duplicate'])
        restored = Store(self.root).call({'op': 'load', 'run': '100-1', 'worker': '1', 'slug': 'one'}, check_legacy=False)
        self.assertEqual(restored['pending']['frames'], [{'frame': 1}])
        self.assertEqual(len(restored['files']['one.ndjson'].splitlines()), 1)
        self.call('ack', hash='a' * 64)
        self.assertIsNone(self.call('load')['pending'])

    def test_response_replay_and_unknown_request_fail_closed(self):
        self.assertTrue(self.call('permit', key=self.key, request={'url': 'https://example.test'})['granted'])
        with self.assertRaises(ValueError):
            self.call('permit', key=self.key, request={})
        response = {'status': 200, 'headers': {}, 'body': base64.b64encode(b'{}').decode()}
        self.call('response', key=self.key, response=response, usable=True)
        self.assertEqual(self.call('permit', key=self.key, request={})['cached'], response)

    def test_business_failure_in_200_is_never_replayed(self):
        self.call('permit', key=self.key, request={})
        # 官方用 200 + status.code 表示业务失败：重放它会让这一局永久卡死。
        failed = {'status': 200, 'headers': {}, 'body': base64.b64encode(b'{"status":{"code":"GAME_REOPENED"}}').decode()}
        self.call('response', key=self.key, response=failed, usable=False)
        self.clear_node_backoff()
        self.assertTrue(self.call('permit', key=self.key, request={})['granted'])
        # 重新请求后拿到可用响应，之后才允许重放。
        ok = {'status': 200, 'headers': {}, 'body': base64.b64encode(b'{"status":{"code":"OK"}}').decode()}
        self.call('response', key=self.key, response=ok, usable=True)
        self.assertEqual(self.call('permit', key=self.key, request={})['cached'], ok)

    def test_legacy_journal_without_usable_flag_is_not_replayed(self):
        self.call('permit', key=self.key, request={})
        self.call('response', key=self.key, response={'status': 200, 'headers': {}, 'body': ''})
        journal = self.store.directory / 'one' / (self.key + '.json')
        entry = read(journal)
        del entry['usable']
        atomic(journal, entry)
        # 旧版本日志没有可用性标记，必须重新请求而不是盲目重放。
        self.clear_node_backoff()
        self.assertTrue(self.call('permit', key=self.key, request={})['granted'])

    def test_single_node_throttle_backs_off_only_that_node(self):
        self.store.call({'op': 'claim', 'run': '100-1', 'worker': '2'}, check_legacy=False)
        before = time.time() * 1000
        settled = self.throttle('1', 'one', self.key)
        # 单个出口被限速只退避它自己，不冻结其它出口。
        self.assertLess(settled['until'], before)
        self.assertGreaterEqual(settled['nodeUntil'], before + 3_600_000)
        self.assertLess(self.call('status')['until'], before)
        state = read(self.store.state_path)
        state['nodeUntil']['1'] = time.time() * 1000 + 60_000
        atomic(self.store.state_path, state)
        self.assertIn('wait', self.call('permit', key='a' * 64, request={}))
        self.assertTrue(self.permit('2', 'two', 'b' * 64)['granted'])

    def test_two_node_throttle_pauses_all_workers_across_runs(self):
        self.store.call({'op': 'claim', 'run': '100-1', 'worker': '2'}, check_legacy=False)
        self.throttle('1', 'one', self.key)
        before = time.time() * 1000
        self.throttle('2', 'two', 'b' * 64)
        # 多个出口同时被限速说明是服务商整体限制，全局暂停并跨运行保留。
        self.assertGreaterEqual(self.call('status')['until'], before + 3_600_000)
        self.assertTrue(self.call('claim')['stop'])
        self.call('end')
        self.call('begin')
        self.assertTrue(self.call('claim')['stop'])

    def test_node_circuit_breaker_halts_and_lets_another_node_continue(self):
        self.expand_registry(12)
        self.call('end')
        self.call('begin', threads=8, nodes=2, maxInFlight=16, maxClaims=16, throttleLimit=6)
        claimed = []
        for number in range(7):
            worker = f'1.{number}'
            slug = self.store.call({'op': 'claim', 'run': '100-1', 'worker': worker}, check_legacy=False)['slug']
            key = hashlib.sha256(worker.encode()).hexdigest()
            self.clear_node_backoff()
            self.throttle(worker, slug, key)
            claimed.append((worker, slug, key))
        state = read(self.store.state_path)
        # 超过 6 个线程被限速即熔断该节点，并交回未完成的租约。
        self.assertIn('1', state['halted'])
        self.assertEqual(len(state['nodeThrottle']['1']), 7)
        self.assertEqual(state['claims'][claimed[0][1]]['status'], 'released')
        self.assertEqual(state['claims'][claimed[0][1]]['worker'], '')
        # 熔断后的节点立刻停机，且不能再写已交回的游戏。
        self.assertTrue(self.store.call({'op': 'claim', 'run': '100-1', 'worker': '1.7'}, check_legacy=False)['stop'])
        self.assertTrue(self.permit('1.7', claimed[0][1], 'c' * 64)['halted'])
        with self.assertRaises(ValueError):
            self.store.call({'op': 'load', 'run': '100-1', 'worker': claimed[0][0], 'slug': claimed[0][1]}, check_legacy=False)
        # 其它节点可以接手被交回的游戏。
        taken = self.store.call({'op': 'claim', 'run': '100-1', 'worker': '2.0'}, check_legacy=False)
        self.assertEqual(taken['slug'], claimed[0][1])
        self.assertEqual(read(self.store.state_path)['claims'][taken['slug']]['worker'], '2.0')

    def test_topology_sets_concurrency_budget(self):
        self.expand_registry(4)
        self.call('end')
        started = self.call('begin', threads=8, nodes=20, maxInFlight=160, maxClaims=160, nodeMs=500, throttleLimit=7)
        self.assertEqual(started['topology']['maxInFlight'], 160)
        self.assertEqual(started['topology']['throttleLimit'], 7)
        self.assertEqual(self.call('status')['topology']['nodes'], 20)
        # 授权并发内的多个出口可以同时持有请求许可。
        for number in range(3):
            slug = self.store.call({'op': 'claim', 'run': '100-1', 'worker': f'1.{number}'}, check_legacy=False)['slug']
            self.clear_node_backoff()
            self.assertTrue(self.permit(f'1.{number}', slug, hashlib.sha256(str(number).encode()).hexdigest())['granted'])
        self.assertEqual(self.call('status')['permits'], 3)

    def test_per_node_request_interval_and_reject_report_path_escape(self):
        self.call('permit', key=self.key, request={})
        other = hashlib.sha256(b'other').hexdigest()
        # 已有请求在飞行时，同一出口的第二个请求必须等待。
        self.assertGreater(self.call('permit', key=other, request={})['wait'], 0)
        self.call('response', key=self.key, response={'status': 200, 'headers': {}, 'body': ''})
        state = read(self.store.state_path)
        state['nodeUntil']['1'] = time.time() * 1000 + 60_000
        atomic(self.store.state_path, state)
        # 同一出口在节点间隔内不得再次请求。
        self.assertGreater(self.call('permit', key=other, request={})['wait'], 0)
        with self.assertRaises(ValueError):
            self.call('files', files={'../../escape': '{}'})

    def test_head_of_line_returns_precise_node_spacing_wait(self):
        # 队首只是在自己节点的间隔里时，必须返回精确剩余时间；
        # 固定 1 秒轮询会把整体节奏压到远低于授权并发。
        state = read(self.store.state_path)
        state['nodeUntil']['1'] = time.time() * 1000 + 400
        state['topology']['nodeMs'] = 400
        atomic(self.store.state_path, state)
        wait = self.call('permit', key=hashlib.sha256(b'head').hexdigest(), request={})['wait']
        self.assertGreater(wait, 0)
        self.assertLessEqual(wait, 400)

    def test_corrupt_state_is_not_reset(self):
        self.store.state_path.write_text('broken')
        with self.assertRaises(json.JSONDecodeError):
            self.call('status')

    def test_active_session_cap_and_next_game_after_release(self):
        state = read(self.store.state_path)
        for number in range(2, 7):
            state['claims'][f'busy_{number}'] = {'worker': str(number), 'status': 'running'}
        atomic(self.store.state_path, state)
        self.assertEqual(self.call('claim')['wait'], 3000)
        self.assertNotIn('two', read(self.store.state_path)['claims'])
        self.call('done', status='incomplete', count=1)
        self.assertEqual(self.call('claim')['slug'], 'two')

    def test_fifo_prevents_fast_worker_starvation_and_expires_only_waiters(self):
        self.store.call({'op': 'claim', 'run': '100-1', 'worker': '2'}, check_legacy=False)
        second = dict(op='permit', run='100-1', worker='2', slug='two', key='b' * 64, request={})
        self.call('permit', key=self.key, request={})
        self.assertIn('wait', self.store.call(second, check_legacy=False))
        self.call('response', key=self.key, response={'status': 200, 'headers': {}, 'body': ''})
        state = read(self.store.state_path)
        state['nodeUntil'] = {}
        atomic(self.store.state_path, state)
        self.assertIn('wait', self.call('permit', key='c' * 64, request={}))
        self.assertTrue(self.store.call(second, check_legacy=False)['granted'])
        state = read(self.store.state_path)
        state['waiters'][0]['seen'] = 0
        atomic(self.store.state_path, state)
        self.assertIn('wait', self.call('permit', key='d' * 64, request={}))
        state = read(self.store.state_path)
        self.assertEqual(list(state['permits']), ['b' * 64])
        self.assertEqual([item['key'] for item in state['waiters']], ['d' * 64])

    def test_short_cooldown_waits_without_assigning_games(self):
        state = read(self.store.state_path)
        state['until'] = time.time() * 1000 + 60_000
        atomic(self.store.state_path, state)
        self.assertGreater(self.call('claim')['wait'], 0)
        self.assertEqual(len(self.call('status')['claims']), 1)

    def test_reclaim_requires_github_terminal_attempt_evidence(self):
        self.call('permit', key=self.key, request={})
        with patch('coordinator.completed_attempt', return_value=False):
            with self.assertRaises(ValueError):
                self.store.call({'op': 'begin', 'run': '200-1', 'githubToken': 'fixture'}, check_legacy=False)
        with patch('coordinator.completed_attempt', return_value=True):
            self.store.call({'op': 'begin', 'run': '200-1', 'githubToken': 'fixture'}, check_legacy=False)
        self.assertEqual(read(self.store.state_path)['owner'], '200-1')
        self.assertNotIn('fixture', self.store.state_path.read_text())
        self.assertTrue((self.store.directory / 'one' / (self.key + '.json')).exists())

    def test_pending_without_value_clears_the_incomplete_round(self):
        # 调用方省略 value 时必须按“清空未完成局”处理，而不是报错。
        self.call('pending', value={'id': 'round', 'frames': [{'frame': 1}]})
        self.assertEqual(self.call('load')['pending']['id'], 'round')
        self.store.call({'op': 'pending', 'run': '100-1', 'worker': '1', 'slug': 'one'}, check_legacy=False)
        self.assertIsNone(self.call('load')['pending'])

    def test_node_identity_and_retry_after_parsing(self):
        self.assertEqual(node_of('7.3'), '7')
        self.assertEqual(node_of('7'), '7')
        now = 1_700_000_000_000
        self.assertEqual(retry_after_ms({'retry-after': '45'}, now), 45_000)
        self.assertEqual(retry_after_ms({}, now), CONSERVATIVE_WAIT_MS)
        self.assertEqual(retry_after_ms({'retry-after': 'invalid'}, now), CONSERVATIVE_WAIT_MS)
        moment = dt.datetime.fromtimestamp(now / 1000, dt.timezone.utc) + dt.timedelta(seconds=90)
        header = moment.strftime('%a, %d %b %Y %H:%M:%S GMT')
        self.assertAlmostEqual(retry_after_ms({'retry-after': header}, now), 90_000, delta=1000)


if __name__ == '__main__':
    unittest.main()
