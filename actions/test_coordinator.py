import base64
import datetime as dt
import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from coordinator import Store, atomic, read


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
        self.call('response', key=self.key, response=response)
        self.assertEqual(self.call('permit', key=self.key, request={})['cached'], response)

    def test_429_persists_and_pauses_all_workers_across_runs(self):
        self.call('permit', key=self.key, request={})
        before = time.time() * 1000
        self.call('response', key=self.key, response={'status': 429, 'headers': {'retry-after': '3600'}, 'body': ''})
        self.assertGreaterEqual(self.call('status')['until'], before + 3_600_000)
        self.assertTrue(self.call('claim')['stop'])
        self.call('end')
        self.call('begin')
        self.assertTrue(self.call('claim')['stop'])

    def test_global_request_interval_and_reject_report_path_escape(self):
        self.call('permit', key=self.key, request={})
        other = hashlib.sha256(b'other').hexdigest()
        self.assertEqual(self.call('permit', key=other, request={})['wait'], 1000)
        self.call('response', key=self.key, response={'status': 200, 'headers': {}, 'body': ''})
        self.assertGreater(self.call('permit', key=other, request={})['wait'], 0)
        with self.assertRaises(ValueError):
            self.call('files', files={'../../escape': '{}'})

    def test_corrupt_state_is_not_reset(self):
        self.store.state_path.write_text('broken')
        with self.assertRaises(json.JSONDecodeError):
            self.call('status')


if __name__ == '__main__':
    unittest.main()
