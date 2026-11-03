// Run by the Go host regression with disposable credentials and TLS listeners.
import assert from "node:assert/strict";
import { request } from "node:https";
import { Readable } from "node:stream";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import worker from "../../deploy/local-koi/callback.mjs";

let data = "";
for await (const chunk of process.stdin) data += chunk;
const f = JSON.parse(data);
const bundle = join(f.temp,"notification.cjs");
await build({entryPoints:[join(f.upstream,"src/runtime/notification-sinks.ts")],outfile:bundle,bundle:true,platform:"node",format:"cjs",logLevel:"silent"});
const {deliverNotification} = createRequire(import.meta.url)(bundle);
let destination = new URL(f.good);
const binding = {fetch(url, init) {
  const origin = new URL(url);
  assert.equal(origin.origin,"https://koi-local.koinote.app");
  return new Promise((resolve,reject)=>{
    const req=request(destination.origin+origin.pathname,{
      method:init.method,headers:Object.fromEntries(init.headers),ca:f.ca,
      servername:origin.hostname,rejectUnauthorized:true,signal:init.signal,
    },async res=>{
      const chunks=[];for await (const chunk of res) chunks.push(chunk);
      resolve(new Response(res.statusCode===204 ? null : Buffer.concat(chunks),{status:res.statusCode,headers:res.headers}));
    });
    req.on("error",reject);
    if(init.body) Readable.fromWeb(init.body).pipe(req);else req.end();
  });
}};
globalThis.fetch=(url,init)=>worker.fetch(new Request(url,init),{LOCAL_KOI:binding});
const base="https://koi-local.koinote.app/api/writing-agent/";
const target={kind:"callback",jobId:f.job,url:base+"callback/"+f.id,secret:f.callback};
const event={id:"wire-delivery",type:"job.completed",jobId:f.job,workspaceId:f.workspace,body:"联动回归"};
for(let i=0;i<2;i++) assert.equal((await deliverNotification({},target,event,{})).status,"sent");
const mcp=()=>fetch(base+"mcp/"+f.id,{method:"POST",headers:{Authorization:"Bearer "+f.mcp,"Content-Type":"application/json",Accept:"application/json, text/event-stream"},
  body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"isolated-agent",version:"1"}}})});
const hello=await mcp();
assert.equal(hello.status,200);assert.ok((await hello.text()).includes("serverInfo"));
destination=new URL(f.foreign);
assert.equal((await mcp()).status,503);
assert.equal((await deliverNotification({},target,event,{})).status,"retry");
