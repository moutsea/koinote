// Foreground development on macOS, Linux and Windows, without a named tunnel.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { isIPv4 } from "node:net";
import { startImageRelay } from "./image-relay.mjs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const tls = process.env.KOI_LOCAL_TLS_DIR || join(homedir(), ".config", "koinote-local", "tls");
if (process.platform === "darwin" && existsSync(join(homedir(),"Library/LaunchAgents/app.koinote.local-backend.plist"))) {
  console.log("这台 Mac 已安装托管服务，请使用 deploy/local-koi/install-macos.py 更新，或直接启动 Web / 桌面端。");
  process.exit(0);
}
mkdirSync(tls, {recursive:true,mode:0o700});
function run(command,args,env=process.env) {
  const result = spawnSync(command,args,{cwd:root,env,stdio:"inherit"});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"), ["deploy/local-koi/local-certs.py",tls]);
const revision=createHash("sha256").update(readFileSync(join(tls,"backend.crt"))).update(readFileSync(join(tls,"images.crt"))).digest("hex");
const compose = ["compose","-f","docker-compose.yml","-f","deploy/local-koi/docker-compose.tls.yml"];
const composeEnv = {...process.env,KOI_LOCAL_TLS_DIR:tls,KOI_LOCAL_CERT_VERSION:revision};
function dockerValue(args) {
  const result = spawnSync("docker",args,{encoding:"utf8",stdio:["ignore","pipe","inherit"]});
  if (result.error || result.status !== 0) throw result.error ?? new Error("Docker configuration unavailable");
  return result.stdout.trim();
}
let gateway;
if (process.platform === "linux" && !dockerValue(["info","--format","{{.OperatingSystem}}"]).includes("Docker Desktop")) {
  const interfaces = Object.values(networkInterfaces()).flat().filter(Boolean);
  const configs = JSON.parse(dockerValue(["network","inspect","bridge","--format","{{json .IPAM.Config}}"]));
  gateway = configs.map(config => config.Gateway).find(ip => isIPv4(ip) && interfaces.some(net => net.address === ip));
  if (!gateway) throw new Error("无法找到本机 Docker 网桥，Local 图床需要与后端使用同一台 Docker 主机。");
  compose.push("-f","deploy/local-koi/docker-compose.linux.yml");
  composeEnv.KOI_IMAGE_GATEWAY = gateway;
}
run("docker",[...compose,"up","-d","--build","backend"],composeEnv);
const relay = gateway && await startImageRelay(gateway);
try {
  const worker = spawn(process.execPath,["node_modules/wrangler/bin/wrangler.js","dev","--local","--ip","127.0.0.1","--port","8788",
    "--local-protocol","https","--https-key-path",join(tls,"images.key"),"--https-cert-path",join(tls,"images.crt"),
    "--var","BACKEND_URL:https://127.0.0.1:18090"],{cwd:root,stdio:"inherit",
    env:{...process.env,NODE_EXTRA_CA_CERTS:join(tls,"backend.ca.crt")}});
  for (const signal of ["SIGINT","SIGTERM"]) process.once(signal,()=>worker.kill(signal));
  const [status,signal] = await once(worker,"exit");
  process.exitCode = status ?? (signal === "SIGINT" ? 130 : 1);
} finally {
  relay?.close();
}
