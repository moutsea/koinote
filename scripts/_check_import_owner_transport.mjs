import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
const h = globalThis.__ownerTransport = { desktop: false, calls: [] };
const mocks = {
  "./desktop/runtime": "export const isDesktopRuntime=()=>globalThis.__ownerTransport.desktop;",
  "./desktop/offlineStore": `const reject=(owner)=>{globalThis.__ownerTransport.calls.push(owner);throw Error('import_account_changed')};
    export const desktopCreateDocument=async(p,owner)=>reject(owner);export const desktopCreateFolder=async(p,owner)=>reject(owner);
    export const desktopStoreLocalImage=async(file,owner)=>reject(owner);export const desktopReleaseUnusedImages=async(keys,owner)=>reject(owner);`,
};
const result = await build({ entryPoints: ["spa/src/api.ts"], bundle: true, write: false, format: "esm", platform: "node", plugins: [{name:"owner-transport",setup(b){
  b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:"test"}:a.kind==="dynamic-import"?{path:a.path,external:true}:undefined);
  b.onLoad({filter:/.*/,namespace:"test"},a=>({contents:mocks[a.path]}));
}}] });
const directory=mkdtempSync(`${process.cwd()}/scripts/.import-owner-`);
const bundle=directory+"/api.mjs";writeFileSync(bundle,result.outputFiles[0].text);
const api=await import(pathToFileURL(bundle).href);
const previousFetch = globalThis.fetch;
const paths = [];
const file = new File(["png"],"a.png",{type:"image/png"});
try {
  globalThis.fetch = async (path,init) => {
    assert.equal(new Headers(init.headers).get("X-Koinote-Import-Owner"),"account-1");
    paths.push(path);
    return Response.json(path==="/api/images"?{image:{key:"key",url:"url"}}:{});
  };
  await api.createDocument({title:"A"},"account-1");
  await api.createFolder({name:"A",parentFolderId:null},"account-1");
  await api.uploadImage(file,"persistent","account-1");
  await api.releaseUnusedImages(["u/account-1/0123456789abcdef.png"],"account-1");
  await api.retainImportImages(["u/account-1/0123456789abcdef.png"],"account-1");
  assert.deepEqual(paths,["/api/documents","/api/folders","/api/images","/api/storage/release-images","/api/storage/retain-import-images"]);
  globalThis.fetch = async (_,init) => {assert.equal(new Headers(init.headers).has("X-Koinote-Import-Owner"),false);return Response.json({})};
  await api.createDocument({title:"Legacy caller"});
  h.desktop=true;
  for (const action of [
    ()=>api.createDocument({title:"A"},"account-1"),()=>api.createFolder({name:"A",parentFolderId:null},"account-1"),
    ()=>api.uploadImage(file,"persistent","account-1"),()=>api.releaseUnusedImages(["koinote-local-image://550e8400-e29b-41d4-a716-446655440099"],"account-1"),
  ]) await assert.rejects(action(),error=>error instanceof api.ApiError&&error.status===409&&error.code==="import_account_changed");
  assert.deepEqual(h.calls,["account-1","account-1","account-1","account-1"]);
  console.log("import transport: pinned identity reaches all four web/desktop mutations, legacy callers remain compatible");
} finally { globalThis.fetch=previousFetch;delete globalThis.__ownerTransport;rmSync(directory,{recursive:true,force:true}); }
