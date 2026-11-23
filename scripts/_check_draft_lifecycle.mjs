import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const directory = mkdtempSync(`${process.cwd()}/scripts/.draft-lifecycle-`);
const previousFetch = globalThis.fetch;
const roots = [], clients = [], savers = new Map(), logouts = new Map();
let api;
try {
  const bundle = await build({stdin: {contents: `export {useDocumentSaver} from './components/editor/useDocumentSaver'; export {sessionQueryOptions,useLogout} from './auth'; export {conflictDraftKey,setConflictDraftOwner} from './conflictDrafts';`, resolveDir: `${process.cwd()}/spa/src`}, bundle: true, write: false, format: "esm", platform: "node", packages: "external", logLevel: "error"});
  const file = `${directory}/lifecycle.mjs`; writeFileSync(file, bundle.outputFiles[0].text);
  api = await import(pathToFileURL(file).href);
  const {window} = parseHTML("<html><body></body></html>");
  globalThis.window = window; globalThis.document = window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const storage = new Map(); let failWrites = false;
  window.localStorage = {get length() {return storage.size;}, key: index => [...storage.keys()][index] ?? null, getItem: key => storage.get(key) ?? null, setItem: (key, value) => {if(failWrites) throw new Error("QuotaExceededError"); storage.set(key,String(value));}, removeItem: key => storage.delete(key)};
  let owner = "A", sessionStatus = 200, delayed;
  let remote = {title: "Article", content: "Cloud v1", theme: "minimal", revision: 1};
  globalThis.fetch = async (path, init = {}) => {
    if(path === "/api/auth/session") return Response.json(sessionStatus === 200 ? {user: {authUserId: owner}} : {code:"unauthorized"}, {status: sessionStatus});
    if(path === "/api/auth/logout") return Response.json({success: true});
    if(init.method === "PUT") {
      if(delayed) return delayed;
      const body = JSON.parse(init.body);
      if(body.expectedRevision !== remote.revision) return Response.json({code:"document_revision_conflict"}, {status:409});
      remote = {...remote,...body,revision: remote.revision+1}; return Response.json({document:remote});
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const flush = work => act(async () => {await work?.(); await new Promise(resolve => setTimeout(resolve,5));});
  function Harness({tab, account}) {savers.set(tab,api.useDocumentSaver(undefined,account));logouts.set(tab,api.useLogout());return null;}
  async function open(tab) {
    const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{gcTime:Infinity}}});clients.push(client);
    await client.fetchQuery(api.sessionQueryOptions(client));
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root);
    await flush(() => root.render(React.createElement(QueryClientProvider,{client},React.createElement(Harness,{tab,account:owner}))));
    return {client,root};
  }
  const a = await open("A"); await open("B");
  await flush(() => {savers.get("A").seed("doc",remote);savers.get("B").seed("doc",remote);});
  await flush(async () => {savers.get("B").queue("doc",{content:"B saved"});assert.equal(await savers.get("B").flush("doc"),true);});
  await flush(async () => {savers.get("A").queue("doc",{content:"Private A conflict"});assert.equal(await savers.get("A").flush("doc"),false);});
  const key = api.conflictDraftKey("doc","A"), original = storage.get(key);
  await flush(async () => {savers.get("B").queue("doc",{content:"B saved again"});assert.equal(await savers.get("B").flush("doc"),true);});
  assert.equal(storage.get(key),original,"another tab's successful save cannot remove A's conflict backup");
  await open("reloaded"); await flush(() => savers.get("reloaded").seed("doc",remote));
  assert.equal(savers.get("reloaded").peek("doc").content,"Private A conflict");
  await flush(async () => {savers.get("A").queue("doc",{content:"Newer A conflict"});assert.equal(await savers.get("A").flush("doc"),false);});
  const newer = storage.get(key);
  await flush(() => savers.get("reloaded").acceptRemote("doc",remote));
  assert.equal(storage.get(key),newer,"accepting the remote version in an old instance cannot delete a newer backup");
  await flush(() => savers.get("reloaded").drop("doc"));
  assert.equal(storage.get(key),newer);

  // Replacing/losing shared storage invalidates deduplication; preserve another
  // instance's backup when a failed write cannot replace it.
  const external = JSON.stringify({...remote,content:"Other instance recovery",conflict:true});storage.set(key,external);
  failWrites = true;
  await flush(() => savers.get("A").flush("doc")); failWrites = false;
  assert.equal(storage.get(key),external);
  storage.delete(key); await flush(() => savers.get("A").flush("doc"));
  assert.equal(JSON.parse(storage.get(key)).content,"Newer A conflict");

  let finish; delayed = new Promise(resolve => {finish=resolve;}); let saving;
  await flush(() => {savers.get("A").queue("doc",{content:"Latest text during expiry"});saving=savers.get("A").flush("doc");});
  a.client.setQueryData(["document","private"],remote);
  sessionStatus=401;
  await flush(() => a.client.fetchQuery({...api.sessionQueryOptions(a.client),staleTime:0}));
  assert.equal(a.client.getQueryData(["session"]).user,null);
  assert.equal(a.client.getQueryData(["document","private"]),undefined);
  assert.equal(JSON.parse(storage.get(key)).content,"Newer A conflict");
  await flush(() => a.root.unmount()); roots.splice(roots.indexOf(a.root),1);
  await flush(async () => {finish(Response.json({code:"unauthorized"},{status:401}));assert.equal(await saving,false);}); delayed=null;
  assert.equal(JSON.parse(storage.get(key)).content,"Latest text during expiry","an in-flight failure may finish its account-scoped backup after passive expiry");
  sessionStatus=200; await open("login-again");await flush(() => savers.get("login-again").seed("doc",remote));
  assert.equal(savers.get("login-again").peek("doc").content,"Latest text during expiry");

  delayed=new Promise(resolve => {finish=resolve;});
  await flush(() => {savers.get("login-again").queue("doc",{content:"Late failure after explicit logout"});saving=savers.get("login-again").flush("doc");});
  await flush(() => logouts.get("login-again")()); assert.equal(storage.has(key),false);
  await flush(async () => {finish(Response.json({code:"unauthorized"},{status:401}));await saving;});delayed=null;
  assert.equal(storage.has(key),false,"explicit logout must revoke late backup writes");
  owner="B"; await open("other-account");await flush(() => savers.get("other-account").seed("doc",remote));
  assert.equal(savers.get("other-account").peek("doc").content,remote.content);
  console.log("draft lifecycle: passive expiry/relogin, late failures, explicit logout, cross-tab successful saves, accept/drop ownership and deduplication passed");
} finally {
  api?.setConflictDraftOwner(undefined);
  await act(async () => {for(const root of roots)root.unmount();});
  for(const client of clients)client.clear();globalThis.fetch=previousFetch;rmSync(directory,{recursive:true,force:true});
}
