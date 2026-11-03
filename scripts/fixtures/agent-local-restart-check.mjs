import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { build } from "esbuild";
import { startLocalDesktopDev } from "../local_desktop_dev.mjs";

export async function checkLocalDevRestart(createClient, temp) {
  const fixture = join(temp, "dev-restart");
  const publicDir = join(fixture, "public");
  await mkdir(publicDir, { recursive: true });
  await build({ stdin: { contents: 'export {readAgentPanelLayout,saveAgentPanelLayout} from "./agentSessions"; export {AgentRequestCache} from "./agentRequestCache";',
    resolveDir: resolve("spa/src") }, bundle: true, format: "iife", globalName: "panel", platform: "browser",
    define: { "import.meta.env": "{}" }, outfile: join(publicDir, "panel.js") });
  await writeFile(join(publicDir,"fixture.html"), '<script src="/panel.js"></script>');
  await writeFile(join(fixture,"vite.config.mjs"), 'export default { logLevel:"silent", optimizeDeps:{noDiscovery:true} };');
  const reserve = createServer();
  reserve.listen(0,"127.0.0.1");
  await once(reserve,"listening");
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const start = async () => {
    const previous = process.cwd();
    try { process.chdir(fixture); return await startLocalDesktopDev({port}); }
    finally { process.chdir(previous); }
  };
  let dev, client;
  try {
    dev = await start();
    const origin = dev.origin;
    await assert.rejects(start(), {code:"EADDRINUSE"});
    client = await createClient();
    await client.send("Page.navigate",{url:origin+"/fixture.html"});
    await client.wait('typeof panel !== "undefined"');
    const requestIds = await client.evaluate(`(async()=>{
      const layout = panel.readAgentPanelLayout("test");
      await panel.saveAgentPanelLayout("test",{...layout,tabs:["s"],active:"s",drafts:{s:"未发送的草稿"},draftIds:{s:"draft-id"}},layout);
      const cache = new panel.AgentRequestCache("test");
      const request = await cache.prepare("s",{message:"整理",skillRepositoryId:0,skillPath:""},"draft-id");
      const archived = await cache.prepare("s", {message:"归档",skillRepositoryId:0,skillPath:""}, "archived-draft");
      await cache.complete(archived);
      return [request.input.requestId, archived.input.requestId];
    })()`);
    await client.close();client=undefined;
    await dev.close();dev=undefined;
    dev = await start();
    assert.equal(dev.origin, origin);
    client = await createClient();
    await client.send("Page.navigate",{url:dev.origin+"/fixture.html"});
    await client.wait('typeof panel !== "undefined"');
    assert.equal(await client.evaluate('panel.readAgentPanelLayout("test").drafts.s'),"未发送的草稿");
    const recovered = await client.evaluate(`(async () => {
      const cache = new panel.AgentRequestCache("test");
      const pending = await cache.prepare("s", {message:"整理",skillRepositoryId:0,skillPath:""}, "draft-id");
      const archived = await cache.prepare("s", {message:"归档",skillRepositoryId:0,skillPath:""}, "archived-draft");
      return [pending.input.requestId, archived.input.requestId];
    })()`);
    assert.deepEqual(recovered, requestIds);
    console.log("Local desktop restart preserved the draft, pending request and IndexedDB replay identity.");
  } finally {await client?.close();await dev?.close();}
}
