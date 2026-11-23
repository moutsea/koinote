import assert from "node:assert/strict";
import { build } from "esbuild";

const harness = {};
globalThis.__importRecovery = harness;
const adapters = {
  "./api": `export class ApiError extends Error {constructor(status,message,code){super(message);this.status=status;this.code=code;}}
    export const getSession=async()=>({user:{authUserId:"account-1"}});
    const pinned=owner=>{if(owner!=="account-1")throw Error("Import owner was lost");};
    export const createDocument=(p,owner)=>{pinned(owner);return globalThis.__importRecovery.create(p)};
    export const createFolder=(p,owner)=>{pinned(owner);return globalThis.__importRecovery.folder(p)};
    export const releaseUnusedImages=(keys,owner)=>{pinned(owner);return globalThis.__importRecovery.release(keys)};
    export const retainImportImages=(keys,owner)=>{pinned(owner);return globalThis.__importRecovery.retain(keys)};
    export const uploadImage=(file,purpose,owner)=>{pinned(owner);return globalThis.__importRecovery.upload(file)};
    export const fetchAppResource=async()=>{throw Error('Unexpected resource fetch')};
    export const getDocument=async()=>{throw Error('Unexpected document fetch')};
    export const trackProductEvent=async()=>{};`,
  "./components/editor/exportDocument": "export const saveExportBlob=async()=>{};export const safeFilename=x=>x;",
  "./importImageCompression": "export const prepareImportedImage=async file=>({file,flattenedAnimation:false});",
  "./importArchive": "export const unpackImportArchiveFile=async()=>{throw Error('Unexpected archive')};",
};
const compiled = await build({
  stdin: { contents: 'export * from "./documentTransfer"; export {ApiError} from "./api";', resolveDir: `${process.cwd()}/spa/src` },
  bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{ name: "import-service-adapters", setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(adapters, args.path) ? { path: args.path, namespace: "import-test" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "import-test" }, args => ({ contents: adapters[args.path] }));
  } }],
});
const { importDocumentsFromFiles, ImportInterruptedError, ApiError, getImportErrorMessage } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const files = count => Array.from({ length: count }, (_, i) => new File(["Body"], `${String(i).padStart(4, "0")}.md`));
const error = (status, code, retryAfterMs = 60_000) => Object.assign(new ApiError(status, code, code), { retryAfterMs });
let saved, releases, uploaded, folders, delays;
function reset() {
  saved = []; releases = []; uploaded = new Map(); folders = []; delays = [];
  harness.create = async p => { saved.push(p); return { document: { docId: `doc-${saved.length}` } }; };
  harness.folder = async p => { folders.push(p); return { folder: { folderId: `folder-${folders.length}` } }; };
  harness.upload = async () => { const image = { key: `key-${uploaded.size}`, url: `https://images.invalid/image-${uploaded.size}.png` }; uploaded.set(image.key, image); return image; };
  harness.retain = async () => ({ missingKeys: [] });
  harness.release = async keys => {
    releases.push(keys);
    for (const key of keys) if (!saved.some(doc => doc.content.includes(uploaded.get(key)?.url))) uploaded.delete(key);
  };
}
const originalTimer = globalThis.setTimeout;
try {
  globalThis.setTimeout = (callback, delay) => { delays.push(delay); queueMicrotask(callback); return 1; };
  reset();
  let rejected = false, checks = 0;
  const attemptedTitles = [];
  harness.create = async p => {
    attemptedTitles.push(p.title);
    if (saved.length === 300 && !rejected) { rejected = true; throw error(429, "too_many_requests"); }
    saved.push(p); return { document: { docId: String(saved.length) } };
  };
  const waiting = [], progress = [];
  const result = await importDocumentsFromFiles(files(330), (done, total) => progress.push([done, total]), null, { checkSession: async () => { checks++; }, onWaitingChange: value => waiting.push(value) });
  assert.equal(result.imported, 330);
  assert.equal(new Set(saved.map(p => p.title)).size, 330);
  assert.deepEqual(delays, [60_000], "honor Retry-After before retrying only the rejected file");
  assert.equal(attemptedTitles.filter(title => title === "0300").length, 2);
  assert.equal(attemptedTitles.filter(title => title === "0000").length, 1);
  assert.equal(checks, 2, "verify the account again after the wait");
  assert.deepEqual(waiting, [true, false]);
  assert.deepEqual(progress.at(-1), [330, 330]);

  reset();
  let blocked = true;
  harness.create = async p => {
    if (blocked && saved.length === 300) throw error(409, "document_count_limit_reached");
    saved.push(p); return { document: { docId: String(saved.length) } };
  };
  let partial;
  try { await importDocumentsFromFiles(files(330), undefined, null); } catch (failure) { partial = failure; }
  assert.ok(partial instanceof ImportInterruptedError);
  assert.equal(partial.imported, 300);
  assert.equal(partial.total, 330);
  assert.equal(partial.canResume, true);
  assert.equal(releases.length, 0, "a resumable plan must keep its image mappings until it ends");
  const copy = { importPartial: "Saved {count}/{total}. {reason}", importUncertain: "Uncertain {count}/{total}. {reason}", importFailed: "Failed", importSessionCheckFailed: "Check connection and retry" };
  assert.equal(getImportErrorMessage(partial, copy, { document_count_limit_reached: "Limit $&" }), "Saved 300/330. Limit $&");
  blocked = false;
  assert.equal((await partial.resume(undefined, { owner: "account-2" })).imported, 330);
  assert.equal(saved.length, 330);
  assert.equal(new Set(saved.map(p => p.title)).size, 330, "manual resume must never restart the successful prefix");

  reset();
  blocked = true;
  harness.create = async p => {
    if (blocked && saved.length === 1) throw error(429, "too_many_requests");
    saved.push(p); return { document: { docId: String(saved.length) } };
  };
  try { await importDocumentsFromFiles(files(3), undefined, null); } catch (failure) { partial = failure; }
  assert.equal(partial.imported, 1);
  assert.equal(partial.canResume, true);
  assert.equal(delays.length, 3, "retries are bounded; repeated refusal pauses the plan");
  blocked = false;
  assert.equal((await partial.resume()).imported, 3);
  assert.equal(new Set(saved.map(p => p.title)).size, 3);

  reset();
  harness.create = async p => {
    saved.push(p);
    if (saved.length === 2) throw error(503, "server_busy"); // Simulate a lost response after commit.
    return { document: { docId: String(saved.length) } };
  };
  try { await importDocumentsFromFiles(files(3), undefined, null); } catch (failure) { partial = failure; }
  assert.equal(partial.imported, 1, "report only confirmed writes");
  assert.equal(partial.canResume, false);
  await assert.rejects(partial.resume(), /import_result_uncertain/);
  assert.equal(saved.length, 2, "an ambiguous POST must not be replayed");
  await partial.discard();
  assert.equal(saved.length, 2, "ending an import must preserve already saved documents");

  reset();
  let sessionChecks = 0, rateRefused = false;
  harness.create = async p => {
    if (saved.length === 1 && !rateRefused) { rateRefused = true; throw error(429, "too_many_requests"); }
    saved.push(p); return { document: { docId: String(saved.length) } };
  };
  try {
    await importDocumentsFromFiles(files(3), undefined, null, {
      checkSession: async () => { if (++sessionChecks === 2) throw error(503, "server_error"); },
    });
  } catch (failure) { partial = failure; }
  assert.equal(partial.imported, 1);
  assert.equal(partial.phase, "session-check");
  assert.equal(partial.canResume, true, "a failed session GET after a rate wait has not submitted another POST");
  assert.equal(getImportErrorMessage(partial, copy), "Saved 1/3. Check connection and retry");
  assert.deepEqual(delays, [60_000]);
  assert.equal((await partial.resume()).imported, 3);
  assert.equal(new Set(saved.map(p => p.title)).size, 3);
  assert.equal(sessionChecks, 3, "manual resume checks the session again");

  reset();
  harness.create = async p => {
    saved.push(p);
    if (saved.length === 2) throw new TypeError("Response lost after POST");
    return { document: { docId: String(saved.length) } };
  };
  try { await importDocumentsFromFiles(files(3), undefined, null); } catch (failure) { partial = failure; }
  assert.equal(partial.phase, "write");
  assert.equal(partial.canResume, false, "a network error after a POST remains ambiguous");
  await assert.rejects(partial.resume(), /import_result_uncertain/);
  assert.equal(saved.length, 2);
  // A long-paused task must recreate expired uploads before submitting its
  // remaining documents, while preserving confirmed documents and progress.
  reset();
  const expiredImageFiles = [new File(["![image](image.png)"], "a.md"), new File(["![image](image.png)"], "b.md"), new File([new Uint8Array([1,2,3])], "image.png", {type:"image/png"})];
  let uploadCount = 0, leaseBlocked = true;
  harness.upload = async () => { const image={key:`lease-${++uploadCount}`,url:`https://images.invalid/lease-${uploadCount}.png`};uploaded.set(image.key,image);return image; };
  harness.create = async p => {if(leaseBlocked&&saved.length===1)throw error(409,"document_count_limit_reached");saved.push(p);return {document:{docId:String(saved.length)}};};
  let expiredPlan;
  try {await importDocumentsFromFiles(expiredImageFiles);}catch(error){expiredPlan=error;}
  harness.retain=async()=>{throw new TypeError("Image status unavailable")};
  let imageCheckFailure;
  try {await expiredPlan.resume();}catch(error){imageCheckFailure=error;}
  assert.equal(imageCheckFailure.phase,"image-check");assert.equal(imageCheckFailure.canResume,true);assert.equal(saved.length,1);
  assert.equal(getImportErrorMessage(imageCheckFailure,{...copy,importImageCheckFailed:"Images unavailable"}),"Saved 1/2. Images unavailable");
  harness.retain=async keys=>({missingKeys:keys});leaseBlocked=false;
  assert.equal((await imageCheckFailure.resume()).imported,2);
  assert.equal(uploadCount,2);assert.match(saved[0].content,/lease-1/);assert.match(saved[1].content,/lease-2/);
  await partial.discard();

  // A collector's explicit refusal is safe to resume; no document committed.
  reset();uploadCount=0;let claimed=true;
  harness.upload=async()=>{const image={key:`claimed-${++uploadCount}`,url:`https://images.invalid/claimed-${uploadCount}.png`};uploaded.set(image.key,image);return image;};
  harness.create=async p=>{if(claimed)throw error(409,"image_unavailable");saved.push(p);return {document:{docId:String(saved.length)}};};
  let claimedPlan;try{await importDocumentsFromFiles(expiredImageFiles);}catch(error){claimedPlan=error;}
  assert.equal(claimedPlan.canResume,true);assert.equal(claimedPlan.imported,0);
  // This plan's own uploads always have a ledger row, so an unrecorded key was collected.
  harness.retain=async keys=>({missingKeys:[],unrecordedKeys:keys});claimed=false;
  assert.equal((await claimedPlan.resume()).imported,2);assert.equal(uploadCount,2);assert.ok(saved.every(doc=>doc.content.includes("claimed-2")));

  reset();
  const controller = new AbortController();
  let attempts = 0;
  harness.create = async () => { attempts++; throw error(429, "too_many_requests"); };
  await assert.rejects(importDocumentsFromFiles(files(3), undefined, null, {
    signal: controller.signal,
    onWaitingChange: value => { if (value) controller.abort(); },
  }), failure => failure.name === "AbortError");
  assert.equal(attempts, 1, "leaving the page during a wait must stop the next POST");

  reset();
  blocked = true;
  const imageFiles = [new File(["![image](image.png)"], "folder/a.md"), new File(["![image](image.png)"], "folder/b.md"), new File([new Uint8Array([1, 2, 3])], "folder/image.png", { type: "image/png" })];
  harness.create = async p => {
    if (blocked && saved.length === 1) throw error(409, "document_count_limit_reached");
    saved.push(p); return { document: { docId: String(saved.length) } };
  };
  try { await importDocumentsFromFiles(imageFiles); } catch (failure) { partial = failure; }
  assert.equal(partial.imported, 1);
  assert.equal(folders.length, 1);
  assert.equal(uploaded.size, 1);
  assert.equal(releases.length, 0);
  blocked = false;
  await partial.resume();
  assert.equal(folders.length, 1, "resume reuses an already created folder");
  assert.equal(uploaded.size, 1, "referenced images survive cleanup");
  assert.equal(releases.length, 1);
  assert.ok(saved.every(doc => doc.content.includes("https://images.invalid/")));
  assert.equal(saved.length, 2);
  console.log("import recovery: 330-file resume, failed preflight GET vs ambiguous POST, cancellation, folders and image lifecycle passed");
} finally {
  globalThis.setTimeout = originalTimer;
  delete globalThis.__importRecovery;
}
