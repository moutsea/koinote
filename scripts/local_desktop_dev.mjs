import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer as createVite } from "vite";
import { publishLocalEndpoint } from "../deploy/local-koi/local-preview.mjs";

// A dev WebView can invoke native commands. Only point it at a listener this
// runner already owns, never at whichever application happened to bind 5273.
export async function startLocalDesktopDev({ port = 5275 } = {}) {
  const parent = join(homedir(), ".config", "koinote-local");
  await mkdir(parent, { mode: 0o700, recursive: true });
  const directory = await mkdtemp(join(parent, "dev-"));
  const server = createServer();
  let vite;
  const close = async () => {
    server.closeAllConnections();
    server.close();
    await vite?.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    vite = await createVite({ server: { middlewareMode: true, hmr: { server } } });
    server.on("request", vite.middlewares);
    // A stable WebView origin preserves localStorage and IndexedDB across restarts.
    // Refuse to launch if the address belongs to another process.
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    await publishLocalEndpoint(server, directory);
    const config = join(directory, "tauri-dev.json");
    const origin = `http://127.0.0.1:${server.address().port}`;
    await writeFile(config, JSON.stringify({ build: { devUrl: origin, beforeDevCommand: "" } }));
    return { directory, config, origin, close };
  } catch (err) {
    await close();
    throw err;
  }
}
