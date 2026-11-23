import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const sqlite = new DatabaseSync(":memory:");
for (const name of readdirSync("src-tauri/migrations").filter(name => name.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`src-tauri/migrations/${name}`, "utf8"));
}
const bind = values => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]));
const harness = {
  database: {
    select: async (sql, values = []) => sqlite.prepare(sql).all(bind(values)),
    execute: async (sql, values = []) => ({ rowsAffected: Number(sqlite.prepare(sql).run(bind(values)).changes) }),
  },
};
globalThis.__syncLimits = harness;
const adapters = {
  "@tauri-apps/plugin-sql": "export default {load:async()=>globalThis.__syncLimits.database}",
  "@tauri-apps/api/core": "export const invoke=async()=>{}",
  "./auth": 'export const getStoredDesktopSession=async()=>({accountId:globalThis.__syncLimits.accountId??"account-1"})',
  "./network": "export const desktopFetch=(...args)=>globalThis.__syncLimits.fetch(...args)",
  "./logoutGuard": "export const prepareDesktopSync=async()=>true",
  "./localMode": 'export const DESKTOP_LOCAL_ACCOUNT_ID="local:v1";export const isDesktopLocalModeSelected=()=>false;export const isDesktopLocalModeUnlocked=()=>false;export const verifyDesktopLocalModePassword=async()=>{};export const encryptDesktopLocalValue=async x=>x;export const decryptDesktopLocalValue=async x=>x;',
};
const compiled = await build({
  stdin: { contents: readFileSync("spa/src/desktop/offlineStore.ts", "utf8") + "\nexport {performSync,pushDocuments,insertRemoteDocument};", resolveDir: `${process.cwd()}/spa/src/desktop`, loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{ name: "sync-limit-adapters", setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(adapters, args.path) ? { path: args.path, namespace: "sync-test" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "sync-test" }, args => ({ contents: adapters[args.path] }));
  } }],
});
const store = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const oldWindow = globalThis.window, oldTimer = globalThis.setTimeout, oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
globalThis.window = new EventTarget();
globalThis.setTimeout = () => 1;
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
const row = id => sqlite.prepare("SELECT * FROM offline_documents WHERE doc_id=?").get(id);
const cloudDoc = (id, content = "Cloud content") => ({ docId: id, title: id, content, theme: "minimal", revision: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", coverImageSource: "", coverPrompt: "" });
try {
  for (const [status, code] of [[409, "document_count_limit_reached"], [429, "too_many_requests"], [409, "storage_quota_exceeded"]]) {
    for (const table of ["offline_documents", "offline_meta", "offline_folders", "offline_images"]) sqlite.exec(`DELETE FROM ${table}`);
    sqlite.prepare("INSERT INTO offline_meta(account_id,key,value) VALUES('account-1','last-synced-at','previous-success')").run();
    const existing = cloudDoc("existing");
    await store.insertRemoteDocument("account-1", existing, null, 0);
    await store.desktopUpdateDocument(existing.docId, { ...existing, content: "Local edit", expectedRevision: 1 });
    const first = (await store.desktopCreateDocument({ title: "First pending", content: "Keep first" })).document;
    const second = (await store.desktopCreateDocument({ title: "Second pending", content: "Keep second" })).document;
    const documents = new Map([[existing.docId, existing], ["cloud-arrival", cloudDoc("cloud-arrival")]]);
    const requests = [];
    let blocked = true;
    harness.fetch = async (path, init = {}) => {
      requests.push([init.method ?? "GET", path]);
      if (path === "/api/documents" && init.method === "POST") {
        if (blocked) return Response.json({ code }, { status });
        const params = JSON.parse(init.body);
        const document = { ...cloudDoc(params.docId), ...params };
        documents.set(document.docId, document);
        return Response.json({ document });
      }
      if (path === "/api/documents" && !init.method) return Response.json({ documents: [...documents.values()].map(document => ({ ...document, folderId: null, sortOrder: 0 })) });
      if (path === "/api/folders") return Response.json({ folders: [] });
      if (path.startsWith("/api/documents/")) {
        const id = path.split("/")[3];
        if (init.method === "PUT") {
          const params = JSON.parse(init.body);
          documents.set(id, { ...documents.get(id), ...params, revision: 2 });
        }
        return Response.json({ document: documents.get(id) });
      }
      throw new Error(`Unexpected ${init.method ?? "GET"} ${path}`);
    };
    const summary = await store.performSync("account-1", {});
    assert.equal(summary.state, "error");
    assert.equal(summary.partial, true);
    assert.equal(summary.message, code);
    assert.equal(summary.pending, 2);
    assert.equal(summary.lastSyncedAt, "previous-success", "partial sync must not be recorded as fully successful");
    assert.equal(requests.filter(([method]) => method === "POST").length, 1, "do not repeat a rejected creation for every queued draft");
    assert.ok(requests.some(([method, path]) => method === "PUT" && path.endsWith("/existing")));
    assert.equal(row("existing").sync_state, "clean");
    assert.equal(row("existing").content, "Local edit");
    assert.equal(row("cloud-arrival").content, "Cloud content", "cloud pull still runs after a rejected create");
    for (const id of [first.docId, second.docId]) {
      assert.equal(row(id).sync_state, "create");
      assert.equal(row(id).last_error, code);
    }
    assert.equal(row(first.docId).content, "Keep first");
    blocked = false;
    const recovered = await store.performSync("account-1", {});
    assert.equal(recovered.state, "idle");
    assert.equal(recovered.pending, 0);
    assert.equal(recovered.partial, undefined);
    assert.notEqual(recovered.lastSyncedAt, "previous-success");
    assert.equal(documents.size, 4, "retry must reuse the two original draft UUIDs");
  }
  for (const [status, code, placement, concurrentEdit] of [
    [409, "storage_quota_exceeded", "body", false],
    [409, "document_count_limit_reached", "cover", false],
    [429, "too_many_requests", "body", false],
    [409, "storage_quota_exceeded", "body", true],
  ]) {
    for (const table of ["offline_documents", "offline_meta", "offline_images"]) sqlite.exec(`DELETE FROM ${table}`);
    const imageId = crypto.randomUUID();
    const localURL = `koinote-local-image://${imageId}`;
    const remoteURL = `https://images.invalid/u/user_1/${imageId.replaceAll("-", "")}.png`;
    let imageDraft = (await store.desktopCreateDocument({ title: "Image draft", content: placement === "body" ? `![image](${localURL})` : "Cover only" })).document;
    if (placement === "cover") imageDraft = (await store.desktopUpdateDocument(imageDraft.docId, { ...imageDraft, coverMode: "ai", coverImageSource: localURL, expectedRevision: imageDraft.revision })).document;
    sqlite.prepare(`INSERT INTO offline_images(account_id,image_id,content_type,base64_data,byte_size,created_at,is_local_origin)
      VALUES('account-1',?,'image/png','aW1hZ2U=',5,?,1)`).run(imageId, new Date().toISOString());
    const before = row(imageDraft.docId);
    let blocked = true, uploads = 0;
    harness.fetch = async (path, init = {}) => {
      if (path === "/api/images") {
        uploads++;
        return Response.json({ image: { key: `u/user_1/${imageId.replaceAll("-", "")}.png`, url: remoteURL } });
      }
      if (path === "/api/documents" && init.method === "POST") {
        if (blocked) {
          if (concurrentEdit) await store.desktopUpdateDocument(imageDraft.docId, { ...imageDraft, content: "Typed during the POST", expectedRevision: imageDraft.revision });
          return Response.json({ code }, { status });
        }
        return Response.json({ document: { ...cloudDoc(imageDraft.docId), ...JSON.parse(init.body) } });
      }
      throw new Error(`Unexpected ${path}`);
    };
    assert.deepEqual(await store.pushDocuments("account-1"), [code]);
    const after = row(imageDraft.docId);
    assert.ok(after.change_seq > before.change_seq, "the real image mapping changes the sequence");
    assert.equal(after.sync_state, "create");
    if (concurrentEdit) {
      assert.equal(after.last_error, null, "a newer real user edit must not inherit an old refusal");
      assert.equal(after.content, "Typed during the POST");
      continue;
    }
    assert.equal(after.local_revision, before.local_revision, "image mapping preserves the logical content revision");
    assert.equal(after.last_error, code);
    const reopened = await store.desktopSyncSummary();
    assert.equal(reopened.state, "error");
    assert.equal(reopened.message, code);
    assert.equal(reopened.partial, true);
    assert.equal(reopened.pending, 1);
    blocked = false;
    assert.deepEqual(await store.pushDocuments("account-1"), []);
    assert.equal(uploads, 1, "retry reuses the already uploaded image");
    assert.equal((await store.desktopSyncSummary()).pending, 0);
    assert.equal(row(imageDraft.docId).last_error, null);
  }
  for (const table of ["offline_documents", "offline_meta", "offline_images"]) sqlite.exec(`DELETE FROM ${table}`);
  const draft = (await store.desktopCreateDocument({ title: "Concurrent edit", content: "Before request" })).document;
  harness.fetch = async () => {
    await store.desktopUpdateDocument(draft.docId, { ...draft, content: "Typed during request", expectedRevision: 1 });
    return Response.json({ code: "document_count_limit_reached" }, { status: 409 });
  };
  await store.pushDocuments("account-1");
  assert.equal(row(draft.docId).content, "Typed during request");
  assert.equal(row(draft.docId).last_error, null, "an old request must not tag a newer local edit");
  harness.fetch = async () => Response.json({ code: "unauthorized" }, { status: 401 });
  await assert.rejects(store.pushDocuments("account-1"), error => error.status === 401);
  assert.equal(row(draft.docId).sync_state, "create");
  harness.accountId = "account-2";
  const unchanged = sqlite.prepare("SELECT count(*) AS count FROM offline_documents").get().count;
  for (const action of [
    () => store.desktopCreateDocument({ title: "Must not enter B" }, "account-1"),
    () => store.desktopCreateFolder({ name: "Must not enter B", parentFolderId: null }, "account-1"),
    () => store.desktopStoreLocalImage(new File(["png"], "a.png", { type: "image/png" }), "account-1"),
    () => store.desktopReleaseUnusedImages(["koinote-local-image://550e8400-e29b-41d4-a716-446655440099"], "account-1"),
  ]) await assert.rejects(action(), error => error.code === "import_account_changed");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM offline_documents").get().count, unchanged);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM offline_folders WHERE account_id='account-2'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM offline_images WHERE account_id='account-2'").get().count, 0);
  harness.accountId = "account-1";
  for (const [status, code] of [[409,"folder_count_limit_reached"],[429,"too_many_requests"]]) {
    for (const table of ["offline_documents","offline_meta","offline_folders","offline_images"]) sqlite.exec(`DELETE FROM ${table}`);
    const existing = cloudDoc("existing-folder-limit");
    await store.insertRemoteDocument("account-1",existing,null,0);
    await store.desktopUpdateDocument(existing.docId,{...existing,content:"Local change survives folder limit",expectedRevision:1});
    const pendingFolder=(await store.desktopCreateFolder({name:"Pending folder",parentFolderId:null})).folder;
    const child=(await store.desktopCreateDocument({title:"Pending child",content:"Keep under intended parent",folderId:pendingFolder.folderId})).document;
    sqlite.prepare("INSERT INTO offline_folders(account_id,folder_id,name,parent_folder_id,organizer_kind,sync_state,change_seq) VALUES('account-1','delete-folder','Delete folder',NULL,NULL,'delete',1)").run();
    const documents=new Map([[existing.docId,existing]]),folders=new Map([["delete-folder",{folderId:"delete-folder",name:"Delete folder",parentFolderId:null,organizerKind:null}]]);
    let blocked=true,folderPosts=0,documentPosts=0;
    harness.fetch=async(path,init={})=>{
      if(path==="/api/folders" && init.method==="POST") {folderPosts++;if(blocked)return Response.json({code},{status});const input=JSON.parse(init.body);folders.set(input.folderId,input);return Response.json({folder:input});}
      if(path==="/api/folders" && !init.method)return Response.json({folders:[...folders.values()]});
      if(path==="/api/folders/delete-folder" && init.method==="DELETE") {folders.delete("delete-folder");return Response.json({deleted:true});}
      if(path==="/api/documents" && !init.method)return Response.json({documents:[...documents.values()].map(doc=>({...doc,folderId:doc.folderId??null,sortOrder:0}))});
      if(path==="/api/documents" && init.method==="POST") {documentPosts++;const input=JSON.parse(init.body);assert.ok(folders.has(input.folderId),"never submit a child under a missing cloud folder");const doc={...cloudDoc(input.docId),...input};documents.set(doc.docId,doc);return Response.json({document:doc});}
      if(path.startsWith("/api/documents/")){const id=path.split("/")[3];if(init.method==="PUT")documents.set(id,{...documents.get(id),...JSON.parse(init.body),revision:2});return Response.json({document:documents.get(id)});}
      throw Error(`Unexpected ${init.method??"GET"} ${path}`);
    };
    const partial=await store.performSync("account-1",{});
    assert.equal(partial.partial,true);assert.equal(partial.message,code);assert.equal(folderPosts,1);assert.equal(documentPosts,0);
    assert.equal(row(child.docId).folder_id,pendingFolder.folderId);assert.equal(row(child.docId).sync_state,"create");
    assert.equal(row(existing.docId).sync_state,"clean");assert.equal(row(existing.docId).content,"Local change survives folder limit");
    assert.equal(folders.has("delete-folder"),false,"deletions still free capacity during a blocked create");
    blocked=false;const recovered=await store.performSync("account-1",{});
    assert.equal(recovered.pending,0);assert.equal(recovered.state,"idle");assert.equal(documentPosts,1);
    assert.equal(documents.get(child.docId).folderId,pendingFolder.folderId);assert.equal(documents.size,2);
  }
  for (const placement of ["body","cover"]) {
    for (const table of ["offline_documents","offline_meta","offline_folders","offline_images"]) sqlite.exec(`DELETE FROM ${table}`);
    const imageId=crypto.randomUUID(),localURL=`koinote-local-image://${imageId}`;
    const oldKey="u/account-1/"+"a".repeat(32)+".png",newKey="u/account-1/"+"b".repeat(32)+".png";
    const url=key=>`https://img.koinote.app/${key}`;
    let doc=(await store.desktopCreateDocument({title:"Lease recovery",content:placement==="body"?`![image](${localURL})`:"Cover recovery"})).document;
    if(placement==="cover")doc=(await store.desktopUpdateDocument(doc.docId,{...doc,coverMode:"ai",coverImageSource:localURL,expectedRevision:1})).document;
    sqlite.prepare(`INSERT INTO offline_images(account_id,image_id,content_type,base64_data,byte_size,created_at,is_local_origin)
      VALUES('account-1',?,'image/png','aW1hZ2U=',5,?,1)`).run(imageId,new Date().toISOString());
    let blocked=true,uploads=0,expired=false,unavailable=false,posts=0;
    harness.fetch=async(path,init={})=>{
      if(path==="/api/images"){uploads++;const key=uploads===1?oldKey:placement==="body"&&uploads===2?"u/account-1/"+"c".repeat(32)+".png":newKey;return Response.json({image:{key,url:url(key)}});}
      if(path==="/api/storage/retain-import-images")return unavailable?Response.json({code:"server_error"},{status:503}):Response.json({missingKeys:expired?[oldKey]:[]});
      if(path==="/api/documents"&&init.method==="POST"){
        posts++;if(blocked)return Response.json({code:"document_count_limit_reached"},{status:409});
        const input=JSON.parse(init.body);assert.ok((placement==="body"?input.content:input.coverImageSource).includes(newKey));
        return Response.json({document:{...cloudDoc(input.docId),...input}});
      }
      throw Error(`Unexpected image recovery request ${path}`);
    };
    assert.deepEqual(await store.pushDocuments("account-1"),["document_count_limit_reached"]);
    assert.equal(sqlite.prepare("SELECT is_local_origin FROM offline_images WHERE image_id=?").get(imageId).is_local_origin,1);
    const kept=await store.desktopClearRemoteImageCache();assert.equal(kept.pendingLocalBytes,5,"protected uploaded original remains visible in pending usage");assert.equal(sqlite.prepare("SELECT count(*) AS n FROM offline_images").get().n,1,"cache clear keeps pending original");
    unavailable=true;assert.deepEqual(await store.pushDocuments("account-1"),["image_upload_unavailable"]);assert.equal(posts,1,"uncertain retention must not submit a possibly missing image");
    unavailable=false;expired=true;blocked=false;
    if(placement==="body"){
      const execute=harness.database.execute;let interrupted=false;
      harness.database.execute=async(sql,args)=>{if(!interrupted&&sql.includes("SET content=replace(content,$2,$3)")){interrupted=true;throw Error("Injected interruption before replacing old remote URLs");}return execute(sql,args);};
      try{assert.deepEqual(await store.pushDocuments("account-1"),["image_upload_unavailable"]);}finally{harness.database.execute=execute;}
      assert.equal(interrupted,true);assert.ok(row(doc.docId).content.includes(oldKey));
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM offline_meta WHERE key LIKE 'pending-image-replacement:%'").get().n,1,"recovery identity persists across interrupted metadata/URL writes");
      await store.desktopClearRemoteImageCache();assert.equal(sqlite.prepare("SELECT count(*) AS n FROM offline_images").get().n,1);
    }
    assert.deepEqual(await store.pushDocuments("account-1"),[]);assert.equal(uploads,placement==="body"?3:2);assert.equal(row(doc.docId).sync_state,"clean");
    assert.ok((placement==="body"?row(doc.docId).content:row(doc.docId).cover_image_source).includes(newKey));
    assert.equal(sqlite.prepare("SELECT is_local_origin FROM offline_images WHERE image_id=?").get(imageId).is_local_origin,0,"only acknowledged cloud documents release source protection");
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM offline_meta WHERE key LIKE 'pending-image-replacement:%'").get().n,0,"completed replacement no longer needs a recovery pointer");
  }
  for (const table of ["offline_documents","offline_meta","offline_folders","offline_images"]) sqlite.exec(`DELETE FROM ${table}`);
  const missingKey="u/account-1/"+"d".repeat(32)+".png";
  const missingDraft=(await store.desktopCreateDocument({title:"Missing original",content:`![image](https://img.koinote.app/${missingKey})`})).document;
  let missingPosts=0;harness.fetch=async(path,init={})=>{
    if(path==="/api/storage/retain-import-images")return Response.json({missingKeys:[missingKey]});
    if(init.method==="POST")missingPosts++;
    throw Error("A missing original must not be silently saved");
  };
  assert.deepEqual(await store.pushDocuments("account-1"),["local_image_missing"]);assert.equal(missingPosts,0);assert.equal(row(missingDraft.docId).sync_state,"create");
  // A legacy image (uploaded before usage was recorded) has no ledger row yet
  // still exists. Only an object check decides; a served image is neither
  // re-uploaded nor reported as a missing local original.
  for (const [headStatus, expected, digit] of [[200, [], "e"], [404, ["local_image_missing"], "f"], [503, ["image_upload_unavailable"], "9"]]) {
    for (const table of ["offline_documents","offline_meta","offline_folders","offline_images"]) sqlite.exec(`DELETE FROM ${table}`);
    const legacyKey="u/account-1/"+digit.repeat(32)+".png";
    const legacyDraft=(await store.desktopCreateDocument({title:"Legacy image",content:`![image](https://img.koinote.app/${legacyKey})`})).document;
    const calls=[];harness.fetch=async(path,init={})=>{
      calls.push([init.method??"GET",path]);
      if(path==="/api/storage/retain-import-images")return Response.json({missingKeys:[],unrecordedKeys:[legacyKey]});
      if(path===`/images/${legacyKey}`&&init.method==="HEAD")return new Response(null,{status:headStatus});
      if(path==="/api/documents"&&init.method==="POST"){const input=JSON.parse(init.body);assert.ok(input.content.includes(legacyKey),"the original URL is kept");return Response.json({document:{...cloudDoc(input.docId),...input}});}
      throw Error(`Unexpected legacy image request ${init.method??"GET"} ${path}`);
    };
    assert.deepEqual(await store.pushDocuments("account-1"),expected,`HEAD ${headStatus}`);
    assert.equal(calls.filter(([,path])=>path==="/api/images").length,0,"a legacy image is never re-uploaded");
    assert.equal(row(legacyDraft.docId).sync_state,headStatus===200?"clean":"create");
    if(headStatus===200)assert.ok(row(legacyDraft.docId).content.includes(legacyKey));
  }
  // Every local edit triggers a sync. Verified legacy images are checked in
  // parallel once, not re-checked serially on each sync of an edited article.
  {
    for (const table of ["offline_documents","offline_meta","offline_folders","offline_images"]) sqlite.exec(`DELETE FROM ${table}`);
    const legacyKeys=["1","2","3","4","5","6","7","8"].map(digit=>"u/account-1/"+digit.repeat(32)+".png");
    let article=(await store.desktopCreateDocument({title:"Old article",content:legacyKeys.map(key=>`![image](https://img.koinote.app/${key})`).join("\n")})).document;
    let heads=0,inFlight=0,maxInFlight=0;
    harness.fetch=async(path,init={})=>{
      if(path==="/api/storage/retain-import-images")return Response.json({missingKeys:[],unrecordedKeys:JSON.parse(init.body).keys});
      if(init.method==="HEAD"){heads++;inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);for(let i=0;i<5;i++)await Promise.resolve();inFlight--;return new Response(null,{status:200});}
      if(path==="/api/documents"&&init.method==="POST"){const input=JSON.parse(init.body);return Response.json({document:{...cloudDoc(input.docId),...input}});}
      if(path.startsWith("/api/documents/")&&init.method==="PUT"){const input=JSON.parse(init.body);return Response.json({document:{...cloudDoc(article.docId),...input,revision:input.expectedRevision+1}});}
      throw Error(`Unexpected cached legacy request ${init.method??"GET"} ${path}`);
    };
    assert.deepEqual(await store.pushDocuments("account-1"),[]);
    assert.equal(heads,legacyKeys.length);assert.ok(maxInFlight>1,"legacy image checks run concurrently");
    article=(await store.desktopUpdateDocument(article.docId,{...article,content:article.content+"\nEdited",expectedRevision:row(article.docId).base_revision})).document;
    assert.equal(row(article.docId).sync_state,"update");
    assert.deepEqual(await store.pushDocuments("account-1"),[]);
    assert.equal(heads,legacyKeys.length,"a recently verified legacy image is not re-checked on the next sync");
    assert.equal(row(article.docId).sync_state,"clean");
  }
  console.log("offline limit recovery: real SQLite, image/cover mapping, persisted refusals, UUID replay, concurrent edits and auth checks passed");
} finally {
  globalThis.window = oldWindow;
  globalThis.setTimeout = oldTimer;
  if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator); else delete globalThis.navigator;
  delete globalThis.__syncLimits;
  sqlite.close();
}
