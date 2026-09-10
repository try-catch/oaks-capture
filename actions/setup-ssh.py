"""Runner 内构建 SSH 配置，不打印密钥、Mongo URI 或内部地址。"""
import os
from pathlib import Path
import re
import subprocess

root = Path(os.environ['RUNNER_TEMP']) / 'oaks-ssh'
root.mkdir(mode=0o700, exist_ok=True)
for env, filename in [('OAKS_SSH_KEY', 'key'), ('OAKS_KNOWN_HOSTS', 'known_hosts')]:
    value = os.environ.get(env, '')
    if not value.strip():
        raise SystemExit('缺少 SSH Secret')
    (root / filename).write_text(value.rstrip() + '\n')
    (root / filename).chmod(0o600)
host = os.environ['OAKS_SSH_HOST']
mongo = os.environ['OAKS_MONGO_HOST']
if not all(re.fullmatch(r'[A-Za-z0-9.-]+', value) for value in [host, mongo]):
    raise SystemExit('非法 SSH/隧道目标')
config = root / 'config'
config.write_text(f'''Host oaks-store
  HostName {host}
  User ubuntu
  IdentityFile {root / 'key'}
  UserKnownHostsFile {root / 'known_hosts'}
  StrictHostKeyChecking yes
  BatchMode yes
  IdentitiesOnly yes
  ConnectTimeout 15
  ServerAliveInterval 15
  ServerAliveCountMax 2
  ControlMaster auto
  ControlPath {root / 'master'}
  ControlPersist 120
  ExitOnForwardFailure yes
''')
config.chmod(0o600)
subprocess.run(['ssh', '-F', str(config), '-L', f'127.0.0.1:27018:{mongo}:27017', '-MNf', 'oaks-store'], check=True)
with open(os.environ['GITHUB_ENV'], 'a') as stream:
    stream.write(f'OAKS_SSH_CONFIG={config}\n')
