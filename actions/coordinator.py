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
# 旧采集容器检查的缓存时长：不必每个官方请求都跑一次 docker inspect。
LEGACY_CHECK_TTL_MS = 300_000
# 这些操作不改队列状态，跳过状态回写。
READ_ONLY_OPS = {'status', 'load', 'pending', 'files', 'append', 'ack'}
# 这些操作由游戏租约保证单写，可以用各自游戏的锁而不是全局锁（status 除外，它要读一致状态）。
GAME_LOCAL_OPS = {'load', 'pending', 'files', 'append', 'ack'}


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

    def lock_path(self, request):
        """按操作选锁：只有会改共享队列状态的操作才需要全局锁。

        load/files/pending/append/ack 都由游戏租约保证单写，走各自游戏的锁，
        否则它们会白占全局锁——实测全局锁被 fsync 占满后，每轮延迟随并发线性变差。
        """
        op = request.get('op')
        slug = str(request.get('slug') or '')
        if op in GAME_LOCAL_OPS and re.fullmatch(r'[a-z0-9_]+', slug):
            return self.directory / (slug + '.game.lock')
        return self.directory / 'queue.lock'

    def call(self, request, check_legacy=True):
        with self.lock_path(request).open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = read(self.state_path, {'owner': None, 'until': 0, 'next': 0, 'rateCount': 0, 'permit': None})
            result = self.execute(state, request, check_legacy)
            # 只读与纯落盘操作不改队列状态，跳过状态回写可以省掉每轮的 fsync 开销。
            if request.get('op') not in READ_ONLY_OPS:
                atomic(self.state_path, state)
            return result

    def hashes(self, folder, private, slug):
        """按 sourceRoundHash 去重用的索引。

        原来每轮都要把整个 NDJSON 逐行 json.loads 扫一遍（1228 行约 0.72 秒，
        且随文件增长），这里用只追加的纯文本索引把去重降到一次读+集合判断。
        """
        path = private / 'hashes.txt'
        if not path.exists():
            seeded = []
            target = folder / (slug + '.ndjson')
            if target.exists():
                for line in target.read_text().splitlines():
                    try: seeded.append(json.loads(line)['sourceRoundHash'])
                    except Exception: pass
            path.write_text(''.join(h + '\n' for h in seeded))
        return set(path.read_text().split())

    def check_legacy_container(self, state, now):
        """旧采集容器检查带 TTL：原来每个官方请求都跑一次 docker inspect（0.22 秒）。"""
        if now - state.get('legacyCheckedAt', 0) < LEGACY_CHECK_TTL_MS:
            return
        old = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', 'oaks-capture'], text=True).strip()
        if old != 'false':
            raise ValueError('检测到旧采集容器运行，拒绝官方请求')
        state['legacyCheckedAt'] = now

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
                self.check_legacy_container(state, now)
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
            known = self.hashes(folder, private, slug)
            # 游戏租约保证单写；再次提交同一局为幂等操作。
            if doc['sourceRoundHash'] in known:
                return {'duplicate': True}
            with target.open('a') as stream:
                line = req.get('line', json.dumps(doc, ensure_ascii=False))
                if '\n' in line or json.loads(line) != doc:
                    raise ValueError('NDJSON 行与文档不一致')
                stream.write(line + '\n')
                stream.flush()
                os.fsync(stream.fileno())
            with (private / 'hashes.txt').open('a') as index:
                index.write(doc['sourceRoundHash'] + '\n')
            # NDJSON 已 fsync 落盘，就在这里推进恢复点，省掉调用方单独一次 ack 往返。
            # 若此刻进程崩溃，NDJSON 已领先 Mongo，恢复时会按 NDJSON 补齐 Mongo。
            atomic(private / 'committed.json', {'sourceRoundHash': doc['sourceRoundHash'], 'run': run, 'at': now})
            return {'written': True}
        if op == 'ack':
            committed = req['hash']
            if committed not in self.hashes(folder, private, slug):
                raise ValueError('NDJSON 尚未落盘，拒绝推进恢复点')
            # 调用方已收到 Mongo acknowledged 写入确认，才推进恢复点。
            atomic(private / 'committed.json', {'sourceRoundHash': committed, 'run': run, 'at': now})
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
            # 容量与节点间隔都满足就直接放行。原先还有一层 FIFO 队首判断，
            # 但它在多许可下让每个请求多轮询约 10 次（实测 permitMs 283-804、
            # permitPolls 9-11），而公平性已由每节点间隔 + 160 个许可保证。
            if len(state['permits']) >= state['topology']['maxInFlight']:
                return {'wait': 50}
            ready = state['nodeUntil'].get(node, 0)
            if now < ready:
                # 返回精确剩余时间，避免固定轮询把节奏压慢。
                return {'wait': max(20, ready - now)}
            if check_legacy:
                self.check_legacy_container(state, now)
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


def serve(store):
    """常驻模式：在一条 stdin/stdout 连接上按 JSON 行处理请求。

    与单次调用共用同一个 Store，语义完全一致；区别只是不再每次调用都
    新起 ssh + sudo + python 进程（实测每次 1-2 秒，是一轮三个往返的主要成本）。
    """
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            result = store.call(json.loads(line))
            response = {'ok': True, 'result': result}
        except Exception as error:
            # 日志不输出输入、凭据、响应正文或底层异常内容。
            response = {'ok': False, 'error': str(error) if isinstance(error, ValueError) else type(error).__name__}
        sys.stdout.write(json.dumps(response) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    if '--serve' in sys.argv:
        serve(Store(root))
        sys.exit(0)
    try:
        print(json.dumps({'ok': True, 'result': Store(root).call(json.load(sys.stdin))}))
    except Exception as error:
        # 日志不输出输入、凭据、响应正文或底层异常内容。
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, ValueError) else type(error).__name__}))
        sys.exit(1)
