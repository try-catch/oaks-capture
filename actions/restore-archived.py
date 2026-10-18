"""入口验证成功且已认领后，按需从 Mongo 恢复已归档历史；不占协调器锁。"""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

slug = sys.argv[1]
if not re.fullmatch(r'[a-z0-9_]+', slug):
    raise SystemExit('INVALID_SLUG')
root = Path('/api/api_new/tools/capture-oaks')
folder = root / 'output' / slug
target = folder / (slug + '.ndjson')
marker = folder / 'local-history-archived.json'
if target.exists() or not marker.exists():
    print('NOT_ARCHIVED')
    raise SystemExit(0)
archive = json.loads(marker.read_text())
dbname = archive['dbName']
if not re.fullmatch(r'oaks_[A-Za-z0-9_]+', dbname):
    raise SystemExit('INVALID_DB')
uri = next(shlex.split(line.split('=', 1)[1])[0] for line in (root/'capture.env').read_text().splitlines() if line.startswith('OAKS_MONGO_URI='))
js = "const c=Mongo(process.env.OAKS_MONGO_URI).getDB(" + json.dumps(dbname) + ").simulate;print(JSON.stringify({expected:c.countDocuments({})}));c.find({},{_id:0}).forEach(d=>print(JSON.stringify(d)));"
fd, tmp = tempfile.mkstemp(prefix='.mongo-restore-', dir=folder)
seen = set()
try:
    child = subprocess.Popen(['docker', 'exec', '-e', 'OAKS_MONGO_URI='+uri, 'mongodb', 'mongosh', '--nodb', '--quiet', '--eval', js], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    expected = json.loads(child.stdout.readline())['expected']
    with os.fdopen(fd, 'w') as out:
        for line in child.stdout:
            doc = json.loads(line)
            h = doc.get('sourceRoundHash', '')
            if not re.fullmatch('[a-f0-9]{64}', h) or h in seen or not doc.get('validation', {}).get('valid') or not doc.get('data', [])[-1].get('context', {}).get('round_finished'):
                raise ValueError('INVALID_HISTORY')
            seen.add(h)
            out.write(line)
        if child.wait() or len(seen) != expected or not seen:
            raise ValueError('COUNT_MISMATCH')
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, target)
    directory = os.open(folder, os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)
    print(json.dumps({'restored': slug, 'count': len(seen)}))
finally:
    if 'child' in locals() and child.poll() is None:
        child.terminate()
        child.wait()
    if os.path.exists(tmp): os.unlink(tmp)
