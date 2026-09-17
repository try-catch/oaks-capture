"""在测试服通过 sudo python3 - 执行的只读轻量检查；不采集、不打印凭据。"""
import collections
import json
import os
from pathlib import Path
import shlex
import subprocess
import time


def main():
    root = Path('/api/api_new/tools/capture-oaks')
    reply = subprocess.run(['python3', str(root / 'actions/coordinator-client.py')],
                           input='{"op":"status"}\n', text=True, capture_output=True, timeout=15, check=True)
    parsed = json.loads(reply.stdout)
    if not parsed.get('ok'):
        raise RuntimeError('COORDINATOR_UNAVAILABLE')
    state = parsed['result']
    memory = {line.split(':')[0]: int(line.split()[1]) * 1024
              for line in Path('/proc/meminfo').read_text().splitlines()}
    pressure = {}
    for resource, kind in [('cpu', 'some'), ('io', 'full'), ('memory', 'full')]:
        line = next(x for x in Path('/proc/pressure/' + resource).read_text().splitlines()
                    if x.startswith(kind + ' '))
        pressure[resource] = float(dict(x.split('=') for x in line.split()[1:])['avg10'])
    vm = subprocess.run(['vmstat', '1', '5'], capture_output=True, text=True, check=True, timeout=10).stdout
    rows = [x.split() for x in vm.splitlines() if x.strip() and x.split()[0].isdigit()][-4:]
    if len(rows) != 4:
        raise RuntimeError('SWAP_SAMPLE_INCOMPLETE')
    swap = {k: sum(float(x[i]) for x in rows) / len(rows) for k, i in [('si', 6), ('so', 7)]}
    blocked = max(int(x[1]) for x in rows)
    values = {}
    for line in (root / 'capture.env').read_text().splitlines():
        if line.startswith('OAKS_MONGO_URI='):
            values['OAKS_MONGO_URI'] = shlex.split(line.split('=', 1)[1])[0]
    if not values:
        raise RuntimeError('MONGO_CONFIGURATION_MISSING')
    # URI 只存在远端进程环境中；错误仅输出固定标识，避免驱动异常泄露连接信息。
    js = '''try {const c=new Mongo(process.env.OAKS_MONGO_URI);const a=c.getDB("admin");const ds=a.runCommand({listDatabases:1,nameOnly:true}).databases.filter(x=>x.name.startsWith("oaks_"));let total=0,missing=[];for(const x of ds){const col=c.getDB(x.name).simulate;total+=col.estimatedDocumentCount();if(!col.getIndexes().some(i=>i.name==="source_round_hash_unique"&&i.unique===true))missing.push(x.name);}print(JSON.stringify({total,databases:ds.length,missing,totalCreated:a.serverStatus().connections.totalCreated}));}catch(e){print("MONGO_HEALTH_FAILED");quit(1)}'''
    mongo = subprocess.run(['docker', 'exec', '-e', 'OAKS_MONGO_URI', 'mongodb', 'mongosh',
                            '--quiet', '--nodb', '--eval', js], env={**os.environ, **values},
                           capture_output=True, text=True, timeout=25)
    if mongo.returncode != 0:
        raise RuntimeError('MONGO_HEALTH_FAILED')
    out = {k: state.get(k) for k in ['owner', 'until', 'deadline', 'serverHalt', 'serverHealth',
                                   'metrics', 'permits', 'restoreChunkBytes']}
    out.update(at=time.time(), pressure=pressure, memAvailable=memory['MemAvailable'], swap=swap,
               blocked=blocked, mongo=json.loads(mongo.stdout),
               claims=dict(collections.Counter(x.get('status') for x in state.get('claims', {}).values())),
               runnerEnvironments=sorted(set(x.get('runner', {}).get('environment', 'unknown')
                                             for x in state.get('claims', {}).values())),
               ndjsonBytes=sum(x.stat().st_size for x in (root / 'output').glob('*/*.ndjson')))
    out['hostHealthy'] = (pressure['cpu'] < 70 and pressure['io'] < 20 and pressure['memory'] < 10
                          and memory['MemAvailable'] >= 8 * 1024**3 and max(swap.values()) < 1024
                          and blocked <= max(8, (os.cpu_count() or 1) // 4))
    print(json.dumps(out))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # 不回显异常、子进程 stderr 或配置内容；失败时监督器禁止派发。
        print(json.dumps({'error': 'SUPERVISOR_HEALTH_FAILED'}))
        raise SystemExit(1)
