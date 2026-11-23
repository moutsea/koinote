import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { QueryClient } from "@tanstack/react-query";

const directory = mkdtempSync(`${process.cwd()}/scripts/.session-cache-`);
const previousFetch = globalThis.fetch;
let client;
try {
  const result = await build({
    stdin: { contents: 'export {sessionQueryOptions} from "./auth";export {apiJson,createDocument} from "./api";', resolveDir: `${process.cwd()}/spa/src` },
    bundle: true, write: false, format: "esm", platform: "node", packages: "external", logLevel: "error",
  });
  const file = `${directory}/session.mjs`; writeFileSync(file, result.outputFiles[0].text);
  const api = await import(pathToFileURL(file).href);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let session = { user: { authUserId: "A" } }, status = 200, gates = new Map();
  globalThis.fetch = async path => gates.has(path) ? gates.get(path) : Response.json(session, { status });
  const refresh = () => client.fetchQuery({ ...api.sessionQueryOptions(client), staleTime: 0 });
  await refresh();
  for (const key of [["documents"], ["folders"], ["trash"], ["storage-usage"], ["document", "A-id"]]) client.setQueryData(key, "Private A");
  client.setQueryData(["session"], { user: { authUserId: "A", nickname: "Updated" } });
  assert.equal(client.getQueryData(["documents"]), "Private A", "same-account profile updates preserve caches");
  status = 503; await assert.rejects(refresh());
  assert.equal(client.getQueryData(["documents"]), "Private A", "a temporary session failure is not a sign-out"); status = 200;

  let finishRead, finishWrite, finishSession;
  gates.set("/api/late-read", new Promise(resolve => { finishRead = resolve; }));
  gates.set("/api/documents", new Promise(resolve => { finishWrite = resolve; }));
  gates.set("/api/auth/session", new Promise(resolve => { finishSession = resolve; }));
  const read = client.fetchQuery({ queryKey: ["late-private"], queryFn: () => api.apiJson("/api/late-read") }).catch(error => error);
  const write = api.createDocument({ title: "Private A" }).then(value => { client.setQueryData(["documents"], value); return null; }, error => error);
  const oldSession = refresh().catch(error => error);
  await Promise.resolve();
  client.setQueryData(["session"], { user: { authUserId: "B" } });
  assert.equal(client.getQueryCache().getAll().filter(query => query.queryKey[0] !== "session").length, 0);
  finishRead(Response.json({ title: "Late private A" }));
  finishWrite(Response.json({ document: { title: "Late private A" } }));
  finishSession(Response.json({ user: { authUserId: "A" } }));
  await read; await oldSession;
  assert.equal((await write).code, "session_changed", "a late mutation cannot repopulate the new account's cache");
  assert.equal(client.getQueryData(["late-private"]), undefined);
  assert.equal(client.getQueryData(["documents"]), undefined);
  assert.equal(client.getQueryData(["session"]).user.authUserId, "B", "a superseded session GET cannot restore A");
  gates.clear(); session = { user: { authUserId: "B" } };
  await refresh(); client.setQueryData(["documents"], "Private B");
  client.removeQueries({ queryKey: ["session"], exact: true });
  assert.equal(client.getQueryData(["documents"]), undefined, "logout removes private data too");
  console.log("session cache: identity changes clear all private queries, late reads/writes/session responses cannot restore A, transient errors and same-account updates preserve data");
} finally {
  client?.clear(); globalThis.fetch = previousFetch; rmSync(directory, { recursive: true, force: true });
}
