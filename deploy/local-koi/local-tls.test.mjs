import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as httpsServer, get as httpsGet } from "node:https";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { readFile, mkdtemp, rm, copyFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createServer as createVite, resolveConfig } from "vite";
import { fileURLToPath } from "node:url";
import { localServiceProxy } from "./local-tls.mjs";
import { startImageRelay } from "./image-relay.mjs";
import { publishLocalEndpoint } from "./local-preview.mjs";

// Use Vite's actual proxy middleware, HTTP over the private desktop socket,
// and real TLS servers in place of the managed Go and Worker listeners.
test("Local rejects an occupied downstream port before sending authorization, internal headers or uploaded bytes",async () => {
  const root=await mkdtemp(join("/tmp","koi-tls-"));
  const servers=[], agents=[];
  let vite, front;
  try {
    execFileSync("python3",[fileURLToPath(new URL("./local-certs.py",import.meta.url)),root]);
    const previous = { tls:process.env.KOI_LOCAL_TLS_DIR, flavor:process.env.VITE_DESKTOP_FLAVOR };
    try {
      process.env.KOI_LOCAL_TLS_DIR=root;process.env.VITE_DESKTOP_FLAVOR="local";
      for (const flavor of ["local", ""]) {
      process.env.VITE_DESKTOP_FLAVOR=flavor;
      const config=await resolveConfig({configFile:fileURLToPath(new URL("../../vite.config.ts",import.meta.url)),logLevel:"silent"},"serve");
      for(const proxy of [config.server.proxy,config.preview.proxy]) {
        for(const [route,target] of [["/api","https://127.0.0.1:18090"],["/api/images","https://127.0.0.1:8788"]]) {
          assert.equal(proxy[route].target,target);assert.equal(proxy[route].agent.options.rejectUnauthorized,true);
          agents.push(proxy[route].agent);
        }
      }
      }
      // The actual dev runner can open its UI on a fresh checkout. Missing
      // certificates disable authenticated network requests, not the window.
      process.env.KOI_LOCAL_TLS_DIR=join(root,"not-provisioned");
      process.env.VITE_DESKTOP_FLAVOR="local";
      const fresh=await resolveConfig({configFile:fileURLToPath(new URL("../../vite.config.ts",import.meta.url)),logLevel:"silent"},"serve");
      const offline=fresh.server.proxy["/api"].agent;
      await assert.rejects(new Promise((resolve,reject)=>offline.createConnection({},e=>e?reject(e):resolve())),/local:services/);
      for(const route of ["/api","/api/images"]) fresh.server.proxy[route].agent.destroy();
    } finally {
      if(previous.tls===undefined)delete process.env.KOI_LOCAL_TLS_DIR;else process.env.KOI_LOCAL_TLS_DIR=previous.tls;
      if(previous.flavor===undefined)delete process.env.VITE_DESKTOP_FLAVOR;else process.env.VITE_DESKTOP_FLAVOR=previous.flavor;
    }
    const options=async service=>({ key:await readFile(join(root,service+".key")),cert:await readFile(join(root,service+".crt")) });
    const requests=[];
    async function listen(server) { servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");return server.address().port; }
    const handler=async(req,res)=>{
      const chunks=[];for await (const chunk of req) chunks.push(chunk);
      requests.push({ bearer:req.headers.authorization,internal:req.headers["x-koinote-internal-token"],body:Buffer.concat(chunks).toString() });res.end("trusted");
    };
    const backend=await listen(httpsServer(await options("backend"),handler));
    const images=await listen(httpsServer(await options("images"),handler));
    let foreign=0;
    const wrong=await listen(httpsServer(await options("images"),(_,res)=>{foreign++;res.end("foreign")}));
    const plain=await listen(createServer((_,res)=>{foreign++;res.end("foreign")}));
    const proxy=(service,port)=>{
      const options=localServiceProxy(service,root);agents.push(options.agent);
      return {...options,target:"https://127.0.0.1:"+port,
        ...(service==="backend" && {headers:{"x-koinote-internal-token":"fixture-internal"}})};
    };
    vite=await createVite({root,configFile:false,logLevel:"silent",server:{middlewareMode:true,hmr:false,proxy:{
      "/api/agent":proxy("backend",backend),"/api/images":proxy("images",images),
      "/spoof-go":proxy("backend",wrong),"/spoof-images":proxy("images",plain),
    }}});
    front=createServer(vite.middlewares);await publishLocalEndpoint(front,root);
    const {id}=JSON.parse(await readFile(join(root,"preview.json"),"utf8"));
    const post=(path,host="localhost:5273")=>new Promise((resolve,reject)=>{
      const req=request({socketPath:join(root,"api-"+id+".sock"),method:"POST",path:"http://localhost:5273"+path,headers:{Host:host,Authorization:"Bearer upload-fixture"}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode))});
      req.on("error",reject);req.end("fixture-body");
    });
    assert.equal(await post("/api/agent"),200);assert.equal(await post("/api/images"),200);
    assert.deepEqual(requests,[{bearer:"Bearer upload-fixture",internal:"fixture-internal",body:"fixture-body"},{bearer:"Bearer upload-fixture",internal:undefined,body:"fixture-body"}]);
    assert.equal(await post("/api/agent","demo.localhost:5273"),200);
    assert.equal(await post("/api/images","demo.localhost:5273"),200);
    assert.ok(await post("/spoof-go","demo.localhost:5273")>=500);
    assert.ok(await post("/spoof-go")>=500);assert.ok(await post("/spoof-images")>=500);
    assert.equal(foreign,0);
    const missing=localServiceProxy("backend",join(root,"missing")).agent;
    await assert.rejects(new Promise((resolve,reject)=>missing.createConnection({},e=>e?reject(e):resolve())),/local:services/);
    missing.destroy();
  } finally {
    front?.emit("close");agents.forEach(agent=>agent.destroy());await vite?.close();
    for(const server of servers){server.closeAllConnections();server.close();}
    await rm(root,{force:true,recursive:true});
  }
});

