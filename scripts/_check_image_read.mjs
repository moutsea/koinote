import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'neutral',loader:{'.md':'text'},logLevel:'silent'});
const {default:worker}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const helper=await build({entryPoints:['worker/rateLimitAddress.ts'],bundle:true,write:false,format:'esm',platform:'neutral',logLevel:'silent'});
const {rateLimitAddress}=await import(`data:text/javascript;base64,${Buffer.from(helper.outputFiles[0].text).toString('base64')}`);
const key='u/test-user/'+'a'.repeat(32)+'.png';
function fixture(t,ip='192.0.2.50'){
 const counts={r2:0,origin:0,edge:0};const keys=[];const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
 // Reads are edge-only: any origin call means an origin outage can break public images.
 globalThis.fetch=async()=>{counts.origin++;return new Response(null,{status:204});};
 const env={BACKEND_URL:'https://origin.invalid',BACKEND_INTERNAL_TOKEN:'fixture-internal',IMAGE_PUBLIC_BASE:'https://cdn.invalid',IMAGE_READ_LIMITER:{limit:async({key})=>{counts.edge++;keys.push(key);return {success:true}}},IMAGES:{get:async()=>{counts.r2++;return {body:new Uint8Array([137,80,78,71]),httpEtag:'"fixture"',writeHttpMetadata:h=>h.set('content-type','image/png')}} ,head:async()=>{counts.r2++;return {size:4,httpEtag:'"fixture"',writeHttpMetadata:h=>h.set('content-type','image/png')}}}};
 const call=(path='/images/'+key,method='GET')=>worker.fetch(new Request('https://app.invalid'+path,{method,headers:{'cf-connecting-ip':ip,'x-forwarded-for':'forged'}}),env);
 return {env,counts,keys,call};
}
test('invalid image keys never spend admission or R2 operations',async t=>{
 const f=fixture(t);for(const path of ['/images/arbitrary','/images/%E0%A4%A','/images/u/nope/x.png'])assert.equal((await f.call(path)).status,404);
 assert.deepEqual(f.counts,{r2:0,origin:0,edge:0});
});
test('read admission fails closed before R2 when edge denies, errors or config is absent',async t=>{
 const f=fixture(t);f.env.IMAGE_READ_LIMITER.limit=async()=>({success:false});
 for(const method of ['GET','HEAD']){const r=await f.call(undefined,method);assert.equal(r.status,429);assert.equal(r.headers.get('Retry-After'),'60');assert.equal(r.headers.get('Cache-Control'),'private, no-store');}
 f.env.IMAGE_READ_LIMITER.limit=async()=>{throw Error('limiter outage')};assert.equal((await f.call()).status,503);
 delete f.env.IMAGE_READ_LIMITER;assert.equal((await f.call()).status,503);assert.equal(f.counts.r2,0);
});
test('reads stay available without the origin, including a missing internal token',async t=>{
 const f=fixture(t);globalThis.fetch=async()=>{f.counts.origin++;throw Error('origin outage')};delete f.env.BACKEND_INTERNAL_TOKEN;
 assert.equal((await f.call()).status,200);assert.equal((await f.call(undefined,'HEAD')).status,200);assert.deepEqual(f.counts,{r2:2,origin:0,edge:2});
});
test('one IPv6 /64 shares a single edge bucket',async t=>{
 const f=fixture(t,'2001:db8:1:2:aaaa::1');await f.call();
 const g=fixture(t,'2001:0db8:0001:0002:ffff:ffff:ffff:ffff');await g.call();
 assert.equal(f.keys[0],'koinote:image-read:2001:db8:1:2::/64');assert.equal(g.keys[0],f.keys[0]);
});
test('rate-limit addresses collapse IPv6 to /64 and keep IPv4 intact',()=>{
 for(const [input,want] of [['192.0.2.9','192.0.2.9'],['::ffff:198.51.100.7','198.51.100.7'],['2001:db8::1','2001:db8:0:0::/64'],['2001:db8:1:2:3:4:5:6','2001:db8:1:2::/64'],['::1','0:0:0:0::/64'],['64:ff9b::192.0.2.1','64:ff9b:0:0::/64'],[null,'unknown'],['','unknown'],['not:an:ip:::x','not:an:ip:::x']])
  assert.equal(rateLimitAddress(input),want,String(input));
});
