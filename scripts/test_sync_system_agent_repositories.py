"""Exercise the deployment wrapper without contacting Docker or a server."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "deploy/sync-system-agent-repositories.sh"


class SyncWrapperTests(unittest.TestCase):
    def test_token_uses_stdin_and_arguments_survive_shell(self):
        with tempfile.TemporaryDirectory(prefix="koinote sync ") as directory:
            root = Path(directory)
            docker = root / "docker"
            docker.write_text("""#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
token = sys.stdin.readline().strip()
assert token == 'fixture-ephemeral-token'
assert all(token not in arg for arg in args)
assert args[:9] == ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml', 'exec', '-T', 'backend', 'sh']
assert args[9] == '-c'
assert 'read -r GITHUB_TOKEN' in args[10]
assert 'exec /app/koinote-repository-sync "$@"' in args[10]
print(json.dumps({'args':args[12:], 'cwd':os.getcwd()}))
""", encoding="utf-8")
            docker.chmod(0o700)
            env = dict(os.environ, PATH=directory + os.pathsep + os.environ["PATH"], KOINOTE_DEPLOY_DIR=directory)
            for args in [[], ["--apply"], ["--discover"], ["--discover", "--apply"], ["--apply", "--workspace-id", "123"], ["--workspace-id", "bad; touch injected"]]:
                with self.subTest(args=args):
                    result = subprocess.run(["sh", str(SCRIPT), *args], input="fixture-ephemeral-token\n", text=True, capture_output=True, env=env, check=True)
                    self.assertEqual(json.loads(result.stdout), {"args": args, "cwd": str(root.resolve())})
                    self.assertNotIn("fixture-ephemeral-token", result.stdout + result.stderr)
                    self.assertFalse((root / "injected").exists())


if __name__ == "__main__":
    unittest.main()
