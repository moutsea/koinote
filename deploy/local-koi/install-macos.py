"""Install per-user Local services, with an optional named-tunnel origin."""
import argparse
import os
import hashlib
import plistlib
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from origin_cert import verify_origin

root = Path(__file__).resolve().parents[2]
home = Path.home()
token = home / '.config/koinote-local/tunnel.token'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--local-only',action='store_true',help='Install local services without a named tunnel.')
with_tunnel = not parser.parse_args().local_only and token.is_file()
if with_tunnel and token.stat().st_mode & 0o077:
    raise SystemExit('Place the dedicated tunnel token in ~/.config/koinote-local/tunnel.token (mode 0600).')

# The native relay trusts sockets published only inside this user's directory.
token.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
if token.parent.is_symlink() or token.parent.stat().st_uid != os.getuid():
    raise SystemExit('The Local configuration directory must belong to this user.')
token.parent.chmod(0o700)

if with_tunnel:
    origin = token.parent / 'vpc'
    cert, key = verify_origin(origin)

domain = f'gui/{os.getuid()}'
agents = home / 'Library/LaunchAgents'
logs = home / 'Library/Logs/Koinote Local'
support = home / 'Library/Application Support/Koinote Local Services'
support.mkdir(mode=0o700, parents=True, exist_ok=True)
agents.mkdir(exist_ok=True, parents=True)
logs.mkdir(mode=0o700, exist_ok=True, parents=True)
search_path = os.pathsep.join(['/opt/homebrew/bin', '/usr/local/bin', os.path.dirname(shutil.which('node') or ''), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])
for tool in ['docker', 'node', 'openssl'] + (['cloudflared'] if with_tunnel else []):
    if not shutil.which(tool, path=search_path):
        raise SystemExit(f'Missing {tool}')

# launchd does not have access to Documents. Stage the already installed tool
# versions and a built preview, instead of granting it access to the checkout.
if not (root / 'spa/dist/index.html').is_file():
    raise SystemExit('Build the Local desktop frontend before installing services.')
deps_hash = hashlib.sha256((root / 'package-lock.json').read_bytes()).hexdigest()[:16]
deps = support / f'libraries-{deps_hash}' / 'node_modules'
if not deps.exists():
    deps.parent.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=support) as tmp:
        staging = Path(tmp) / 'node_modules'
        subprocess.run(['/bin/cp', '-cR', str(root / 'node_modules'), str(staging)], check=True)
        staging.rename(deps)

