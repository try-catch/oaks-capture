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
import urllib.request


# 节点内每个官方请求的最小间隔。线程自身的节奏由客户端 SPIN_DELAY_MS 控制，
# 这里只保证同一出口不会在极短时间内连打。
DEFAULT_NODE_SPACING_MS = 250
# 单个节点内触发过官方限速的线程数超过该值时，判定该出口已被封控并熔断换节点。
DEFAULT_THROTTLE_LIMIT = 6
# 两个以上节点在同一窗口内都被限速，判定为服务商整体限速，改为全局暂停。
GLOBAL_LIMIT_NODES = 2
GLOBAL_LIMIT_WINDOW_MS = 120_000
# 429 未给出 Retry-After 时的保守等待。
CONSERVATIVE_WAIT_MS = 60_000
# 线程身份为 <节点>.<线程>，节点身份用于出口熔断，线程身份用于游戏租约。
THREAD_ID = re.compile(r'([0-9]+)\.([0-9]+)')


def node_of(worker):
    match = THREAD_ID.fullmatch(worker)
    return match.group(1) if match else worker


def positive_int(value, fallback):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return number if number > 0 else fallback


def retry_after_ms(headers, now):
    """官方限速等待：优先 Retry-After，无法解析时保守等待。"""
    value = (headers or {}).get('retry-after', '')
    try:
        return float(value) * 1000
    except (TypeError, ValueError):
        pass
    from email.utils import parsedate_to_datetime
    try:
        return parsedate_to_datetime(value).timestamp() * 1000 - now
    except (ValueError, TypeError):
        return CONSERVATIVE_WAIT_MS