test("local workerd authenticates the Go certificate before forwarding a session header", async () => {
  const root = await mkdtemp(join("/tmp","koi-workerd-"));
  let mf, server;
  const previousCA = process.env.NODE_EXTRA_CA_CERTS;
  try {
    execFileSync("python3",[fileURLToPath(new URL("./local-certs.py",import.meta.url)),root]);
    process.env.NODE_EXTRA_CA_CERTS = join(root,"backend.ca.crt");
    const { Miniflare } = await import("miniflare");
    let calls = 0;
    async function serve(service, port = 0) {
      const options = {key:await readFile(join(root,service+".key")),cert:await readFile(join(root,service+".crt"))};
      server = httpsServer(options, (req,res) => {calls++;res.end(req.headers.authorization || "missing");});
      server.listen(port,"127.0.0.1");await once(server,"listening");return server.address().port;
    }
    const port = await serve("backend");
    mf = new Miniflare({modules:true,compatibilityDate:"2025-06-01",
      script: `export default {
        async fetch(request, env) {
          try { return await fetch(env.BACKEND_URL, { headers: { Authorization: request.headers.get("Authorization") } }); }
          catch { return new Response("untrusted", {status:502}); }
        }
      };`,
      bindings:{BACKEND_URL:"https://127.0.0.1:"+port}});
    const request = () => mf.dispatchFetch("https://fixture.invalid/", {headers:{Authorization:"Bearer fixture"}});
    assert.equal(await (await request()).text(),"Bearer fixture");
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await serve("images",port);
    const blocked=await request();
    assert.equal(blocked.status,502);await blocked.text();assert.equal(calls,1);
  } finally {
    if(previousCA === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS=previousCA;
    await mf?.dispose();server?.closeAllConnections();server?.close();await rm(root,{recursive:true,force:true});
  }
});

test("reinstall repairs interrupted CA or key rotation while retaining healthy identities", async()=>{
  const root=await mkdtemp(join("/tmp","koi-rotate-"));
  const provision=()=>execFileSync("python3",[fileURLToPath(new URL("./local-certs.py",import.meta.url)),root]);
  try {
    provision();
    const images=await readFile(join(root,"images.crt"));
    for(const ext of [".ca.crt",".key"]) {
      const before=await readFile(join(root,"backend.crt"));
      await copyFile(join(root,"images"+ext),join(root,"incomplete"));
      await rename(join(root,"incomplete"),join(root,"backend"+ext));
      provision();
      const repaired=await readFile(join(root,"backend.crt"));
      assert.notDeepEqual(repaired,before);
      execFileSync("openssl",["verify","-CAfile",join(root,"backend.ca.crt"),join(root,"backend.crt")]);
      provision();
      assert.deepEqual(await readFile(join(root,"backend.crt")),repaired);
      assert.deepEqual(await readFile(join(root,"images.crt")),images);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});


test("Linux bridge relay carries authenticated TLS to the loopback image Worker", async () => {
  const root=await mkdtemp(join("/tmp","koi-relay-"));
  let origin,relay;
  try {
    execFileSync("python3",[fileURLToPath(new URL("./local-certs.py",import.meta.url)),root]);
    let reads=0;
    origin=httpsServer({key:await readFile(join(root,"images.key")),cert:await readFile(join(root,"images.crt"))},(req,res)=>{
      reads++;
      res.end(req.headers.authorization);
    });
    origin.listen(0,"127.0.0.1");await once(origin,"listening");
    relay=await startImageRelay("127.0.0.1",0,origin.address().port);
    const get=async service=>{
      const ca=await readFile(join(root,service+".ca.crt"));
      return new Promise((resolve,reject)=>{
        const req=httpsGet({host:"127.0.0.1",port:relay.address().port,servername:"host.docker.internal",ca,
          headers:{Authorization:"Bearer image-fixture"}},res=>{
            const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve(Buffer.concat(chunks).toString()));
          });
        req.on("error",reject);
      });
    };
    assert.equal(await get("images"),"Bearer image-fixture");
    await assert.rejects(get("backend"));
    assert.equal(reads,1);
  } finally {
    relay?.close();origin?.closeAllConnections();origin?.close();await rm(root,{recursive:true,force:true});
  }
});
