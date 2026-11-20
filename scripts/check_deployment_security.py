#!/usr/bin/env python3
"""运行真实 workflow shell 的日志回归；SSH/Stripe 使用本机测试替身。"""
from pathlib import Path
import ast
import copy
import ipaddress
import json
import os
import re
import stat
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / '.github/workflows/deploy.yml'
VERIFY = ROOT / '.github/workflows/verify-vps-ssh.yml'
CANARY = 'private-provider-output-must-not-enter-public-log'
FAKE_KEY = '_'.join(('sk', 'live', 'A' * 40))


def step_script(path, name):
    source = path.read_text()
    match = re.search(r'^      - name: ' + re.escape(name) + r'\n(?P<body>.*?)(?=^      - |\Z)', source, re.M | re.S)
    if not match:
        raise AssertionError('Missing workflow step: ' + name)
    body = match.group('body')
    run = re.search(r'^        run: \|\n(?P<script>(?:^          .*\n|^\n)*)', body, re.M)
    if not run:
        raise AssertionError('Missing multiline run block: ' + name)
    return textwrap.dedent(run.group('script'))


def gate_allows(context):
    match = re.search(r'^    if: >-\n((?:^      .+\n)+)', DEPLOY.read_text(), re.M)
    if not match:
        raise AssertionError('Missing job-level deployment gate')

    def resolve(match):
        value = context
        for field in match[0].split('.')[1:]:
            value = value.get(field) if isinstance(value, dict) else None
        return repr(value)

    expression = re.sub(r'github(?:\.[A-Za-z_]+)+', resolve, match[1]).replace('&&', ' and ').replace('\n', ' ')
    tree = ast.parse(expression.strip(), mode='eval')
    allowed = (ast.Expression, ast.BoolOp, ast.And, ast.Compare, ast.Eq, ast.Constant, ast.Load)
    if any(not isinstance(node, allowed) for node in ast.walk(tree)):
        raise AssertionError('Unsupported deployment-gate expression')
    return bool(eval(compile(tree, '<actual-workflow-gate>', 'eval'), {'__builtins__': {}}, {}))


MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
scenario = os.environ['SCENARIO']
canary = os.environ['CANARY']
with open(os.environ['RECORD'], 'a') as f:
    f.write(json.dumps({'tool': name, 'args': args}) + '\n')
if name == 'sleep':
    sys.exit(0)
if name == 'ssh-keygen':
    print('ssh-ed25519 TEST-PUBLIC-KEY' if '-y' in args else '256 SHA256:' + 'A' * 43 + ' test (ED25519)')
    sys.exit(0)
if name == 'curl':
    config = sys.stdin.read() if '--config' in args else ''
    with open(os.environ['CURL_CONFIG'], 'w') as f:
        f.write(config)
    output = args[args.index('--output') + 1]
    if scenario == 'stripe-transport-error':
        print(canary + ' ' + os.environ['STRIPE_SECRET_KEY'], file=sys.stderr)
        sys.exit(7)
    if scenario == 'stripe-http-error':
        body = {'error': {'message': canary + ' ' + os.environ['STRIPE_SECRET_KEY']}}
        code = '401'
    else:
        body = {'id': args[-1].rsplit('/', 1)[-1], 'object': 'product', 'active': True, 'livemode': scenario != 'stripe-wrong-mode'}
        code = '200'
    pathlib.Path(output).write_text(json.dumps(body))
    print(code, end='')
    sys.exit(0)
if name == 'ssh':
    command = args[-1]
    if 'logs --tail' in command:
        print(canary)
        sys.exit(0)
    if scenario in ('backend-build-failure', 'backup-build-failure', 'verification-ssh-failure'):
        print(canary)
        print(canary, file=sys.stderr)
        sys.exit(42)
    if 'run-private-command.sh' in command:
        sys.exit(0)
    if 'State.Health.Status' in command:
        print(canary if scenario == 'backup-contaminated' else 'healthy' if scenario == 'backup-ok' else 'unhealthy')
    elif 'curl ' in command:
        print(canary if scenario == 'backend-contaminated' else '200' if scenario in ('backend-ok', 'verification-ok') else '503')
    sys.exit(0)