source_dirs = ['worker', 'spa/src', 'spa/dist']
source_files = ['package.json', 'tsconfig.json', 'vite.config.ts', 'wrangler.jsonc', '.dev.vars', 'deploy/local-koi/service.sh']
source_files += ['deploy/local-koi/local-preview.mjs', 'deploy/local-koi/local-tls.mjs']
source_files += [p.name for p in sorted(root.glob('CHANGELOG*.md'))]
proxy_keys = {'BACKEND_INTERNAL_TOKEN', 'DEV_PORT'}
proxy_env = [line for line in (root / '.env').read_text().splitlines() if line.partition('=')[0] in proxy_keys]
encoded_env = ('\n'.join(proxy_env) + '\n').encode()
tls = token.parent / 'tls'
subprocess.run([os.sys.executable, str(root / 'deploy/local-koi/local-certs.py'), str(tls)], check=True)
if subprocess.run(['docker', 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
    subprocess.run(['docker', 'desktop', 'start'], check=True)
compose = ['docker','compose','-f','docker-compose.yml','-f','deploy/local-koi/docker-compose.tls.yml']
compose_env = {**os.environ, 'KOI_LOCAL_TLS_DIR':str(tls),
               'KOI_LOCAL_CERT_VERSION':hashlib.sha256((tls/'backend.crt').read_bytes()+(tls/'images.crt').read_bytes()).hexdigest()}
if with_tunnel:
    # Only the private host directory and the unprivileged Go container can read this key.
    key.chmod(0o444)
    compose += ['-f','deploy/local-koi/docker-compose.vpc.yml']
    compose_env.update(KOI_VPC_CERT_DIR=str(origin),KOI_VPC_CERT_VERSION=hashlib.sha256(cert.read_bytes()).hexdigest())
subprocess.run(compose + ['up','-d','--build','backend'],cwd=root,env=compose_env,check=True)
revision = hashlib.sha256(str(deps).encode() + encoded_env + (tls / 'backend.crt').read_bytes() + (tls / 'images.crt').read_bytes())
files = [root / f for f in source_files]
for directory in source_dirs:
    files.extend(p for p in sorted((root / directory).rglob('*')) if p.is_file())
for p in files:
    revision.update(str(p.relative_to(root)).encode() + b'\0' + hashlib.sha256(p.read_bytes()).digest())
release = support / ('runtime-' + revision.hexdigest()[:16])
if not release.exists():
    with tempfile.TemporaryDirectory(dir=support) as tmp:
        staging = Path(tmp) / 'runtime'
        staging.mkdir(mode=0o700)
        (staging / 'node_modules').symlink_to(deps, target_is_directory=True)
        for name in source_dirs:
            target = staging / name
            target.parent.mkdir(exist_ok=True)
            shutil.copytree(root / name, target)
        for name in source_files:
            target = staging / (Path(name).name if name == 'deploy/local-koi/service.sh' else name)
            target.parent.mkdir(exist_ok=True, parents=True)
            shutil.copyfile(root / name, target)
        (staging / '.env').write_bytes(encoded_env)
        variables = staging / '.dev.vars'
        lines = [line for line in variables.read_text().splitlines() if line.partition('=')[0].strip() != 'BACKEND_URL']
        variables.write_text('\n'.join(lines + ['BACKEND_URL=https://127.0.0.1:18090']) + '\n')
        for name in ['.env', '.dev.vars']:
            (staging / name).chmod(0o600)
        staging.rename(release)

# Keep a single Wrangler store for the managed Worker and manual dev runs.
# Move the closed store as one directory; never copy a live SQLite/WAL pair.
state = support / 'worker-state'
original = root / '.wrangler/state'
if original.is_symlink():
    if original.resolve() != state or not state.is_dir():
        raise SystemExit('The checkout already uses a different Wrangler state directory.')
elif original.is_dir():
    if state.exists() or subprocess.run(['/usr/sbin/lsof', '+D', str(original)], capture_output=True).returncode != 1:
        raise SystemExit('Stop the local Wrangler process and verify its state directory before installation.')
    original.rename(state)
    try:
        original.symlink_to(state, target_is_directory=True)
    except BaseException:
        state.rename(original)
        raise
else:
    state.mkdir(mode=0o700, exist_ok=True)
    original.parent.mkdir(exist_ok=True)
    original.symlink_to(state, target_is_directory=True)

def install(name, args, keep_alive):
    label = f'app.koinote.local-{name}'
    plist = agents / f'{label}.plist'
    config = {'Label': label, 'ProgramArguments': args, 'RunAtLoad': True,
              'KeepAlive': keep_alive, 'ThrottleInterval': 10, 'WorkingDirectory': str(support if name == 'tunnel' else release),
              'EnvironmentVariables': {'PATH': search_path, 'KOI_WORKER_STATE': str(state), 'KOI_LOCAL_TLS_DIR': str(tls)}, 'Umask': 0o077,
              'StandardOutPath': str(logs / f'{name}.log'), 'StandardErrorPath': str(logs / f'{name}.log')}
    target = f'{domain}/{label}'
    loaded = subprocess.run(['launchctl', 'print', target], capture_output=True).returncode == 0
    data = plistlib.dumps(config)
    if plist.exists() and plist.read_bytes() == data and loaded:
        return
    if loaded:
        subprocess.run(['launchctl', 'bootout', target], check=True)
    tmp = plist.with_suffix('.new')
    tmp.write_bytes(data)
    tmp.chmod(0o600)
    tmp.replace(plist)
    # bootout can return while launchd is still releasing the previous job.
    for attempt in range(20):
        registered = subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], capture_output=True, text=True)
        if registered.returncode == 0:
            break
        if registered.returncode != 5 or attempt == 19:
            raise SystemExit(registered.stderr)
        time.sleep(0.5)

script = str(release / 'service.sh')
if with_tunnel:
    install('tunnel', [shutil.which('cloudflared', path=search_path), 'tunnel', '--no-autoupdate', '--protocol', 'http2',
                   'run', '--token-file', str(token)], True)
else:
    target = f'{domain}/app.koinote.local-tunnel'
    if subprocess.run(['launchctl','print',target],capture_output=True).returncode == 0:
        subprocess.run(['launchctl','bootout',target],check=True)
    (agents / 'app.koinote.local-tunnel.plist').unlink(missing_ok=True)
install('vite', ['/bin/bash', script, 'vite'], True)
install('images', ['/bin/bash', script, 'images'], True)
install('backend', ['/bin/bash', script, 'backend'], {'SuccessfulExit': False})
print('Installed Local backend, Vite and image Worker.' + (' Named tunnel enabled.' if with_tunnel else ''))
