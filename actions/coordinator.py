"""测试服持久化协调器：只做文件、锁和恢复操作，绝不请求官方接口。"""
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read(path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.directory = self.root / 'output' / '.actions'
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_path = self.directory / 'queue.json'

    def call(self, request, check_legacy=True):
        with (self.directory / 'queue.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = read(self.state_path, {'owner': None, 'until': 0, 'next': 0, 'rateCount': 0, 'permit': None})
            result = self.execute(state, request, check_legacy)
            atomic(self.state_path, state)
            return result

    def execute(self, state, req, check_legacy):
        op = req['op']
        now = time.time() * 1000
        run = str(req.get('run', ''))
        worker = str(req.get('worker', ''))
        if op == 'status':
            return {key: state.get(key) for key in ('owner', 'until', 'next', 'claims', 'deadline')}
        if not re.fullmatch(r'[0-9]+-[0-9]+', run):
            raise ValueError('非法运行标识')
        if op == 'begin':
            if check_legacy:
                old = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', 'oaks-capture'], text=True).strip()
                if old != 'false':
                    raise ValueError('旧采集容器未停止')
            if state['owner']:
                raise ValueError('存在未释放的跨环境队列锁，需要核实旧 Actions 运行状态')
            handoff = read(self.root / 'output' / 'actions-handoff.json', {})
            if handoff.get('migrationState') != 'stopped':
                raise ValueError('缺少已停止的交接证明')
            until = dt.datetime.fromisoformat(handoff['retryNotBefore']).timestamp() * 1000
            state['until'] = max(state['until'], until)
            state['rateCount'] = max(state['rateCount'], 2)
            registry = read(self.root / 'games' / 'registry.json')
            games = [game['slug'] for game in registry['games'] if game.get('active', True)]
            cursor = state.get('cursor', handoff.get('slug'))
            if cursor in games:
                at = games.index(cursor)
                games = games[at:] + games[:at]
            state.update(owner=run, deadline=now + 40 * 60_000, claims={}, games=games)
            return {'deadline': state['deadline'], 'until': state['until'], 'games': len(games)}
        if state['owner'] != run:
            raise ValueError('跨环境队列锁不属于当前运行')
        if op == 'end':
            # 仅在 Actions 的所有 worker 已结束后调用。未确认的请求仍保留在日志中，禁止盲目重放。
            state.update(owner=None, permit=None)
            return {'released': True, 'claims': state.get('claims', {})}
        if op == 'claim':
            if now >= state['deadline'] or state['until'] >= state['deadline']:
                return {'stop': True, 'until': state['until']}
            if now < state['until']:
                return {'wait': min(30_000, state['until'] - now), 'deadline': state['deadline']}
            for slug in state['games']:
                if slug in state['claims']:
                    continue
                folder = self.root / 'output' / slug
                manifest = read(folder / 'data-manifest.json', {})
                audit = read(folder / 'mongo-audit-test.json', {})
                validation = read(folder / 'validation-report.json', {})
                if manifest.get('complete') is True and audit.get('valid') is True and validation.get('invalid') == 0 and not validation.get('missing', ['unknown']):
                    state['claims'][slug] = {'status': 'already-accepted'}
                    continue
                state['claims'][slug] = {'worker': worker, 'status': 'running', 'runner': req.get('runner', {})}
                state['cursor'] = state['games'][(state['games'].index(slug) + 1) % len(state['games'])]
                return {'slug': slug, 'deadline': state['deadline']}
            return {'stop': True}
        slug = str(req.get('slug', ''))
        if not re.fullmatch(r'[a-z0-9_]+', slug) or state.get('claims', {}).get(slug, {}).get('worker') != worker:
            raise ValueError('游戏租约不属于当前节点')
        folder = self.root / 'output' / slug
        private = self.directory / slug
        folder.mkdir(parents=True, exist_ok=True)
        private.mkdir(parents=True, exist_ok=True, mode=0o700)
        if op == 'load':
            names = [slug + '.ndjson', 'feature-inventory.json', 'coverage.json', 'capture-checkpoint.json']
            return {'files': {name: (folder / name).read_text() for name in names if (folder / name).exists()}, 'pending': read(private / 'round.json')}
        if op == 'pending':
            atomic(private / 'round.json', req['value'])
            return {}
        if op == 'files':
            allowed = {'feature-inventory.json', 'start-template.json', 'coverage.json', 'validation-report.json', 'data-manifest.json', 'mongo-audit-test.json', 'capture-checkpoint.json'}
            for name, content in req['files'].items():
                if name not in allowed:
                    raise ValueError('拒绝写入非验收文件')
                atomic(folder / name, json.loads(content))
            return {}
        if op == 'append':
            doc = req['document']
            if doc.get('game') != slug or not re.fullmatch('[a-f0-9]{64}', doc.get('sourceRoundHash', '')):
                raise ValueError('非法采集数据标识')
            target = folder / (slug + '.ndjson')
            # 游戏租约保证单写；再次提交同一局为幂等操作。
            if target.exists():
                for line in target.read_text().splitlines():
                    if json.loads(line)['sourceRoundHash'] == doc['sourceRoundHash']:
                        return {'duplicate': True}
            with target.open('a') as stream:
                line = req.get('line', json.dumps(doc, ensure_ascii=False))
                if '\n' in line or json.loads(line) != doc:
                    raise ValueError('NDJSON 行与文档不一致')
                stream.write(line + '\n')
                stream.flush()
                os.fsync(stream.fileno())
            return {'written': True}
        if op == 'ack':
            committed = req['hash']
            target = folder / (slug + '.ndjson')
            if not target.exists() or not any(json.loads(line).get('sourceRoundHash') == committed for line in target.read_text().splitlines()):
                raise ValueError('NDJSON 尚未落盘，拒绝推进恢复点')
            # 调用方已收到 Mongo acknowledged 写入确认，才推进恢复点。
            atomic(private / 'committed.json', {'sourceRoundHash': req['hash'], 'run': run, 'at': now})
            atomic(private / 'round.json', None)
            return {}
        if op == 'done':
            state['claims'][slug]['status'] = req['status']
            state['claims'][slug]['count'] = req.get('count', 0)
            return {}
        key = str(req.get('key', ''))
        if not re.fullmatch(r'[a-f0-9]{64}', key):
            raise ValueError('非法请求日志标识')
        journal = private / (key + '.json')
        if op == 'permit':
            previous = read(journal)
            if previous:
                if previous.get('response') and 200 <= previous['response']['status'] < 300:
                    return {'cached': previous['response']}
                if not previous.get('response'):
                    raise ValueError('存在结果未知的官方请求，已隔离，禁止自动重放')
            if now >= state['deadline']:
                return {'stop': True}
            if now < state['until']:
                return {'stop': True, 'until': state['until']}
            if state['permit']:
                if now - state['permit']['at'] > 90_000:
                    raise ValueError('请求锁失去响应，禁止自动抢锁')
                return {'wait': 1000}
            if now < state['next']:
                return {'wait': state['next'] - now}
            if check_legacy:
                old = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', 'oaks-capture'], text=True).strip()
                if old != 'false':
                    raise ValueError('检测到旧采集容器运行，拒绝官方请求')
            state['permit'] = {'key': key, 'slug': slug, 'worker': worker, 'at': now}
            if previous:
                atomic(private / (key + '-' + str(int(now)) + '-history.json'), previous)
            atomic(journal, {'request': req['request'], 'at': now, 'run': run, 'runner': req.get('runner', {})})
            return {'granted': True}
        if op == 'response':
            permit = state.get('permit') or {}
            if (permit.get('key'), permit.get('slug'), permit.get('worker')) != (key, slug, worker):
                raise ValueError('响应不匹配当前请求锁')
            entry = read(journal)
            entry['response'] = req['response']
            atomic(journal, entry)
            if req['response']['status'] == 429:
                state['rateCount'] += 1
                retry = req['response']['headers'].get('retry-after', '')
                try:
                    delay = float(retry) * 1000
                except ValueError:
                    from email.utils import parsedate_to_datetime
                    try:
                        delay = parsedate_to_datetime(retry).timestamp() * 1000 - now
                    except (ValueError, TypeError):
                        delay = 60_000
                state['until'] = max(state['until'], now + max(10_000, delay))
            state['next'] = now + (5000 if state['rateCount'] >= 2 else 3000)
            state['permit'] = None
            return {'until': state['until']}
        raise ValueError('未知协调操作')


if __name__ == '__main__':
    try:
        store = Store(Path(__file__).resolve().parent.parent)
        print(json.dumps({'ok': True, 'result': store.call(json.load(sys.stdin))}))
    except Exception as error:
        # 日志不输出输入、凭据、响应正文或底层异常内容。
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, ValueError) else type(error).__name__}))
        sys.exit(1)
