import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const built=await build({entryPoints:["worker/index.ts"],bundle:true,write:false,platform:"neutral",format:"esm",loader:{".md":"text"},logLevel:"error"});
const {default:worker}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`);
const png=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
function env() {return {BACKEND_URL:"https://backend.example",BACKEND_INTERNAL_TOKEN:"fixture-internal",IMAGES:{head:async()=>null,put:async()=>{},delete:async()=>{}},ASSETS:{fetch:async()=>new Response("")}};}
function request(path="/api/images",extra={}) {return new Request("https://app.example"+path,{method:"POST",headers:{cookie:"fixture-session","content-type":"image/png","cf-connecting-ip":"192.0.2.10",...extra},body:png});}
function mock(t,handler) {const previous=globalThis.fetch;globalThis.fetch=handler;t.after(()=>{globalThis.fetch=previous;});}

test("source admission rejects upload and fetch before any upstream work",async t=>{
  mock(t,async()=>{throw Error("denied source reached origin");});
  const environment=env();environment.IMAGE_WRITE_LIMITER={limit:async({key})=>{assert.equal(key,"koinote:image-write:192.0.2.10");return {success:false};}};
  environment.IMAGES.put=async()=>{throw Error("denied source wrote R2");};
  for(const path of ["/api/images","/api/images/fetch"]) {
    const result=await worker.fetch(request(path),environment);
    assert.equal(result.status,429);assert.equal(result.headers.get("retry-after"),"60");assert.equal((await result.json()).code,"image_rate_limited");
  }
  environment.IMAGE_WRITE_LIMITER.limit=async()=>{throw Error("binding down");};
  assert.equal((await worker.fetch(request(),environment)).status,503);
});

test("account/global admission refuses both image paths before R2 or external requests",async t=>{
  const environment=env();let puts=0,admissions=0;
  environment.IMAGES.put=async()=>{puts++;};
  mock(t,async(input,init)=>{
    const url=new URL(input.url??input);assert.equal(url.origin,"https://backend.example");
    if(url.pathname==="/api/auth/session")return Response.json({user:{authUserId:"canonical-user"}});
    assert.equal(url.pathname,"/api/images/admit");admissions++;
    assert.equal(new Headers(init.headers).get("x-auth-user-id"),"canonical-user");assert.equal(init.redirect,"manual");
    return Response.json({code:"image_rate_limited"},{status:429,headers:{"Retry-After":"3600"}});
  });
  for(const path of ["/api/images","/api/images/fetch"]) {
    const response=await worker.fetch(request(path),environment);assert.equal(response.status,429);assert.equal(response.headers.get("retry-after"),"3600");
  }
  assert.equal(admissions,2);assert.equal(puts,0);
});

test("missing or unavailable admission never falls back to unmetered writes",async t=>{
  const environment=env();let admissions=0;
  environment.IMAGES.put=async()=>{throw Error("unavailable admission wrote R2");};
  mock(t,async input=>{
    const path=new URL(input.url??input).pathname;
    if(path==="/api/auth/session")return Response.json({user:{authUserId:"user"}});
    assert.equal(path,"/api/images/admit");admissions++;return new Response(null,{status:503});
  });
  assert.equal((await worker.fetch(request(),environment)).status,503);
  delete environment.BACKEND_INTERNAL_TOKEN;
  assert.equal((await worker.fetch(request(),environment)).status,503);assert.equal(admissions,1);
});

test("oversized chunked uploads are capped before put",async t=>{
  const environment=env();let cancelled=false;
  environment.IMAGES.put=async()=>{throw Error("oversized image reached R2");};
  mock(t,async input=>new URL(input.url??input).pathname==="/api/auth/session"?Response.json({user:{authUserId:"user"}}):new Response(null,{status:204}));
  let chunks=0;
  const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(6*1024*1024));if(++chunks===3)controller.close();},cancel(){cancelled=true;}});
  const upload=new Request("https://app.example/api/images",{method:"POST",headers:{cookie:"session","content-type":"image/png"},body,duplex:"half"});
  assert.equal((await worker.fetch(upload,environment)).status,413);assert.equal(cancelled,true);
});

test("quota refusal never writes an object or needs physical deletion",async t=>{
  const environment=env(),phases=[];let puts=0,deletes=0;
  environment.IMAGES.put=async()=>{puts++;};environment.IMAGES.delete=async()=>{deletes++;throw Error("injected deletion failure");};
  const previous=console.error;console.error=()=>{};t.after(()=>{console.error=previous;});
  mock(t,async(input,init)=>{
    const path=new URL(input.url??input).pathname;
    if(path==="/api/auth/session")return Response.json({user:{authUserId:"user"}});
    if(path==="/api/images/admit")return new Response(null,{status:204});
    if(path==="/api/images/record")return Response.json({code:"image_quota_exceeded"},{status:409});
    assert.equal(path,"/api/images/rollback");phases.push(JSON.parse(init.body));return Response.json({rollbackAllowed:true});
  });
  const response=await worker.fetch(request("/api/images",{"X-Koinote-Import-Owner":"user"}),environment);
  assert.equal(response.status,413);assert.equal(puts,0);assert.equal(deletes,0);assert.deepEqual(phases,[]);
});

test("quota refusal preserves pre-existing temporary hash objects",async t=>{
  const environment=env();environment.IMAGES.head=async()=>({size:png.byteLength});
  environment.IMAGES.put=async()=>{throw Error("reusable image was rewritten");};environment.IMAGES.delete=async()=>{throw Error("existing image was deleted");};
  mock(t,async input=>{
    const path=new URL(input.url??input).pathname;
    if(path==="/api/auth/session")return Response.json({user:{authUserId:"user"}});
    if(path==="/api/images/admit")return new Response(null,{status:204});
    assert.equal(path,"/api/images/record");return Response.json({code:"temporary_image_quota_exceeded"},{status:409});
  });
  assert.equal((await worker.fetch(request("/api/images",{"x-koinote-image-purpose":"wechat-export"}),environment)).status,413);
});
