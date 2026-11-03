import test from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { publishLocalEndpoint } from "./local-preview.mjs";

test("native proxy requests reach only the private preview even if another listener owns the TCP destination", async () => {
  const directory = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "koi-ipc-"));
  let foreignRequests = 0;
  const foreign = createServer((_, res) => { foreignRequests++; res.end("wrong app"); });
  const trusted = createServer((req, res) => {
    assert.equal(req.url, "/api/agent/sessions");
    assert.equal(req.headers.authorization, "Bearer test-session");
    res.end("Koinote");
  });
  try {
    foreign.listen(0, "127.0.0.1");
    await once(foreign, "listening");
    await publishLocalEndpoint(trusted, directory);
    const endpoint = JSON.parse(await readFile(join(directory, "preview.json"), "utf8"));
    const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\koinote-local-${endpoint.id}` : join(directory, `api-${endpoint.id}.sock`);
    const request = path => new Promise((resolve, reject) => {
      get({ socketPath, path, headers: { authorization: "Bearer test-session" } }, async res => {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve([res.statusCode, Buffer.concat(chunks).toString()]);
      }).on("error", reject);
    });
    assert.deepEqual(await request("http://localhost:5273/api/agent/sessions"), [200, "Koinote"]);
    assert.deepEqual(await request(`http://127.0.0.1:${foreign.address().port}/api/agent/sessions`), [400, ""]);
    assert.equal(foreignRequests, 0);
  } finally {
    foreign.close();
    trusted.emit("close");
    await rm(directory, { recursive: true, force: true });
  }
});
