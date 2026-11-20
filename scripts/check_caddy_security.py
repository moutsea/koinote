"""Exercise the deployed log filters with a real proxy failure in isolated Docker."""
from pathlib import Path
import argparse
import json
import shlex
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--ssh', help='Optional Docker host reached over an existing SSH configuration')
args = parser.parse_args()
source = Path(__file__).resolve().parents[1].joinpath('deploy/Caddyfile').read_text()
filters = []
position = 0
while True:
    start = source.find('format filter {', position)
    if start < 0:
        break
    depth = 0
    for end in range(source.index('{', start), len(source)):
        depth += (source[end] == '{') - (source[end] == '}')
        if depth == 0:
            filters.append(source[start:end + 1])
            position = end + 1
            break
assert len(filters) == 2, 'Both runtime and access logs require a filter'
fixture = ('{\nadmin off\nlog default {\n' + filters[0] + '\n}\n}\n'
           'http://127.0.0.1:18090 {\nlog {\noutput stdout\n' + filters[1]
           + '\n}\nreverse_proxy 127.0.0.1:18091\n}\n')
script = r'''
set -eu
cat > /tmp/Caddyfile
caddy run --config /tmp/Caddyfile --adapter caddyfile > /tmp/probe.log 2>&1 &
child=$!
trap 'kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true' EXIT
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  wget -q -O /dev/null \
    --header 'X-Koinote-Internal-Token: INTERNAL_CREDENTIAL_CANARY' \
    --header 'X-Koinote-Origin-Token: ORIGIN_CREDENTIAL_CANARY' \
    --header 'Cookie: secret=COOKIE_CREDENTIAL_CANARY' \
    'http://127.0.0.1:18090/probe?code=QUERY_CREDENTIAL_CANARY' 2>/dev/null || true
  if grep -q '"status":502' /tmp/probe.log; then break; fi
  sleep 0.1
done
cat /tmp/probe.log
'''
command = ['docker', 'run', '--rm', '-i', '--network', 'none', '--entrypoint', 'sh',
           'caddy:2-alpine', '-c', script]
if args.ssh:
    command = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', args.ssh,
               shlex.join(command)]
result = subprocess.run(command, input=fixture, capture_output=True, text=True, timeout=60)
assert result.returncode == 0, result.stderr
assert 'CREDENTIAL_CANARY' not in result.stdout, 'Credential/query leaked into log'
entries = []
for line in result.stdout.splitlines():
    try:
        entry = json.loads(line)
    except ValueError:
        continue
    if 'request' in entry:
        entries.append(entry)
assert any('error' in entry.get('logger', '') for entry in entries), 'Runtime error not exercised'
assert any('access' in entry.get('logger', '') for entry in entries), 'Access log not exercised'
for entry in entries:
    assert 'headers' not in entry['request']
    assert 'resp_headers' not in entry
    assert entry['request']['uri'] == '/probe'
print('Caddy runtime/access redaction passed against a real 502; headers and query removed.')