def completed_attempt(run, token):
    if not token or not re.fullmatch(r'[0-9]+-[0-9]+', run):
        return False
    run_id, attempt = run.split('-')
    request = urllib.request.Request(
        f'https://api.github.com/repos/try-catch/oaks-capture/actions/runs/{run_id}/attempts/{attempt}',
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'oaks-queue-lock'})
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
    return result.get('status') == 'completed' and result.get('run_attempt') == int(attempt)


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

    def release_node(self, state, node):
        """熔断节点：交回它未完成的租约，让其它节点立刻接手同一批游戏。

        同时清空 worker，使被熔断线程后续的落盘和确认都会被拒绝，避免两个节点同时写同一个游戏。
        """
        for claim in state.get('claims', {}).values():
            if claim.get('status') == 'running' and node_of(str(claim.get('worker', ''))) == node:
                claim['status'] = 'released'
                claim['worker'] = ''

    def execute(self, state, req, check_legacy):
        op = req['op']
        now = time.time() * 1000
        run = str(req.get('run', ''))
        worker = str(req.get('worker', ''))
        node = str(req.get('node') or node_of(worker))
        state.setdefault('permits', {})
        state.setdefault('nodeUntil', {})
        state.setdefault('nodeThrottle', {})
        state.setdefault('halted', {})
        state.setdefault('rateNodes', [])
        # begin 总会重写 topology；这里给旧状态一个保守占位，避免升级期间放大并发。
        state.setdefault('topology', {'nodeMs': DEFAULT_NODE_SPACING_MS, 'throttleLimit': DEFAULT_THROTTLE_LIMIT,
                                      'maxInFlight': 1, 'maxClaims': 6})
        if op == 'status':
            return {key: state.get(key) for key in ('owner', 'until', 'next', 'claims', 'deadline', 'halted', 'topology')} | {
                'permits': len(state['permits']), 'nodeUntil': state['nodeUntil']}
        if not re.fullmatch(r'[0-9]+-[0-9]+', run):
            raise ValueError('非法运行标识')
        if op == 'begin':
            if check_legacy:
                old = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', 'oaks-capture'], text=True).strip()
                if old != 'false':
                    raise ValueError('旧采集容器未停止')
            if state['owner']:
                if not completed_attempt(state['owner'], req.get('githubToken', '')):
                    raise ValueError('存在未释放的跨环境队列锁，需要核实旧 Actions 运行状态')
                # 仅在 GitHub 证明旧 attempt 已结束后回收队列所有权；未知请求日志仍禁止重放。
                state.update(owner=None, permit=None, permits={})
            handoff = read(self.root / 'output' / 'actions-handoff.json', {})
            if handoff.get('migrationState') != 'stopped':
                raise ValueError('缺少已停止的交接证明')
            until = dt.datetime.fromisoformat(handoff['retryNotBefore']).timestamp() * 1000
            # 只继承交接时记录的冷却截止时间，不再强制放慢此后的节点间隔。
            state['until'] = max(state['until'], until)
            registry = read(self.root / 'games' / 'registry.json')
            games = [game['slug'] for game in registry['games'] if game.get('active', True)]
            cursor = state.get('cursor', handoff.get('slug'))
            if cursor in games:
                at = games.index(cursor)
                games = games[at:] + games[:at]
            threads = positive_int(req.get('threads'), 1)
            nodes = positive_int(req.get('nodes'), 1)
            topology = {
                'threads': threads,
                'nodes': nodes,
                'nodeMs': positive_int(req.get('nodeMs'), DEFAULT_NODE_SPACING_MS),
                'throttleLimit': positive_int(req.get('throttleLimit'), DEFAULT_THROTTLE_LIMIT),
                'maxInFlight': positive_int(req.get('maxInFlight'), threads * nodes),
                # 未显式给出时保留历史上的 6 个并发游戏会话上限。
                'maxClaims': positive_int(req.get('maxClaims'), 6),
                'deadline': now + positive_int(req.get('deadlineMinutes'), 40) * 60_000,
            }
            state.update(owner=run, deadline=topology['deadline'], claims={}, games=games, waiters=[],
                         permits={}, nodeUntil={}, nodeThrottle={}, halted={}, rateNodes=[], topology=topology)
            return {'deadline': state['deadline'], 'until': state['until'], 'games': len(games), 'topology': topology}
        if state['owner'] != run:
            raise ValueError('跨环境队列锁不属于当前运行')
        if op == 'end':
            # 仅在 Actions 的所有 worker 已结束后调用。未确认的请求仍保留在日志中，禁止盲目重放。
            state.update(owner=None, permit=None, permits={}, waiters=[])
            return {'released': True, 'claims': state.get('claims', {}), 'halted': state.get('halted', {})}
        if op in ('claim', 'permit') and node in state['halted']:
            # 该出口已被熔断：立刻停机并保留已落盘数据，由新节点接手续采。
            # 必须早于租约校验，否则被交回租约的线程只会看到普通错误。
            return {'stop': True, 'halted': True}
        if op == 'claim':
            if now >= state['deadline'] or state['until'] >= state['deadline']:                return {'stop': True, 'until': state['until']}
            if now < state['until']:
                return {'wait': min(30_000, state['until'] - now), 'deadline': state['deadline']}
            if sum(claim.get('status') == 'running' for claim in state['claims'].values()) >= state['topology']['maxClaims']:
                return {'wait': 3000, 'deadline': state['deadline']}
            for slug in state['games']:
                claim = state['claims'].get(slug)
                # 熔断节点释放出的游戏立刻可以重新认领；其余已认领游戏在本轮内不重复认领。
                if slug in state['claims'] and claim.get('status') != 'released':
                    continue
                folder = self.root / 'output' / slug
                manifest = read(folder / 'data-manifest.json', {})
                audit = read(folder / 'mongo-audit-test.json', {})
                validation = read(folder / 'validation-report.json', {})
                if manifest.get('complete') is True and audit.get('valid') is True and validation.get('invalid') == 0 and not validation.get('missing', ['unknown']):
                    state['claims'][slug] = {'status': 'already-accepted'}
                    continue
                state['claims'][slug] = {'worker': worker, 'status': 'running', 'node': node, 'runner': req.get('runner', {})}
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
            names = [slug + '.ndjson', 'feature-inventory.json', 'coverage.json', 'mode-coverage.json', 'capture-checkpoint.json']
            return {'files': {name: (folder / name).read_text() for name in names if (folder / name).exists()}, 'pending': read(private / 'round.json')}
        if op == 'pending':
            # 缺省 value 表示清空未完成局，兼容调用方省略该字段的情况。
            atomic(private / 'round.json', req.get('value'))
            return {}
        if op == 'files':
            allowed = {'feature-inventory.json', 'start-template.json', 'coverage.json', 'mode-coverage.json', 'validation-report.json', 'data-manifest.json', 'mongo-audit-test.json', 'capture-checkpoint.json'}
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
                # 只有调用方确认业务成功的响应才允许重放；官方会在 200 里返回业务失败，
                # 重放它会让这一局永久卡死，因此旧版本没有 usable 标记的记录一律重新请求。
                if previous.get('response') and previous.get('usable') is True and 200 <= previous['response']['status'] < 300:
                    return {'cached': previous['response']}
                if not previous.get('response'):
                    raise ValueError('存在结果未知的官方请求，已隔离，禁止自动重放')
            if now >= state['deadline']:
                return {'stop': True}
            if now < state['until']:
                return {'stop': True, 'until': state['until']}
            # FIFO 防止网络更快的节点反复抢占；只清理未获准请求的失联等待项。
            waiters = [item for item in state.get('waiters', []) if now - item['seen'] < 60_000]
            current = next((item for item in waiters if item['key'] == key), None)
            if current is None:
                current = {'key': key, 'node': node, 'seen': now}
                waiters.append(current)
            current['seen'] = now
            state['waiters'] = waiters
            # 等待节点自身间隔的请求不占用队首，避免一个正在退避的出口拖慢其它出口。
            eligible = [item for item in waiters if now >= state['nodeUntil'].get(item.get('node', ''), 0)]
            if len(state['permits']) >= state['topology']['maxInFlight']:
                return {'wait': 500}
            if eligible and eligible[0]['key'] != key:
                return {'wait': 500}
            if not eligible:
                # 队首就是自己、但还在等本节点间隔时返回精确剩余时间，
                # 否则固定轮询会把整体节奏压到远低于授权并发。
                ready = state['nodeUntil'].get(node, 0)
                if waiters and waiters[0]['key'] == key and now < ready:
                    return {'wait': max(50, ready - now)}
                return {'wait': 500}
            if check_legacy:
                old = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', 'oaks-capture'], text=True).strip()
                if old != 'false':
                    raise ValueError('检测到旧采集容器运行，拒绝官方请求')
            state['permits'][key] = {'key': key, 'slug': slug, 'worker': worker, 'node': node, 'at': now}
            waiters.remove(current)
            state['nodeUntil'][node] = max(state['nodeUntil'].get(node, 0), now + state['topology']['nodeMs'])
            if previous:
                atomic(private / (key + '-' + str(int(now)) + '-history.json'), previous)
            atomic(journal, {'request': req['request'], 'at': now, 'run': run, 'runner': req.get('runner', {})})
            return {'granted': True}
        if op == 'response':
            permit = state['permits'].get(key)
            if not permit or (permit.get('slug'), permit.get('worker')) != (slug, worker):
                raise ValueError('响应不匹配当前请求锁')
            del state['permits'][key]
            entry = read(journal)
            entry['response'] = req['response']
            entry['usable'] = bool(req.get('usable', 200 <= req['response']['status'] < 300))
            atomic(journal, entry)
            if req['response']['status'] == 429:
                state['rateCount'] += 1
                wait = max(10_000, retry_after_ms(req['response'].get('headers'), now))
                # 该出口立即退避并遵守 Retry-After。
                state['nodeUntil'][node] = max(state['nodeUntil'].get(node, 0), now + wait)
                threads = state['nodeThrottle'].setdefault(node, [])
                if worker not in threads:
                    threads.append(worker)
                window = [item for item in state['rateNodes'] if now - item['at'] < GLOBAL_LIMIT_WINDOW_MS]
                window.append({'node': node, 'at': now})
                state['rateNodes'] = window
                if len({item['node'] for item in window}) >= GLOBAL_LIMIT_NODES:
                    # 多个出口同时被限速说明是服务商整体的限制，所有节点一起等。
                    state['until'] = max(state['until'], now + wait)
                if len(threads) > state['topology']['throttleLimit']:
                    # 单节点内太多线程被限速：熔断该出口，保留数据并让新节点接续。
                    state['halted'][node] = now
                    self.release_node(state, node)
            return {'until': state['until'], 'nodeUntil': state['nodeUntil'].get(node, 0), 'halted': node in state['halted']}
        raise ValueError('未知协调操作')


if __name__ == '__main__':
    try:
        store = Store(Path(__file__).resolve().parent.parent)
        print(json.dumps({'ok': True, 'result': store.call(json.load(sys.stdin))}))
    except Exception as error:
        # 日志不输出输入、凭据、响应正文或底层异常内容。
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, ValueError) else type(error).__name__}))
        sys.exit(1)
