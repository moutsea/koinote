import { spawn } from "node:child_process";

const [command, flavor] = process.argv.slice(2);
if (!["dev", "build"].includes(command) || !["production", "local"].includes(flavor)) {
  console.error("Usage: node scripts/desktop_frontend_runner.mjs <dev|build> <production|local>");
  process.exit(2);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["run", command], {
  env: {
    ...process.env,
    VITE_DESKTOP_FLAVOR: flavor,
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