raise SystemExit('unexpected mocked tool')
'''


class DeploymentGateTests(unittest.TestCase):
    def test_trusted_main_push_only(self):
        trusted = {'repository': 'moutsea/koinote', 'sha': 'a' * 40, 'event_name': 'workflow_run', 'event': {'workflow_run': {
            'event': 'push', 'conclusion': 'success', 'head_branch': 'main',
            'head_repository': {'full_name': 'moutsea/koinote'}, 'head_sha': 'a' * 40}}}
        self.assertTrue(gate_allows(trusted))
        changes = [
            ('same-repo PR', ('event', 'workflow_run', 'event'), 'pull_request'),
            ('fork push', ('event', 'workflow_run', 'head_repository', 'full_name'), 'outside/repository'),
            ('other branch', ('event', 'workflow_run', 'head_branch'), 'feature'),
            ('failed CI', ('event', 'workflow_run', 'conclusion'), 'failure'),
            ('cancelled CI', ('event', 'workflow_run', 'conclusion'), 'cancelled'),
            ('manual event', ('event_name',), 'workflow_dispatch'),
            ('forked workflow', ('repository',), 'outside/koinote'),
            ('missing source', ('event', 'workflow_run', 'head_repository'), None),
            ('obsolete commit', ('event', 'workflow_run', 'head_sha'), 'b' * 40),
            ('missing commit', ('event', 'workflow_run', 'head_sha'), None),
        ]
        for name, fields, value in changes:
            event = copy.deepcopy(trusted)
            target = event
            for field in fields[:-1]:
                target = target[field]
            target[fields[-1]] = value
            with self.subTest(name=name):
                self.assertFalse(gate_allows(event))
        fork_pr = copy.deepcopy(trusted)
        fork_pr['event']['workflow_run'].update(event='pull_request', head_repository={'full_name': 'outside/koinote'})
        self.assertFalse(gate_allows(fork_pr))


class WorkflowOutputTests(unittest.TestCase):
    def run_step(self, name, scenario, path=DEPLOY):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            bin_dir = work / 'bin'
            bin_dir.mkdir()
            temporary = work / 'temporary'
            temporary.mkdir()
            for tool in ('ssh', 'curl', 'sleep', 'ssh-keygen'):
                p = bin_dir / tool
                p.write_text(MOCK)
                p.chmod(0o755)
            env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'], TMPDIR=str(temporary),
                       SCENARIO=scenario, CANARY=CANARY, RECORD=str(work / 'calls'), CURL_CONFIG=str(work / 'curl-config'),
                       HOST='deployment.example.invalid', SSH_KEY='simulated-private-key', HOST_KEY='simulated-known-host',
                       EXPECTED_FINGERPRINT='SHA256:' + 'A' * 43, STRIPE_SECRET_KEY=FAKE_KEY,
                       STRIPE_LIFETIME_PRODUCT_ID='prod_lifetime_fixture', STRIPE_CREDITS_PRODUCT_ID='prod_credits_fixture')
            result = subprocess.run(['bash', '-euo', 'pipefail', '-c', step_script(path, name)],
                                    env=env, capture_output=True, text=True, timeout=30)
            self.assertNotIn(CANARY, result.stdout + result.stderr)
            self.assertNotIn(FAKE_KEY, result.stdout + result.stderr)
            self.assertEqual(list(temporary.iterdir()), [], 'temporary diagnostics or credentials were not cleaned')
            calls = [json.loads(line) for line in (work / 'calls').read_text().splitlines()]
            config = (work / 'curl-config').read_text() if (work / 'curl-config').exists() else ''
            return result, calls, config

    def test_stripe_success_uses_stdin_not_process_arguments(self):
        result, calls, config = self.run_step('验证 Stripe 商品属于正式模式', 'stripe-ok')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(FAKE_KEY, config)
        self.assertTrue(all(FAKE_KEY not in ' '.join(call['args']) for call in calls))
        self.assertEqual(sum(call['tool'] == 'curl' for call in calls), 2)

    def test_stripe_error_body_and_transport_output_are_private(self):
        for scenario in ('stripe-http-error', 'stripe-transport-error', 'stripe-wrong-mode'):
            with self.subTest(scenario=scenario):
                result, _, _ = self.run_step('验证 Stripe 商品属于正式模式', scenario)
                self.assertNotEqual(result.returncode, 0)

    def test_backend_failure_does_not_dump_logs_or_arbitrary_status(self):
        for scenario in ('backend-http-error', 'backend-contaminated'):
            with self.subTest(scenario=scenario):
                result, calls, _ = self.run_step('验活', scenario)
                self.assertEqual(result.returncode, 1)
                self.assertTrue(all('logs --tail' not in ' '.join(call['args']) for call in calls))

    def test_backend_health_success(self):
        result, _, _ = self.run_step('验活', 'backend-ok')
        self.assertEqual(result.returncode, 0)

    def test_build_connection_errors_are_private(self):
        for name, scenario in [('重建并重启后端', 'backend-build-failure'), ('启动并验证数据库异地备份', 'backup-build-failure')]:
            with self.subTest(name=name):
                result, calls, _ = self.run_step(name, scenario)
                self.assertEqual(result.returncode, 1)
                self.assertIn('run-private-command.sh', calls[0]['args'][-1])

    def test_backup_failure_does_not_dump_logs_or_arbitrary_status(self):
        for scenario in ('backup-unhealthy', 'backup-contaminated'):
            with self.subTest(scenario=scenario):
                result, calls, _ = self.run_step('启动并验证数据库异地备份', scenario)
                self.assertEqual(result.returncode, 1)
                self.assertTrue(all('logs --tail' not in ' '.join(call['args']) for call in calls))

    def test_backup_health_success(self):
        result, _, _ = self.run_step('启动并验证数据库异地备份', 'backup-ok')
        self.assertEqual(result.returncode, 0)

    def test_ssh_verification_does_not_publish_connection_errors(self):
        result, _, _ = self.run_step('Verify deployment key and backend connectivity', 'verification-ssh-failure', VERIFY)
        self.assertEqual(result.returncode, 1)
        result, _, _ = self.run_step('Verify deployment key and backend connectivity', 'verification-ok', VERIFY)
        self.assertEqual(result.returncode, 0)


class PrivateServerLogTests(unittest.TestCase):
    def test_failed_command_preserves_status_and_private_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            log_dir = Path(directory) / 'logs'
            env = dict(os.environ, KOINOTE_DEPLOY_LOG_DIR=str(log_dir), CANARY=CANARY)
            result = subprocess.run(['sh', str(ROOT / 'deploy/run-private-command.sh'), 'backend-build', 'sh', '-c',
                                     'printf "%s\\n" "$CANARY"; printf "%s\\n" "$CANARY" >&2; exit 42'],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 42)
            self.assertNotIn(CANARY, result.stdout + result.stderr)
            self.assertEqual(stat.S_IMODE(log_dir.stat().st_mode), 0o700)
            logs = list(log_dir.iterdir())
            self.assertEqual(len(logs), 1)
            self.assertEqual(stat.S_IMODE(logs[0].stat().st_mode), 0o600)
            self.assertIn(CANARY, logs[0].read_text())

    def test_successful_command_output_is_not_published_or_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            env = dict(os.environ, KOINOTE_DEPLOY_LOG_DIR=directory)
            result = subprocess.run(['sh', str(ROOT / 'deploy/run-private-command.sh'), 'backup-build', 'printf', CANARY],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertNotIn(CANARY, result.stdout + result.stderr)
            self.assertEqual(list(Path(directory).iterdir()), [])


class DeploymentConfigurationTests(unittest.TestCase):
    def test_operational_sources_do_not_embed_public_addresses(self):
        files = [VERIFY, ROOT / 'docs/DEPLOYMENT_SECURITY.zh.md', ROOT / 'docs/DEPLOY_SSH_KEY_ROTATION.zh.md', ROOT / 'docs/KOI_AI_EXECUTOR_RECOVERY.zh.md',
                 ROOT / 'deploy/wechat-proxy/README.md', ROOT / 'deploy/wechat-proxy/koinote-wechat-tunnel.service',
                 ROOT / 'deploy/wechat-proxy/https-cert-deploy-hook.sh']
        for path in files:
            for value in re.findall(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])', path.read_text()):
                try:
                    address = ipaddress.ip_address(value)
                except ValueError:
                    continue
                self.assertFalse(address.is_global, str(path.relative_to(ROOT)) + ' contains a public address')
        self.assertNotIn('expected_host:', VERIFY.read_text())

    def test_certificate_hook_ignores_an_unrelated_renewal(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'cert-lineage'
            config.write_text(directory + '/expected\n')
            result = subprocess.run(['sh', str(ROOT / 'deploy/wechat-proxy/https-cert-deploy-hook.sh')],
                                    env=dict(os.environ, WECHAT_RELAY_CERT_LINEAGE_FILE=str(config), RENEWED_LINEAGE=directory + '/other'),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, '')

    def test_certificate_configuration_is_data_not_shell_code(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'cert-lineage'
            marker = Path(directory) / 'must-not-execute'
            config.write_text(directory + '/$(touch ' + str(marker) + ')\n')
            result = subprocess.run(['sh', str(ROOT / 'deploy/wechat-proxy/https-cert-deploy-hook.sh')],
                                    env=dict(os.environ, WECHAT_RELAY_CERT_LINEAGE_FILE=str(config), RENEWED_LINEAGE=directory + '/other'),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(marker.exists())

    def test_shell_syntax(self):
        for path in (DEPLOY, VERIFY):
            source = path.read_text()
            for index, match in enumerate(re.finditer(r'^        run: \|\n((?:^          .*\n|^\n)*)', source, re.M)):
                result = subprocess.run(['bash', '-n'], input=textwrap.dedent(match[1]), capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, str(path) + ':' + str(index) + ': ' + result.stderr)
        for name in ('deploy/run-private-command.sh', 'deploy/wechat-proxy/https-cert-deploy-hook.sh'):
            result = subprocess.run(['sh', '-n', str(ROOT / name)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
