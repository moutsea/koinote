// Publish a private HTTP endpoint only after this Vite instance has bound the
// Local port. Native requests never need to trust the owner of a TCP port.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function publishLocalEndpoint(server, directory = join(homedir(), ".config", "koinote-local")) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  if (process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o077))) {
    throw new Error("Koinote Local 的配置目录必须仅允许当前用户访问（0700）。");
  }
  const id = randomUUID();
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\koinote-local-${id}` : join(directory, `api-${id}.sock`);
  const manifest = join(directory, "preview.json");
  const bridge = createServer((req, res) => {
    // Explicit HTTP proxies receive absolute request targets.
    if (!req.url?.startsWith("/")) {
      let target;
      try { target = new URL(req.url); } catch { /* Reject invalid proxy targets. */ }
      if (target?.origin !== "http://localhost:5273") {
        res.writeHead(400).end(); return;
      }
      req.url = target.pathname + target.search;
    }
    server.emit("request", req, res);
  });
  server.once("close", () => bridge.close());
  const temp = join(directory, `preview-${id}.tmp`);
  try {
    await new Promise((resolve, reject) => {
      bridge.once("error", reject);
      bridge.listen(socket, resolve);
    });
    if (process.platform !== "win32") await chmod(socket, 0o600);
    await writeFile(temp, JSON.stringify({ id, pid: process.pid }), { mode: 0o600, flag: "wx" });
    await rename(temp, manifest);
  } catch (error) {
    bridge.close();
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export function localPreviewIPC() {
  const register = ({ httpServer }) => {
    if (!httpServer) return;
    const publish = () => {
      if (httpServer.address()?.port === 5273) {
        void publishLocalEndpoint(httpServer).catch(error => console.error("Koinote Local:", error.message));
      }
    };
    if (httpServer.listening) publish();
    else httpServer.once("listening", publish);
  };
  return { name: "koinote-local-ipc", configureServer: register, configurePreviewServer: register };
}
