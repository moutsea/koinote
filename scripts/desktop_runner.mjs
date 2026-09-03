import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [command, flavor, ...extraArgs] = process.argv.slice(2);
if (!["dev", "build"].includes(command) || !["production", "local"].includes(flavor)) {
  console.error("Usage: node scripts/desktop_runner.mjs <dev|build> <production|local>");
  process.exit(2);
}

const local = flavor === "local";
const tauriBinary = resolve(
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);
const args = [command];
if (local) args.push("--config", resolve("src-tauri", "tauri.local.conf.json"));
args.push(...extraArgs);
const child = spawn(tauriBinary, args, {
  env: {
    ...process.env,
    KOINOTE_DESKTOP_FLAVOR: flavor,
    VITE_DESKTOP_FLAVOR: flavor,
  },
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
