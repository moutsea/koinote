import "./_check_agent_github_import.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
Object.assign(globalThis, { window, self: window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
// Linkedom does not reflect the textarea defaultValue used by React on mount.
Object.defineProperty(window.HTMLTextAreaElement.prototype, "defaultValue", {
  get() { return this.textContent; }, set(value) { this.textContent = value; }, configurable: true,
});
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Node.js" }, configurable: true });
window.location = { origin: "https://koinote.example" };
const bytes = Buffer.from("# Shared skill\nReview before use.");
const workspace = { workspaceId: 7, revision: 3, name: "Shared skills", description: "Portable instructions", updatedAt: "2026-10-09T00:00:00Z", files: [{ fileId: 21, path: ".codex/skills/demo/SKILL.md", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "text/markdown" }] };
const publicRepository = { ...workspace, starCount:0, starred:false, cloneCount:0, license: "MIT", publicationId: "2026-10-09T00:00:00.123456Z", url: "https://koinote.example/repositories/7", manifestUrl: "https://koinote.example/api/agent/repositories/7?revision=3&publication=2026-10-09T00%3A00%3A00.123456Z" };
const secondBytes = Buffer.from("# Second repository\nA different snapshot.");
const secondRepository = { workspaceId: 8, revision: 2, name: "Second skills", description: "Another published snapshot", updatedAt: "2026-10-10T00:00:00Z", publicationId: "2026-10-10T00:00:00Z", starCount: 0, starred: false, cloneCount: 0, license: "MIT", url: "https://koinote.example/repositories/8", manifestUrl: "https://koinote.example/api/agent/repositories/8?revision=2&publication=2026-10-10T00%3A00%3A00Z", files: [{ fileId: 81, path: "README.md", sizeBytes: secondBytes.length, sha256: createHash("sha256").update(secondBytes).digest("hex"), mimeType: "text/markdown" }] };
const calls = [], navigations = [], confirmations = [];
function notifyRoute() { for (const listener of h.routeListeners) listener(); }
const h = globalThis.__sharingTest = {
  workspace, publicRepository, secondRepository, publication: null, source: null, labels: null,
  search: {}, directorySearch: {}, routeListeners: new Set(), repositoryId: "7", gates: new Map(),
  // React Router keeps the page mounted when only the id changes; these helpers
  // reproduce that by pushing a new snapshot through the subscribed params.
  setRepository(repositoryId) {
    const next = String(repositoryId);
    if (h.repositoryId === next) return;
    h.repositoryId = next; notifyRoute();
  },
  setUser(user) { h.user = user; notifyRoute(); },
  user: { id: 1, membershipTier: "lifetime" }, enabled: true, confirmResult: true, failPublish: false, failFork: false, withdrawn: false, privateCalls: 0,
  navigate: async (target) => {
    const key = target.to === "/repositories" ? "directorySearch" : "search";
    const search = typeof target.search === "function" ? target.search(h[key]) : target.search;
    navigations.push({ ...target, search });
    if (target.to === "/agent/workspaces/$workspaceId" && h.openForkDestination) {
      h.forkDestination = { userId: h.user.id, workspaceId: Number(target.params.workspaceId) };
      renderForkDestination(h.forkDestination);
    }
    if (target.to === "/repositories" || target.to === "/repositories/$repositoryId") {
      h[key] = search ?? {}; h.hash = target.hash;
      notifyRoute();
    }
  },
  confirm: async (message) => { confirmations.push(message); return h.confirmResult; },
  async api(path, init = {}) {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    const gate = h.gates.get(`${method} ${path}`);
    if (gate) { h.gates.delete(`${method} ${path}`); await gate.promise; }
    if (path === "/api/koi/settings") {
      if (h.koiOverviewError) throw new ApiError(503, "unavailable", "koi_unavailable");
      return { managementAvailable: Boolean(h.koiAvailable), canInstall: Boolean(h.koiAvailable), settings: { autoSkills: true, revision: 1, libraryMode: "installed" }, legacySkillCount: 0 };
    }
    if (path.startsWith("/api/koi/skills?")) {
      if (h.koiSkillsError) throw new ApiError(503, "unavailable", "koi_unavailable");
      const params = new URL(path, "https://koinote.example").searchParams;
      const skills = (h.koiSkillsByUser?.[h.user?.authUserId] ?? h.koiSkills ?? []).filter(skill => params.has("githubRepositoryId") ? skill.sourceKind === "github" && String(skill.source.repositoryId) === params.get("githubRepositoryId") : skill.sourceKind === "hub" && String(skill.source.workspaceId) === params.get("hubWorkspaceId"));
      const offset = Number(params.get("cursor") || 0);
      return { skills: skills.slice(offset, offset + 20), nextCursor: skills.length > offset + 20 ? String(offset + 20) : "", storage: { usedBytes: 0 } };
    }
    if (path === "/api/koi/skill-imports/hub-preview/confirm") { h.koiSkills = h.koiInstallResult; return { installed: h.koiSkills }; }
    if (path === "/api/koi/skill-imports") return { preview: { id: "hub-preview", sourceKind: body.source, source: { kind: body.source, name: publicRepository.name }, status: "ready", revision: 1, candidates: h.koiCandidates ?? [], rejected: h.koiRejected ?? [] } };
    if (path === "/api/koi/skill-imports/hub-preview") return { status: "cancelled" };
    if (path === "/api/agent/github-credential") {
      if (method === "PUT") h.credential = { configured: true, tokenHint: body.token.slice(-4) };
      if (method === "DELETE") h.credential = { configured: false };
      return { credential: h.credential ?? { configured: false } };
    }
    if (path === "/api/agent/workspaces/import/github") {
      if (h.failImport) throw new ApiError(422, "sensitive", "sensitive_data_detected");
      return { workspace: { ...workspace, workspaceId: 9 } };
    }
    if (path === "/api/admin/agent-repositories/import/github") return { workspace: { ...publicRepository, files: [] } };
    if (path === "/api/admin/agent-repositories") return { repositories: [{ ...publicRepository, fileCount: 1, sizeBytes: bytes.length, systemManaged: true, publishedRevision: h.publication ? 3 : null }] };
    if (path.endsWith("/sharing")) {
      if (method === "GET") return { publication: h.publication, source: h.source, currentRevision: h.privateRevision ?? workspace.revision };
      if (h.privateRevision !== undefined && body.expectedRevision !== h.privateRevision) throw new ApiError(409, "changed", "revision_conflict");
      if (h.failPublish) throw new ApiError(422, "sensitive", "sensitive_data_detected");
      if (method === "PUT" && body.category && h.detailWorkspace) h.detailWorkspace = { ...h.detailWorkspace, category: body.category };
      if (method === "DELETE" && h.revokePublic) h.withdrawn = true;
      h.publication = method === "DELETE" ? null : { ...publicRepository, license: body.license, category: body.category ?? 'other' };
      return { success: true };
    }
    if (path.endsWith("/star")) {
      if(h.failStar) throw new ApiError(503,"Star failed");
      publicRepository.starred = method === "PUT";
      publicRepository.starCount = publicRepository.starred ? 1 : 0;
      return {starred:publicRepository.starred,starCount:publicRepository.starCount,cloneCount:publicRepository.cloneCount};
    }
    if (path.endsWith("/sync") || path.endsWith("/sync?recheck=false")) {
      const target = path.includes("/repositories/8/") ? secondRepository : publicRepository;
      const preparing = path.endsWith("?recheck=false");
      const skip = target.syncDisabledReason || (!target.githubSource ? "no_github_source" : preparing ? target.githubSource.upstreamStatus : undefined);
      if (skip) return { repository: structuredClone(target), sync: { status: "skipped", code: skip } };
      if (h.syncErrorCode) {
        if (preparing && ['license_changed', 'license_review_required', 'publication_license_mismatch', 'repository_identity_mismatch'].includes(h.syncErrorCode)) return { repository: structuredClone(target), sync: { status: 'skipped', code: h.syncErrorCode } };
        throw new ApiError(422, "Upstream needs review", h.syncErrorCode);
      }
      if (h.failSync) throw new ApiError(503, "GitHub unavailable", "github_temporarily_unavailable");
      const changed = h.nextUpstream;
      if (changed) {
        Object.assign(target, changed);
        delete h.nextUpstream;
      }
      const payload = h.syncPayload?.workspaceId === target.workspaceId ? structuredClone(h.syncPayload) : structuredClone(target);
      return { repository: payload, sync: h.syncResult ?? { status: changed ? "updated" : "unchanged" } };
    }
    if(path.endsWith("/clone")) {
      const target = path.includes("/repositories/8/") ? secondRepository : publicRepository;
      if (body.expectedRevision !== target.revision || (body.expectedPublication && body.expectedPublication !== target.publicationId)) throw new ApiError(409, "stale clone snapshot", "revision_conflict");
      if(h.failClone) throw new ApiError(503,"Clone failed");
      if(!h.cloneIDs)h.cloneIDs=new Set();
      h.cloneIDs.add(body.requestId);target.cloneCount=h.cloneIDs.size;
      if(h.loseCloneResponse) throw new ApiError(503,"Clone response lost after recording");
      return {starred:target.starred,starCount:target.starCount,cloneCount:target.cloneCount};
    }
    if (path.endsWith("/fork")) {
      const key = `${h.user?.id}:${body.requestId}`;
      h.forkResults ??= new Map();
      const completed = h.forkResults.get(key);
      if (completed) {
        if (completed.revision !== body.expectedRevision) throw new ApiError(409, "fork intent changed", "revision_conflict");
        return structuredClone(completed.result);
      }
      if (!h.enabled) throw new ApiError(403, "Cloud sync is disabled", "agent_workspace_disabled");
      if (body.expectedRevision !== publicRepository.revision || (body.expectedPublication && body.expectedPublication !== publicRepository.publicationId)) throw new ApiError(409, "stale fork snapshot", "revision_conflict");
      if (h.failFork) throw new ApiError(503, "network failure");
      const result = { workspace: { ...workspace, workspaceId: 8 } };
      h.forkResults.set(key, { revision: body.expectedRevision, result });
      if (h.loseForkResponse) throw new ApiError(503, "Fork response lost after committing");
      return result;
    }
    if (h.withdrawn) throw new ApiError(404, "withdrawn");
    const requestURL = new URL(path, 'https://koinote.example');
    const requestRepository = path.includes('/repositories/8') ? secondRepository : publicRepository;
    const expectedPublication = requestURL.searchParams.get('publication');
    if (expectedPublication && expectedPublication !== requestRepository.publicationId) throw new ApiError(409, 'publication replaced', 'revision_conflict');
    requestURL.searchParams.delete('publication');
    const unpinnedPath = requestURL.pathname + (requestURL.search ? requestURL.search : '');
    if (h.extraFiles?.[unpinnedPath]) return { file: h.extraFiles[unpinnedPath] };
    if (path.startsWith("/api/agent/repositories/7/files/21?") && Number(new URL(path, "https://koinote.example").searchParams.get("revision")) === publicRepository.revision) return { file: { ...workspace.files[0], contentBase64: bytes.toString("base64") } };
    if (path.includes("/files/81?revision=2")) return { file: { ...secondRepository.files[0], contentBase64: secondBytes.toString("base64") } };
    if (path.includes("/files/")) throw new ApiError(404, "snapshot file unavailable", "not_found");
    if (path.startsWith("/api/agent/repositories/7?revision=") && Number(new URL(path, "https://koinote.example").searchParams.get("revision")) !== publicRepository.revision) throw new ApiError(404, "snapshot replaced", "not_found");
    if (path.startsWith("/api/agent/repositories/7")) return { repository: structuredClone(publicRepository) };
    if (path.startsWith("/api/agent/repositories/8")) return { repository: structuredClone(secondRepository) };
    if (path.startsWith("/api/agent/repositories?")) {
      const params=new URL(path,'https://koinote.example').searchParams;
      if (h.failDirectoryPage === (params.get('cursor') ?? 'first')) throw new ApiError(503,'Temporary directory failure');
      const entries=h.directory ?? [{...publicRepository,category:'other',fileCount:1,sizeBytes:bytes.length}];
      const searched=entries.filter(item=>(item.name+' '+item.description+' '+(item.githubSource?.author??'')).toLowerCase().includes((params.get('q')??'').toLowerCase()));
      const facets=[];
      for(const item of searched) {
        let facet=facets.find(f=>f.category===item.category&&f.systemManaged===Boolean(item.systemManaged));
        if(!facet) {facet={category:item.category,systemManaged:Boolean(item.systemManaged),count:0,koiInstallableCount:0};facets.push(facet);} facet.count++;if(item.koiInstallable)facet.koiInstallableCount++;
      }
      const filtered=searched.filter(item=>(!params.get('koiInstallable')||Boolean(item.koiInstallable))&&(!params.get('category')||item.category===params.get('category'))&&(!params.get('source')||Boolean(item.systemManaged)===(params.get('source')==='system')));
      const start=Number(params.get('cursor')??0),size=h.directoryPageSize??12;
      return {repositories:filtered.slice(start,start+size),total:filtered.length,koiPending:h.pendingKoi??0,facets,nextCursor:start+size<filtered.length?String(start+size):null};
    }
    throw new Error(`Unexpected API ${method} ${path}`);
  },
};
const bundle = await build({
  stdin: { resolveDir: process.cwd(), contents: `
    export { createElement, act } from "react";
    export { createRoot } from "react-dom/client";
    export { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
    export { ApiError } from "./api";
    export { githubImportErrorMessage } from "./spa/src/agentGitHubImport";
    export { AgentGitHubImportForm } from "./spa/src/components/AgentGitHubImportForm";
    export { AgentGitHubCredentialCard } from "./spa/src/components/AgentGitHubCredentialCard";
    export { SystemRepositoriesAdminPanel } from "./spa/src/components/SystemRepositoriesAdminPanel";
    export { AgentRepositorySharingCard } from "./spa/src/components/AgentRepositorySharingCard";
    export { AgentPublicRepositoryPage } from "./spa/src/pages/AgentPublicRepositoryPage";
    export { AgentRepositoryForkNotice } from "./spa/src/components/AgentRepositoryForkNotice";
    export { AGENT_REPOSITORY_FORK_NOTICE_QUERY_KEY } from "./spa/src/agentRepositorySyncFeedback";
    export { AgentPublicRepositoriesPage } from "./spa/src/pages/AgentPublicRepositoriesPage";
    export { parseRepositoryDirectorySearch } from "./spa/src/agentRepositoryDirectory";
    export { RepositoryMarkdown } from "./spa/src/components/RepositoryMarkdown";
    export { repositoryResource, repositoryReadme, repositoryPreview, repositoryFileHref, parseRepositorySearch, REPOSITORY_PREVIEW_BYTES } from "./spa/src/agentRepositoryMarkdown";
    export { publicAgentRepositoryTransferSource, publicRepositoryClonePrompt, getPublicAgentRepository, syncPublicAgentRepository, refreshPublicAgentRepository } from "./spa/src/agentRepositorySharing";
    export { loadAgentWorkspaceFiles } from "./spa/src/agentWorkspaceTransfer";
    export { zh } from "./spa/src/i18n/zh";
  ` }, bundle: true, platform: "node", format: "esm", jsx: "automatic", write: false,
  plugins: [{ name: "sharing-adapters", setup(builder) {
    const api = `export class ApiError extends Error { constructor(status,message,code) { super(message);this.status=status;this.code=code; } }
      export const AGENT_WORKSPACE_QUERY_KEY=['agent-workspace'];
      export const apiJson=(...args)=>globalThis.__sharingTest.api(...args);
      export const getAgentWorkspaceSettings=async()=>({enabled:globalThis.__sharingTest.enabled});
      export const getAgentWorkspace=()=>{globalThis.__sharingTest.privateCalls++;throw new Error('Private API used');};
      export const getAgentWorkspaceFile=getAgentWorkspace;`;
    const adapters = {
      "../api": api, "./api": api,
      "../auth": `import {useSyncExternalStore} from 'react';
        const subscribe=(listener)=>{globalThis.__sharingTest.routeListeners.add(listener);return ()=>globalThis.__sharingTest.routeListeners.delete(listener);};
        // The session can change while the same repository route stays mounted.
        // useSyncExternalStore needs a stable snapshot per user.
        let seen, snapshot;
        const read=()=>{const user=globalThis.__sharingTest.user;if(user!==seen){seen=user;snapshot={data:{user}};}return snapshot;};
        export const useSession=()=>useSyncExternalStore(subscribe,read);`,
      "../i18n": "export const useI18n=()=>({t:globalThis.__sharingTest.labels,locale:'zh'});",
      "../confirmAction": "export const confirmAction=(...args)=>globalThis.__sharingTest.confirm(...args);",
      "../desktop/runtime": "export const isDesktopRuntime=()=>false;",
      "./desktop/runtime": "export const isDesktopRuntime=()=>false;",
      "../modalStack": "export const pushModal=()=>()=>{};",
      "@tanstack/react-router": `import {createElement,useSyncExternalStore} from 'react';
        import {defaultStringifySearch} from '@tanstack/router-core';
        export {defaultStringifySearch};
        const subscribe=(listener)=>{globalThis.__sharingTest.routeListeners.add(listener);return ()=>globalThis.__sharingTest.routeListeners.delete(listener);};
        // The real router keeps the page mounted while only the id changes, so the
        // fixture must publish a new subscribed snapshot rather than a constant.
        // useSyncExternalStore also requires a stable object per id.
        let seenId, paramsSnapshot;
        const readParams=()=>{const repositoryId=globalThis.__sharingTest.repositoryId;if(repositoryId!==seenId){seenId=repositoryId;paramsSnapshot={repositoryId};}return paramsSnapshot;};
        export const useParams=()=>useSyncExternalStore(subscribe,readParams);
        export const useSearch=({from}={})=>useSyncExternalStore(subscribe,()=>globalThis.__sharingTest[from==='/repositories'?'directorySearch':'search']);
        export const useNavigate=()=>globalThis.__sharingTest.navigate;
        export const useRouterState=({select})=>select({location:{pathname:'/repositories/7',hash:globalThis.__sharingTest.hash??''}});
        export const Link=({to,params,search,children,...props})=>createElement('a',{...props,href:to.replace('$repositoryId',params?.repositoryId??'')+defaultStringifySearch(search??{})},children);`,
    };
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(adapters,path) ? {path:path==='./api'?'../api':path,namespace:'sharing'} : undefined);
    builder.onLoad({ filter: /.*/, namespace: "sharing" }, ({path})=>({contents:adapters[path]}));
    builder.onResolve({ filter: /^(?:react(?:-dom)?(?:\/|$)|@tanstack\/(?:react-query|router-core)$|lucide-react$)/ }, ({path})=>({path:pathToFileURL(require.resolve(path)).href,external:true}));
  }}],
});
const { createElement, act, createRoot, QueryClient, QueryClientProvider, useQuery, ApiError, githubImportErrorMessage, SystemRepositoriesAdminPanel, AgentGitHubImportForm, AgentGitHubCredentialCard, AgentRepositorySharingCard, AgentPublicRepositoryPage, AgentRepositoryForkNotice, AGENT_REPOSITORY_FORK_NOTICE_QUERY_KEY, AgentPublicRepositoriesPage, RepositoryMarkdown, repositoryResource, repositoryReadme, repositoryPreview, repositoryFileHref, parseRepositorySearch, parseRepositoryDirectorySearch, REPOSITORY_PREVIEW_BYTES, publicAgentRepositoryTransferSource, publicRepositoryClonePrompt, getPublicAgentRepository, syncPublicAgentRepository, refreshPublicAgentRepository, loadAgentWorkspaceFiles, zh } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
h.labels = zh;
const labels = zh.agentWorkspace;
assert.equal(githubImportErrorMessage(new ApiError(503, "GitHub unavailable", "github_temporarily_unavailable"), labels), labels.githubTemporarilyUnavailable, "transient GitHub failures use the dedicated retry message");
assert.equal(githubImportErrorMessage(new ApiError(404, "missing", "github_repository_unavailable"), labels), labels.githubRepositoryUnavailable, "repository failures keep their specific message");
assert.equal(githubImportErrorMessage(new ApiError(503, "archive download failed", "github_temporarily_unavailable"), labels), labels.githubTemporarilyUnavailable, "archive download failures use the retry message");
assert.equal(githubImportErrorMessage(new Error("unknown"), labels), labels.githubImportFailed, "unknown failures keep the generic fallback");
const emptyFilters={q:undefined,source:undefined,category:undefined,koiInstallable:undefined};
const root = createRoot(document.getElementById("root"));
let client;
async function settle() { for (let i=0;i<3;i++) await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));}); }
async function mount(component,props={}) {
  await act(async()=>root.render(null));client?.clear();
  h.repositoryId = "7";
  client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{retry:false,gcTime:Infinity}}});
  await act(async()=>root.render(createElement(QueryClientProvider,{client},createElement(component,props))));await settle();
}
function renderForkDestination(props) {
  root.render(createElement(QueryClientProvider, { client }, createElement(AgentRepositoryForkNotice, props)));
}
function button(label) { const result=[...document.querySelectorAll('button')].find(item=>item.textContent===label);assert.ok(Boolean(result),`Missing button: ${label}`);return result; }
const actionProgress = () => document.querySelector('p[role="status"][aria-live="polite"]');
async function openActions() {
  const trigger = [...document.querySelectorAll('button')].find(item => item.textContent === labels.repositoryActions);
  if (trigger && trigger.getAttribute('aria-expanded') !== 'true') { await act(async()=>trigger.click()); await settle(); }
}
async function actionButton(label) { await openActions(); return button(label); }
async function click(label) {
  if (![...document.querySelectorAll('button')].some(item => item.textContent === label)) await openActions();
  await act(async()=>button(label).click()); await settle();
}
function reactProps(element) { assert.ok(Boolean(element));return element[Object.keys(element).find(key=>key.startsWith('__reactProps'))]; }
async function input(selector,value) { await act(async()=>reactProps(document.querySelector(selector)).onChange({target:{value}}));await settle(); }
async function submit() { await act(async()=>reactProps(document.querySelector('form')).onSubmit({preventDefault(){}}));await settle(); }
async function consent(value) {
  const checkbox=document.querySelector('input[type="checkbox"]');
  const props=checkbox[Object.keys(checkbox).find(key=>key.startsWith('__reactProps'))];
  await act(async()=>props.onChange({target:{checked:value}}));await settle();
}
// Hold one matching request open so a response can resolve after the viewer has
// moved on; the returned release resolves it without replaying the request.
function hold(method, path) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const key = `${method} ${path}`;
  h.gates.set(key, { promise });
  return () => { h.gates.delete(key); release(); };
}
try {
  await mount(AgentRepositorySharingCard,{workspace});
  assert.equal(button(labels.publishSnapshot).disabled,true,"publishing needs explicit consent");
  await consent(true);h.confirmResult=false;await click(labels.publishSnapshot);
  assert.equal(calls.filter(call=>call.method==='PUT').length,0,"cancelled confirmation must not publish");
  h.confirmResult=true;h.failPublish=true;await click(labels.publishSnapshot);
  assert.ok(document.body.textContent.includes(labels.sharingSensitive));
  assert.equal(calls.findLast(call=>call.method==='PUT').body.allowSensitive,undefined,"publication cannot bypass scanning");
  h.failPublish=false;await click(labels.publishSnapshot);
  assert.ok(document.body.textContent.includes(labels.publishedRevision.replace('{revision}','3')));
  assert.equal(button(labels.republishSnapshot).disabled,true,"successful publishing clears consent");
  await click(labels.copyShareLink);
  assert.equal(document.querySelector('textarea')?.value,publicRepository.url,"manual clipboard fallback provides the share link");
  await click(zh.space.syncCancel);
  await click(labels.revokeSharing);
  assert.equal(h.publication,null);assert.ok(document.body.textContent.includes(labels.sharingRevoked));

  // The private detail query remains mounted while publication comes and goes.
  // Its category must not fall back to the pre-publication value after withdrawal.
  h.detailWorkspace={...workspace,category:'other'};
  function SharingWithDetail() {
    const detail=useQuery({queryKey:['agent-workspace',7],queryFn:async()=>({workspace:h.detailWorkspace})});
    return detail.data ? createElement(AgentRepositorySharingCard,{workspace:detail.data.workspace}) : null;
  }
  await mount(SharingWithDetail);
  const categorySelector=`select[aria-label="${labels.hubCategoryLabel}"]`;
  await input(categorySelector,'writing');await consent(true);
  h.failPublish=true;await click(labels.publishSnapshot);
  assert.equal(client.getQueryData(['agent-workspace',7]).workspace.category,'other','failed publication must not change the detail cache');
  h.failPublish=false;await click(labels.publishSnapshot);
  assert.equal(client.getQueryData(['agent-workspace',7]).workspace.category,'writing','publishing refreshes the workspace category');
  // Changing the draft selection before withdrawal must not save that draft.
  await input(categorySelector,'product');await click(labels.revokeSharing);
  assert.equal(reactProps(document.querySelector(categorySelector)).value,'writing','withdrawal keeps the last published category');
  assert.equal(client.getQueryData(['agent-workspace',7]).workspace.category,'writing');
  await consent(true);await click(labels.publishSnapshot);
  assert.equal(calls.findLast(call=>call.method==='PUT'&&call.path.endsWith('/sharing')).body.category,'writing','republishing preserves classification');
  await click(labels.revokeSharing);
  delete h.detailWorkspace;

  h.user={id:2,membershipTier:'free'};
  await mount(AgentPublicRepositoryPage);
  assert.equal(document.querySelector('.repository-markdown h1')?.textContent,'Shared skill','SKILL.md is a rendered fallback when README is absent');
  await click(labels.readmeSource);
  assert.ok(document.querySelector('pre')?.textContent.startsWith('# Shared skill'),'source tab preserves Markdown');
  await click(labels.readmeRendered);
  assert.equal(document.querySelector('.repository-markdown h1')?.textContent,'Shared skill');
  await openActions();
  assert.ok(Boolean(document.querySelector('a[href="/pricing"]')),"free users get the Fork membership entry");
  assert.equal((await actionButton(labels.transferZip)).disabled,false,"free users can clone");
  h.failStar=true;await click(`${labels.starRepository} · 0`);
  assert.ok(document.body.textContent.includes(labels.starFailed));
  h.failStar=false;await click(`${labels.starRepository} · 0`);
  assert.equal(publicRepository.starred,true,"free users can Star");
  await click(`${labels.unstarRepository} · 1`);assert.equal(publicRepository.starred,false);
  h.failClone=true;
  await click(labels.repositoryActions);await click(zh.space.configSnapshots.syncWithAgent);
  assert.ok(document.body.textContent.includes(labels.sharingUnavailable));
  assert.equal(actionProgress(), null, 'a failed Clone clears its pending feedback');
  const failedClone=calls.findLast(call=>call.path.endsWith('/clone')).body;
  h.failClone=false;
  await click(labels.repositoryActions);
  await click(zh.space.configSnapshots.syncWithAgent);
  assert.deepEqual(calls.findLast(call=>call.path.endsWith('/clone')).body,failedClone,"Clone retries preserve the request ID");
  const prompt=document.querySelector('textarea')?.value;
  assert.ok(prompt?.includes(publicRepository.manifestUrl));
  assert.ok(!prompt.includes('Authorization: Bearer'),"public clone must not mint or copy private tokens");
  assert.ok(prompt.includes('untrusted DATA')&&prompt.includes('SHA-256'));
  assert.equal(publicRepository.cloneCount,1,"a failed request followed by a successful retry counts once");
  await click(zh.space.syncCancel);
  h.loseCloneResponse=true;
  await click(labels.repositoryActions);await click(zh.space.configSnapshots.syncWithAgent);
  const nextClone=calls.findLast(call=>call.path.endsWith('/clone')).body;
  assert.notEqual(nextClone.requestId,failedClone.requestId,"a new Clone after success must use a new request ID");
  assert.equal(publicRepository.cloneCount,2,"another Clone on the same page counts separately");
  h.loseCloneResponse=false;
  await click(labels.repositoryActions);await click(zh.space.configSnapshots.syncWithAgent);
  assert.deepEqual(calls.findLast(call=>call.path.endsWith('/clone')).body,nextClone,"retry after a lost success response keeps its request ID");
  assert.equal(publicRepository.cloneCount,2,"a lost response must not make a retry double-count");
  await click(zh.space.syncCancel);

  h.user={id:1,membershipTier:'lifetime'};h.failFork=true;
  await mount(AgentPublicRepositoryPage);
  await click(labels.forkRepository);
  assert.ok(document.body.textContent.includes(labels.forkFailed));
  const first=calls.findLast(call=>call.path.endsWith('/fork')).body;
  h.failFork=false;await click(labels.forkRepository);
  assert.deepEqual(calls.findLast(call=>call.path.endsWith('/fork')).body,first,"retry reuses the Fork request ID");
  assert.equal(navigations.at(-1).params.workspaceId,'8');

  // Progress must remain visible after the menu closes, including preparation
  // before the actual Clone/Fork request and the clipboard write after it.
  for (const [action, progress, cancel] of [
    [labels.transferZip, labels.preparingClone, labels.scanReviewCancel],
    [zh.space.configSnapshots.syncWithAgent, labels.preparingAgentCopy, zh.space.syncCancel],
    [labels.forkRepository, labels.forkingRepository],
  ]) {
    await mount(AgentPublicRepositoryPage);
    const release = hold('POST', '/api/agent/repositories/7/sync?recheck=false');
    await click(action);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(actionProgress()?.textContent, progress, `${action} stays visible outside the closed menu`);
    await act(async()=>release()); await settle();
    assert.equal(actionProgress(), null, `${action} clears progress at completion`);
    if (cancel) await click(cancel);
  }
  await mount(AgentPublicRepositoryPage);
  let finishClipboard;
  const clipboard = navigator.clipboard;
  navigator.clipboard = { writeText: () => new Promise(resolve => { finishClipboard = resolve; }) };
  await click(zh.space.configSnapshots.syncWithAgent);
  assert.equal(typeof finishClipboard, 'function');
  assert.equal(actionProgress()?.textContent, labels.preparingAgentCopy, 'progress covers clipboard work after repository preparation');
  await act(async()=>finishClipboard()); await settle();
  navigator.clipboard = clipboard;
  assert.equal(actionProgress(), null);
  assert.ok(document.body.textContent.includes(labels.copied));

  // Settings may change in another window while the Fork request is pending.
  h.enabled=true;
  await mount(AgentPublicRepositoryPage);
  const beforeDisabledFork=navigations.length;
  const releaseDisabledFork=hold('POST','/api/agent/repositories/7/fork');
  await click(labels.forkRepository);
  assert.equal(actionProgress()?.textContent, labels.forkingRepository);
  h.enabled=false;
  await act(async()=>releaseDisabledFork());await settle();
  assert.equal(actionProgress(), null, 'a rejected Fork clears progress');
  assert.equal(document.querySelector('[role="alert"]')?.textContent,labels.forkEnable,'disabled sync explains how to enable Fork again');
  assert.ok(!document.body.textContent.includes(labels.forkFailed),'disabled sync must not blame repository capacity');
  assert.equal((await actionButton(labels.forkRepository)).disabled,true,'the refreshed setting disables new Fork attempts');
  assert.equal(navigations.length,beforeDisabledFork,'a rejected Fork never navigates');
  const disabledFork=calls.findLast(call=>call.path.endsWith('/fork')).body;
  h.enabled=true;
  await act(async()=>client.invalidateQueries({queryKey:['agent-workspace-settings']}));await settle();
  await click(labels.forkRepository);
  assert.deepEqual(calls.findLast(call=>call.path.endsWith('/fork')).body,disabledFork,'reenabling can safely retry the rejected request');
  assert.equal(navigations.at(-1).params.workspaceId,'8');

  h.enabled=false;
  await mount(AgentPublicRepositoryPage);
  assert.equal((await actionButton(labels.forkRepository)).disabled,true);assert.ok(document.body.textContent.includes(labels.forkEnable));
  h.user=null;
  await mount(AgentPublicRepositoriesPage);
  assert.ok(Boolean(document.querySelector('a[href="/repositories/7"]')),"public list works without a user session");

  const source={repositoryUrl:'https://github.com/example/skills',author:'example',authorUrl:'https://github.com/example',commitSha:'a'.repeat(40),license:'MIT',ref:'main'};
  const snapshotFiles=[{...workspace.files[0],fileId:30,path:'README.md'},{...workspace.files[0],fileId:31,path:'docs/使用指南.md'},{...workspace.files[0],fileId:32,path:'images/logo.png',mimeType:'image/png'}];
  assert.equal(repositoryReadme(snapshotFiles).fileId,30);
  assert.equal(repositoryReadme([{...snapshotFiles[0],path:'.github/README.md'}]).path,'.github/README.md');
  assert.equal(repositoryResource('../images/logo.png','docs/使用指南.md',snapshotFiles,source,true).file.fileId,32);
  assert.equal(repositoryResource('docs/%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97.md#安装','README.md',snapshotFiles,source).file.fileId,31);
  assert.equal(repositoryResource('missing.md','README.md',snapshotFiles,source).href,source.repositoryUrl+'/blob/'+source.commitSha+'/missing.md');
  assert.equal(repositoryResource('docs','README.md',snapshotFiles,source).href,source.repositoryUrl+'/tree/'+source.commitSha+'/docs');
  for(const bad of ['javascript:alert(1)','data:text/html,x','file:///etc/passwd','https://user:password@example.org','/api/auth/logout','\\\\evil.com/a']) {
    assert.equal(repositoryResource(bad,'README.md',snapshotFiles),undefined,`unsafe or unknown app-local resource: ${bad}`);
  }
  assert.equal(repositoryResource('http://example.org/logo.png','README.md',[],undefined,true),undefined);
  assert.equal(repositoryResource('missing.png','README.md',[],{...source,private:true},true),undefined,'private upstream images are not requested');
  const cut=repositoryPreview(Buffer.concat([Buffer.alloc(REPOSITORY_PREVIEW_BYTES-1,65),Buffer.from('中文')]).toString('base64'));
  assert.equal(cut.truncated,true);assert.ok(!cut.text.includes('\ufffd'),'truncation respects UTF-8 boundaries');
  assert.equal(repositoryPreview(Buffer.from([0,1,2]).toString('base64')).binary,true);
  const opened=[];
  await mount(RepositoryMarkdown,{repository:{...publicRepository,files:snapshotFiles,githubSource:source},onOpenFile:(...args)=>opened.push(args),content:`# Guide\n\n## 安装\n\n## 安装\n\n| Tool | Use |\n| --- | --- |\n| Agent | **Skills** |\n\n- [x] Ready\n- [ ] Pending\n\n> Review first\n\n\`\`\`js\nconst value = "safe";\n\`\`\`\n\n[Guide](docs/使用指南.md#安装) · [Section](#安装) · [External](https://example.org)\n\n<details><summary>More</summary>Details</details>\n<p align="center"><img src="https://example.org/badge.svg" alt="Badge" onerror="alert(1)"></p>\n<picture><source srcset="/api/unresolved-resource 1x"><img src="https://example.org/safe.png"></picture><script>alert(1)</script><iframe src="https://evil.example"></iframe><a href="javascript:alert(1)">Bad</a><form><input name="location"></form>`});
  assert.equal(document.querySelectorAll('.repository-markdown table tbody tr').length,1);
  assert.equal(document.querySelectorAll('.repository-markdown .task-list-item input[type="checkbox"][disabled]').length,2);
  assert.equal(document.querySelector('h2')?.id,'user-content-安装');
  assert.equal(document.querySelectorAll('h2')[1]?.id,'user-content-安装-1');
  assert.ok(document.querySelector('pre code .hljs-keyword'),'code is highlighted');
  assert.ok(document.querySelector('details summary'));
  assert.equal(document.querySelector('p[align="center"] img').getAttribute('referrerPolicy'),'no-referrer');
  assert.equal(document.querySelectorAll('script,iframe,form,source,[onerror],a[href^="javascript:"]').length,0,'embedded HTML cannot execute or submit');
  assert.equal([...document.querySelectorAll('a')].find(a=>a.textContent==='External').rel,'noopener noreferrer');
  assert.equal([...document.querySelectorAll('a')].find(a=>a.textContent==='Section').getAttribute('href'),repositoryFileHref(7,'README.md','安装'));
  assert.equal([...document.querySelectorAll('a')].find(a=>a.textContent==='Guide').getAttribute('href'),repositoryFileHref(7,'docs/使用指南.md','安装'));
  const guideProps=reactProps([...document.querySelectorAll('a')].find(a=>a.textContent==='Guide'));
  guideProps.onClick({button:0,metaKey:true,preventDefault(){throw new Error('Command-click must keep native navigation');}});
  assert.equal(opened.length,0);
  await act(async()=>guideProps.onClick({button:0,preventDefault(){}}));
  assert.equal(opened[0][0],31,'relative Markdown links open snapshot files');
  await mount(RepositoryMarkdown,{content:'A note[^a].\n\n[^a]: Footnote text.\n\n<a name="legacy"></a>\n\n[Legacy anchor](#legacy)'});
  for(const anchor of document.querySelectorAll('.repository-markdown a[href^="#"]')) {
    assert.ok(document.getElementById(decodeURIComponent(anchor.getAttribute('href').slice(1))),'footnote references and back references reach sanitized IDs');
  }

  assert.deepEqual(parseRepositorySearch({file:'docs/使用指南.md'}),{...emptyFilters,file:'docs/使用指南.md'});
  assert.deepEqual(parseRepositorySearch({file:['README.md']}),{...emptyFilters,file:undefined});
  assert.equal(parseRepositorySearch({ installKoi: true }).installKoi, true);
  assert.equal(parseRepositorySearch({ installKoi: ['true'] }).installKoi, undefined);
  const beforeKoiUser = h.user;
  h.user = null;
  const loginContext = { koiInstallable: true, file: publicRepository.files[0].path, q: '写作 & review', source: 'system', category: 'writing' };
  const loginHash = 'user-content-安装 & 配置';
  h.search = loginContext; h.hash = loginHash;
  await mount(AgentPublicRepositoryPage);
  const installLogin = [...document.querySelectorAll('a')].find(a => a.textContent.includes(zh.koi.installToKoi));
  assert.ok(installLogin, 'anonymous visitors can return to the Hub installation after login');
  const loginReturn = new URL(new URL(installLogin.getAttribute('href'), 'https://koinote.example').searchParams.get('redirectTo'), 'https://koinote.example');
  assert.equal(loginReturn.pathname, '/repositories/7');
  assert.deepEqual(Object.fromEntries(loginReturn.searchParams), { ...loginContext, koiInstallable: 'true', installKoi: 'true' }, 'login retains the file and Hub filters');
  assert.equal(decodeURIComponent(loginReturn.hash.slice(1)), loginHash, 'login retains the document anchor');
  h.user = { id: 1, authUserId: 'hub-viewer', membershipTier: 'lifetime' };
  h.koiAvailable = true; h.search = { ...loginContext, installKoi: true };
  const koiCreates = calls.filter(call => call.path === '/api/koi/skill-imports').length;
  const koiConfirms = calls.filter(call => call.path.endsWith('/confirm')).length;
  await mount(AgentPublicRepositoryPage);
  assert.ok(document.querySelector('[role="dialog"]'), 'login return opens the install preview');
  assert.equal(h.search.installKoi, undefined, 'login intent is consumed once');
  assert.deepEqual(h.search, loginContext, 'consuming the install intent retains the file and Hub filters');
  assert.equal(h.hash, loginHash, 'consuming the install intent retains the anchor');
  assert.equal(calls.filter(call => call.path === '/api/koi/skill-imports').length, koiCreates + 1);
  const koiInput = calls.findLast(call => call.path === '/api/koi/skill-imports').body;
  assert.equal(koiInput.publicationId, publicRepository.publicationId);
  assert.equal(koiInput.revision, publicRepository.revision);
  assert.equal(calls.filter(call => call.path.endsWith('/confirm')).length, koiConfirms, 'returning from login never auto-confirms an install');
  await click(zh.koi.cancel);
  // Read account-scoped installations and keep the action current after changes.
  h.search = {}; h.hash = '';
  const installedSkill = { id: 'installed-hub-skill', name: 'demo', sourceKind: 'hub', source: { workspaceId: 7, path: '.codex/skills/demo' }, enabled: false, entryPath: 'SKILL.md' };
  h.koiSkills = [];
  h.koiCandidates = [{ id: 'demo', name: 'demo', description: 'Review writing', license: 'MIT', entryPath: 'SKILL.md', fileCount: 1, sizeBytes: 100, instructions: '# Demo', compatibility: { conversation: true, article: true }, metadataFormat: 'agent-skills' }];
  h.koiInstallResult = [installedSkill];
  await mount(AgentPublicRepositoryPage);
  assert.ok(button(zh.koi.installToKoi), 'an uninstalled repository offers installation as the primary action');
  assert.equal(document.querySelector('[role="menu"]'), null, 'secondary actions start collapsed');
  assert.equal(document.querySelector('button[aria-haspopup="menu"]').textContent, labels.repositoryActions, 'one menu replaces separate Clone/Fork controls');
  await click(zh.koi.installToKoi);
  await click(zh.koi.confirmInstall.replace('{count}', '1'));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.ok(button(zh.koi.alreadyInstalled), 'installation immediately refreshes the Hub action');
  assert.equal(button(zh.koi.alreadyInstalled).disabled, false, 'disabled Skills are still installed and can be reviewed');
  await click(zh.koi.alreadyInstalled);
  assert.ok(document.querySelector('[role="dialog"]'), 'installed status keeps review/update available');
  await click(zh.koi.cancel);
  const statusFiles = publicRepository.files;
  const createsBeforeReview = calls.filter(call => call.path === '/api/koi/skill-imports').length;
  publicRepository.files = [...statusFiles, { ...statusFiles[0], path: 'another/SKILL.md', fileId: 22 }];
  await act(async()=>client.invalidateQueries({queryKey:['public-agent-repository',7]})); await settle();
  assert.ok(button(zh.koi.installedCount.replace('{count}','1')), 'extra SKILL.md files are not treated as a verified installable total');
  // Only preview validation can establish compatibility. A mixed collection
  // must not tell users to install a rejected Skill to complete an impossible 1/2.
  const validHubCandidate = h.koiCandidates[0];
  h.koiCandidates = [{ ...validHubCandidate, installedStatus: 'installed' }];
  h.koiRejected = [{ entryPath: 'another/SKILL.md', directory: 'another', reason: 'incompatible' }];
  assert.equal(createsBeforeReview, calls.filter(call => call.path === '/api/koi/skill-imports').length, 'status rendering does not scan the repository');
  await click(zh.koi.installedCount.replace('{count}','1'));
  assert.equal(document.querySelectorAll('input[name="preview-candidate"]').length, 1);
  assert.ok(document.querySelector('[role="dialog"]').textContent.includes(zh.koi.reject_incompatible));
  assert.equal(button(zh.koi.confirmInstall.replace('{count}','0')).disabled, true, 'installed-only candidates need no repeated confirmation');
  await click(zh.koi.cancel);
  h.koiSkills = [];
  await act(async()=>client.invalidateQueries({queryKey:['koi-skills','hub-viewer']})); await settle();
  assert.ok(button(zh.koi.installToKoi), 'removing the Skill restores the installation action without promising compatibility');
  h.koiCandidates = [];
  await click(zh.koi.installToKoi);
  assert.ok(document.querySelector('[role="dialog"]').textContent.includes(zh.koi.koiNoSkills), 'all-rejected repositories explain why nothing can be installed');
  assert.ok(document.querySelector('[role="dialog"]').textContent.includes(zh.koi.reject_incompatible));
  assert.equal(document.querySelector('[role="dialog"] input[name="preview-candidate"]'), null);
  assert.equal(document.querySelectorAll('[role="dialog"] footer button').length, 2, 'an all-rejected preview only offers restart and cancel');
  await click(zh.koi.cancel);
  h.koiCandidates = [validHubCandidate]; delete h.koiRejected;
  publicRepository.files = Array.from({length:21},(_,index)=>({...statusFiles[0],path:`skills/${index}/SKILL.md`,fileId:100+index}));
  h.koiSkills = publicRepository.files.map((file,index)=>({...installedSkill,id:`installed-${index}`,source:{workspaceId:7,path:`skills/${index}`}}));
  await mount(AgentPublicRepositoryPage);
  assert.ok(button(zh.koi.alreadyInstalled), 'status includes installations beyond the first 20');
  assert.ok(calls.some(call=>call.path.startsWith('/api/koi/skills?')&&new URL(call.path,'https://koinote.example').searchParams.get('cursor')==='20'));
  h.koiSkillsByUser = { 'hub-viewer': h.koiSkills, 'another-viewer': [] };
  await act(async()=>h.setUser({ id: 9, authUserId: 'another-viewer', membershipTier: 'lifetime' })); await settle();
  assert.ok(button(zh.koi.installToKoi), 'switching accounts never reuses the previous installation status');
  const statusGate = hold('GET', '/api/koi/skills?q=&source=hub&state=&cursor=&hubWorkspaceId=7');
  await mount(AgentPublicRepositoryPage);
  assert.equal(button(zh.koi.installToKoi).disabled, false, 'a pending status lookup does not block opening the install preview');
  await click(zh.koi.installToKoi);
  assert.ok(document.querySelector('[role="dialog"]'), 'the install preview remains available while status is loading');
  await click(zh.koi.cancel);
  statusGate(); await settle();
  h.koiSkillsError = true;
  await act(async()=>client.invalidateQueries({queryKey:['koi-skills','another-viewer']})); await settle();
  assert.ok(document.body.textContent.includes(zh.koi.installStatusUnavailable), 'a failed status read is distinguished from not installed');
  await click(zh.koi.installToKoi);
  assert.ok(document.querySelector('[role="dialog"]'), 'a failed status lookup does not block reviewing the repository');
  await click(zh.koi.cancel);
  await click(zh.koi.retry);
  h.koiSkillsError = false;
  await click(zh.koi.retry);
  assert.equal(document.querySelector('[role="dialog"]'), null, 'retrying status only refreshes the status');
  assert.equal(document.body.textContent.includes(zh.koi.installStatusUnavailable), false, 'a successful status retry clears the error');
  publicRepository.files = statusFiles;
  h.user = { id: 1, authUserId: 'hub-viewer', membershipTier: 'lifetime' };
  delete h.koiSkillsByUser; delete h.koiSkills; delete h.koiCandidates; delete h.koiInstallResult;

  h.koiAvailable = false; h.search = { installKoi: true };
  const importsBeforeRestriction = calls.filter(call => call.path === '/api/koi/skill-imports').length;
  await mount(AgentPublicRepositoryPage);
  assert.ok(document.querySelector('[role="dialog"]'), 'the entry remains visible while the dialog explains account availability');
  assert.ok(document.body.textContent.includes(zh.koi.koiUnavailable), 'accounts outside rollout receive an explanation');
  assert.equal(calls.filter(call => call.path === '/api/koi/skill-imports').length, importsBeforeRestriction, 'an unavailable account never starts source analysis');
  await click(zh.koi.cancel);
  assert.equal(button(zh.koi.installToKoi).disabled, false, 'the member entry remains available when account permissions are unresolved or unavailable');
  await click(zh.koi.installToKoi);
  assert.ok(document.querySelector('[role="dialog"]').textContent.includes(zh.koi.koiUnavailable), 'ordinary entry explains a confirmed rollout restriction');
  assert.equal(calls.filter(call => call.path === '/api/koi/skill-imports').length, importsBeforeRestriction, 'opening a restricted entry never starts source analysis');
  await click(zh.koi.cancel);

  // Overview failures are recoverable read errors, not permission denials.
  // Login return keeps its snapshot/context while the shared read is pending.
  h.koiAvailable = true; h.koiOverviewError = true;
  h.search = { ...loginContext, installKoi: true }; h.hash = loginHash;
  const overviewGate = hold('GET', '/api/koi/settings');
  await mount(AgentPublicRepositoryPage);
  assert.ok(document.querySelector('[role="dialog"] [role="status"]'), 'login return opens a waiting dialog before permission is known');
  assert.equal(calls.filter(call => call.path === '/api/koi/skill-imports').length, importsBeforeRestriction, 'pending permission never starts source analysis');
  assert.deepEqual(h.search, loginContext, 'login intent is consumed without losing the selected file or Hub filters');
  assert.equal(h.hash, loginHash);
  overviewGate(); await settle();
  assert.ok(document.querySelector('[role="dialog"]').textContent.includes(zh.koi.loadFailed), 'a failed permission read is not misreported as a rollout restriction');
  assert.equal(document.body.textContent.includes(zh.koi.koiUnavailable), false);
  await click(zh.koi.retry);
  h.koiOverviewError = false;
  await click(zh.koi.retry);
  assert.equal(calls.filter(call => call.path === '/api/koi/skill-imports').length, importsBeforeRestriction + 1, 'successful permission retry resumes source analysis exactly once');
  assert.equal(calls.filter(call => call.path.endsWith('/confirm')).length, koiConfirms + 1, 'permission recovery never auto-confirms installation');
  assert.equal(calls.findLast(call => call.path === '/api/koi/skill-imports').body.publicationId, publicRepository.publicationId);
  await click(zh.koi.cancel);

  h.koiOverviewError = true; h.search = {}; h.hash = '';
  await mount(AgentPublicRepositoryPage);
  assert.equal(button(zh.koi.installToKoi).disabled, false, 'an initial overview failure keeps the preview entry usable');
  assert.ok(document.body.textContent.includes(zh.koi.loadFailed), 'ordinary visits also expose an explicit permission-read retry');
  const importsBeforeRecovery = calls.filter(call => call.path === '/api/koi/skill-imports').length;
  await click(zh.koi.retry);
  h.koiOverviewError = false;
  await click(zh.koi.retry);
  assert.equal(document.body.textContent.includes(zh.koi.loadFailed), false, 'successful retry clears the overview error');
  assert.equal(calls.filter(call => call.path === '/api/koi/skill-imports').length, importsBeforeRecovery, 'a page-level status retry does not open or install anything');
  await click(zh.koi.installToKoi);
  assert.ok(document.querySelector('[role="dialog"]'), 'the install path works after recovering the permission read');
  await click(zh.koi.cancel);
  const filesBeforeEmpty = publicRepository.files;
  publicRepository.files = [{ ...filesBeforeEmpty[0], path: 'README.md' }]; h.koiAvailable = true; h.search = { installKoi: true };
  const createsBeforeEmpty = calls.filter(call => call.path === '/api/koi/skill-imports').length;
  await mount(AgentPublicRepositoryPage);
  assert.ok(document.body.textContent.includes(zh.koi.noInstallableSkills), 'repositories without Skills explain why installation is unavailable');
  assert.equal(document.body.textContent.includes(zh.koi.koiUnavailable), false, 'missing Skills are not reported as an account restriction');
  assert.equal(calls.filter(call => call.path === '/api/koi/skill-imports').length, createsBeforeEmpty, 'an empty repository never starts an install preview');
  h.user = null;
  await mount(AgentPublicRepositoryPage);
  assert.ok(document.body.textContent.includes(zh.koi.noInstallableSkills), 'anonymous visitors also see the empty repository explanation');
  assert.equal([...document.querySelectorAll('a')].some(a => a.textContent.includes(zh.koi.installToKoi)), false);
  // A linked entry has no mirrored manifest. It still opens the existing
  // GitHub preview, while installed state is scoped to the GitHub numeric ID.
  const sourceBeforeLink = publicRepository.githubSource;
  publicRepository.githubSource = { repositoryId: 123, repositoryUrl: 'https://github.com/Octo/demo', author: 'Octo', authorUrl: 'https://github.com/Octo', ref: 'main', commitSha: 'a'.repeat(40), license: 'UNLICENSED', linkOnly: true };
  // An older server/client negotiation may return the compatibility guide.
  // The current page must still use the GitHub installation, without reading
  // or treating that guide as an upstream Skill.
  const legacyGuideBytes = Buffer.from('# GitHub link\n\n[在网页版安装到 Koi AI](https://koinote.example/repositories/7?installKoi=true) · [下载新版客户端](https://koinote.example/download)');
  const legacyGuideFile = { fileId: 1, path: 'README.md', mimeType: 'text/markdown', sizeBytes: legacyGuideBytes.length, sha256: createHash('sha256').update(legacyGuideBytes).digest('hex') };
  publicRepository.files = [legacyGuideFile];
  await mount(RepositoryMarkdown, { repository: publicRepository, filePath: repositoryReadme(publicRepository.files).path, content: repositoryPreview(legacyGuideBytes.toString('base64')).text });
  const webInstall = [...document.querySelectorAll('a')].find(a => a.textContent === '在网页版安装到 Koi AI');
  assert.equal(webInstall.getAttribute('href'), 'https://koinote.example/repositories/7?installKoi=true');
  assert.equal(webInstall.getAttribute('target'), '_blank', 'legacy README links open the web installation separately');
  assert.ok([...document.querySelectorAll('a')].some(a => a.getAttribute('href') === 'https://koinote.example/download'));
  // The advertised capability covers direct loads and refresh responses.
  const originalAPI = h.api;
  const negotiated = [];
  h.api = async (path, init = {}) => { negotiated.push(init); return { repository: publicRepository, sync: { status: 'skipped', code: 'link_only' } }; };
  try {
    await getPublicAgentRepository(7);
    await syncPublicAgentRepository(7);
    await refreshPublicAgentRepository(publicRepository);
  } finally { h.api = originalAPI; }
  assert.equal(negotiated.length, 3);
  assert.ok(negotiated.every(init => init.headers['X-Koinote-Repository-Links'] === '1'));
  const readsBeforeLink = calls.filter(call => call.path.includes('/files/')).length;
  h.user = { ...beforeKoiUser, membershipTier: 'lifetime' }; h.search = {}; h.koiAvailable = true;
  h.koiSkills = [{ id: 'github-skill', sourceKind: 'github', source: { repositoryId: 123, path: 'review' }, enabled: true }];
  await mount(AgentPublicRepositoryPage);
  assert.ok(button(zh.koi.installedCount.replace('{count}', '1')), 'linked entries show installed GitHub Skills without claiming all are installed');
  assert.ok(document.body.textContent.includes(labels.hubGitHubLinkDescription));
  assert.equal(calls.filter(call => call.path.includes('/files/')).length, readsBeforeLink, 'current clients never fetch a hidden compatibility README');
  assert.equal(document.body.textContent.includes(zh.koi.noInstallableSkills), false);
  assert.equal(document.body.textContent.includes(labels.githubImportedCopy), false);
  publicRepository.files = [];
  await mount(AgentPublicRepositoryPage);
  assert.ok(button(zh.koi.installedCount.replace('{count}', '1')), 'the negotiated empty link manifest keeps its installation entry');
  await click(zh.koi.installedCount.replace('{count}', '1'));
  const linkInput = calls.findLast(call => call.path === '/api/koi/skill-imports').body;
  assert.equal(linkInput.source, 'github');
  assert.equal(linkInput.repositoryUrl, 'https://github.com/Octo/demo');
  assert.equal(linkInput.ref, 'main');
  assert.equal(linkInput.workspaceId, undefined, 'links must never use the empty Hub snapshot');
  await click(zh.koi.startOver);
  const directoryInput = [...document.querySelectorAll('form details input')][1];
  await act(async () => reactProps(directoryInput).onChange({ target: { value: 'review' } })); await settle();
  await submit();
  assert.equal(calls.findLast(call => call.path === '/api/koi/skill-imports').body.path, 'review', 'a linked repository can be retried with a selected subdirectory');
  await click(zh.koi.cancel);
  h.koiSkills = [];
  await mount(AgentPublicRepositoryPage);
  assert.ok(button(zh.koi.installToKoi));
  assert.equal([...document.querySelectorAll('button')].some(item => item.textContent === labels.forkRepository), false);
  assert.equal([...document.querySelectorAll('button')].some(item => item.textContent === labels.syncGitHub), false);
  delete h.koiSkills;
  publicRepository.githubSource = sourceBeforeLink;
  publicRepository.files = filesBeforeEmpty;
  h.user = beforeKoiUser; h.search = {}; h.hash = ''; delete h.koiAvailable;
  assert.deepEqual(parseRepositoryDirectorySearch({q:'  skills  ',source:'system',category:'design',file:'README.md'}),{...emptyFilters,q:'skills',source:'system',category:'design'});
  assert.deepEqual(parseRepositoryDirectorySearch({q:['skills'],source:'admin',category:'invalid'}),emptyFilters);
  assert.deepEqual(parseRepositoryDirectorySearch({q:'x'.repeat(81),source:['system'],category:['design']}),emptyFilters);
  assert.equal(parseRepositoryDirectorySearch({q:'🛠'.repeat(80)}).q,'🛠'.repeat(80),'search validation uses the backend character limit');
  const guideBytes=Buffer.from('# 使用指南\n\n## 安装\n\nInstructions.');
  const guideFile={...snapshotFiles[1],sha256:createHash('sha256').update(guideBytes).digest('hex'),contentBase64:guideBytes.toString('base64')};
  h.extraFiles={'/api/agent/repositories/7/files/31?revision=3':guideFile};
  const originalFiles=publicRepository.files;
  publicRepository.files=[...originalFiles,guideFile];
  h.search={file:guideFile.path};h.hash='user-content-安装';
  await mount(AgentPublicRepositoryPage);
  assert.equal(document.querySelector('.repository-markdown h1')?.textContent,'使用指南','direct file links survive a reload');
  await click(labels.readmeBack);
  assert.equal(navigations.at(-1).search.file,originalFiles[0].path,'file actions update the URL');
  h.search={};h.hash='';
  await mount(AgentPublicRepositoryPage);
  assert.equal(document.querySelector('.repository-markdown h1')?.textContent,'Shared skill','restoring a URL without a file restores README');
  publicRepository.files=originalFiles;

  const observers=[];
  globalThis.IntersectionObserver=class {
    constructor(callback){this.callback=callback;observers.push(this);}
    observe(element){this.element=element;}
    disconnect(){this.disconnected=true;}
  };
  const imageFile={...snapshotFiles[2],contentBase64:Buffer.from('image fixture').toString('base64')};
  h.extraFiles['/api/agent/repositories/7/files/32?revision=3']=imageFile;
  const imageCalls=()=>calls.filter(call=>call.path.includes('/files/32?')).length;
  const beforeImage=imageCalls();
  await mount(RepositoryMarkdown,{repository:{...publicRepository,files:snapshotFiles},content:'![Logo](images/logo.png)\n\n![Not an image](docs/使用指南.md)'});
  assert.equal(imageCalls(),beforeImage,'offscreen snapshot images are not downloaded');
  const guideCalls=calls.filter(call=>call.path.includes('/files/31?')).length;
  assert.equal(observers.length,1,'non-image files are never observed or fetched as images');
  await act(async()=>observers[0].callback([{isIntersecting:true}]));await settle();
  assert.equal(imageCalls(),beforeImage+1);
  assert.equal(calls.filter(call=>call.path.includes('/files/31?')).length,guideCalls);
  assert.ok(document.querySelector('img[src^="blob:"]'),'visible snapshot images render with a blob URL');
  const originalRevoke=URL.revokeObjectURL,revoked=[];
  URL.revokeObjectURL=(url)=>{revoked.push(url);originalRevoke(url);};
  await mount(RepositoryMarkdown,{content:'Done'});
  URL.revokeObjectURL=originalRevoke;
  assert.equal(revoked.length,1,'unmount releases the image blob');
  assert.ok(observers[0].disconnected);
  delete globalThis.IntersectionObserver;h.extraFiles=undefined;

  const files=await loadAgentWorkspaceFiles(publicRepository,new Set([21]),()=>{},undefined,publicAgentRepositoryTransferSource(publicRepository));
  assert.equal(Buffer.from(files[0].bytes).toString(),bytes.toString());
  assert.equal(h.privateCalls,0,"public clone must only read the public snapshot endpoints");
  h.withdrawn=true;
  await assert.rejects(()=>loadAgentWorkspaceFiles(publicRepository,new Set([21]),()=>{},undefined,publicAgentRepositoryTransferSource(publicRepository)),error=>error.code==='transferChanged');
  assert.ok(publicRepositoryClonePrompt(publicRepository).includes('revision=3'));
  h.withdrawn=false;h.publication=publicRepository;h.privateRevision=4;h.revokePublic=true;
  h.user={id:1,membershipTier:'free'};h.enabled=false;
  await mount(AgentPublicRepositoryPage);
  assert.equal((await actionButton(labels.revokeSharing)).disabled,false,"authors retain withdrawal after sync/membership is disabled");
  const releaseWithdraw = hold('DELETE', '/api/agent/workspaces/7/sharing');
  await click(labels.revokeSharing);
  assert.equal(actionProgress()?.textContent, labels.withdrawingSharing, 'withdrawal progress remains visible after the menu closes');
  await act(async()=>releaseWithdraw()); await settle();
  assert.equal(actionProgress(), null, 'withdrawal clears progress after completion');
  assert.equal(calls.findLast(call=>call.method==='DELETE').body.expectedRevision,4,"withdrawal uses the private workspace's latest revision");
  assert.ok(document.body.textContent.includes(labels.sharingUnavailable));

  h.withdrawn=false;h.publication=null;h.privateRevision=undefined;h.revokePublic=false;h.user={id:1,membershipTier:'lifetime'};h.enabled=true;
  await mount(AgentGitHubImportForm,{onClose(){}});
  assert.equal(button(labels.githubImport).disabled,true);
  h.failImport=true;
  await input('input[type="url"]','https://github.com/Octo/demo');await submit();
  assert.ok(document.body.textContent.includes(labels.githubSensitive),"sensitive imports have a visible error");
  const failedImport=calls.findLast(call=>call.path.endsWith('/import/github')).body;
  assert.match(failedImport.requestId,/^[0-9a-f-]{36}$/);
  assert.equal(failedImport.repositoryUrl,'https://github.com/Octo/demo');
  assert.equal(failedImport.author,undefined,"client does not supply GitHub attribution");
  await submit();
  assert.deepEqual(calls.findLast(call=>call.path.endsWith('/import/github')).body,failedImport,"import retry reuses its request ID");
  await input('input:not([type="url"])','feature/import');await submit();
  const changedImport=calls.findLast(call=>call.path.endsWith('/import/github')).body;
  assert.notEqual(changedImport.requestId,failedImport.requestId,"changed inputs require a new import ID");
  h.failImport=false;await submit();
  assert.deepEqual(calls.findLast(call=>call.path.endsWith('/import/github')).body,changedImport);
  assert.equal(navigations.at(-1).params.workspaceId,'9');

  await mount(AgentGitHubCredentialCard);
  const secret='github-test-token-9876';
  await click(labels.githubTokenAdd);
  await input('input[type="password"]',secret);await submit();
  assert.equal(document.querySelector('input[type="password"]'),null,"save closes the credential editor");
  await click(labels.githubTokenEdit);
  assert.equal(document.querySelector('input[type="password"]').value,'',"reopening the editor never reveals the saved credential");
  assert.ok(document.body.textContent.includes('••••9876'));
  assert.ok(!document.body.textContent.includes(secret));
  const credentialDeletes=()=>calls.filter(call=>call.path==='/api/agent/github-credential'&&call.method==='DELETE').length;
  h.confirmResult=false;await click(labels.githubTokenRemove);assert.equal(credentialDeletes(),0);
  h.confirmResult=true;await click(labels.githubTokenRemove);assert.equal(credentialDeletes(),1);
  assert.ok(document.body.textContent.includes(labels.githubTokenNotConfigured));

  const githubSource={repositoryUrl:'https://github.com/Octo/demo',author:'Octo',authorUrl:'https://github.com/Octo',ref:'main',commitSha:'a'.repeat(40),license:'MPL-2.0'};
  workspace.githubSource=githubSource;publicRepository.githubSource=githubSource;
  await mount(AgentRepositorySharingCard,{workspace});
  assert.equal(document.querySelector('select').value,'MPL-2.0',"original GitHub license is the publishing default");
  assert.equal(document.querySelector('a[href="https://github.com/Octo"]')?.textContent,'Octo');
  await consent(true);await click(labels.publishSnapshot);
  assert.equal(calls.findLast(call=>call.path.endsWith('/sharing')&&call.method==='PUT').body.license,'MPL-2.0');
  h.user=null;
  for (const component of [AgentPublicRepositoryPage,AgentPublicRepositoriesPage]) {
    await mount(component);
    assert.equal(document.querySelector('a[href="https://github.com/Octo"]')?.textContent,'Octo',"public attribution names the GitHub owner");
    assert.ok(Boolean(document.querySelector('a[href="https://github.com/Octo/demo"]')),"public views link to the original repository");
  }
  const githubPrompt=publicRepositoryClonePrompt(publicRepository);
  assert.ok(githubPrompt.includes(githubSource.repositoryUrl)&&githubPrompt.includes(githubSource.author)&&githubPrompt.includes(githubSource.commitSha));
  assert.ok(!githubPrompt.includes(secret));

  for(const [locale,fragment] of [['en','Clone this'],['zh','同步到本机'],['fr','Synchronisez'],['ja','既存ファイルと統合']]) {
    const prompt=publicRepositoryClonePrompt(publicRepository,locale);
    for(const required of [fragment,'SHA-256','64 MiB','10,000','404/409','429','Retry-After','LICENSE','NOTICE',githubSource.repositoryUrl]) assert.ok(prompt.includes(required),`${locale} prompt missing ${required}`);
    assert.ok(!prompt.includes('Authorization: Bearer'));
  }

  // Refresh may replace every file ID. Clone must install the returned snapshot,
  // and uncertain action responses must retry that snapshot rather than resync.
  const beforeRefresh = structuredClone(publicRepository);
  const freshBytes = Buffer.from('# Latest upstream\nVersion four.');
  const freshFile = { fileId: 41, path: 'README.md', mimeType: 'text/markdown', sizeBytes: freshBytes.length, sha256: createHash('sha256').update(freshBytes).digest('hex') };
  h.extraFiles = { '/api/agent/repositories/7/files/41?revision=4': { ...freshFile, contentBase64: freshBytes.toString('base64') } };
  h.user = { id: 1, membershipTier: 'lifetime' }; h.enabled = true; h.publication = null;
  await mount(AgentPublicRepositoryPage);
  h.nextUpstream = { revision: 4, files: [freshFile], manifestUrl: publicRepository.manifestUrl.replace('revision=3', 'revision=4'), githubSource: { ...githubSource, commitSha: 'b'.repeat(40) } };
  h.failClone = true;
  const cloneRefreshes = calls.filter(call => call.path.endsWith('/sync?recheck=false')).length;
  await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent);
  const refreshedClone = calls.findLast(call => call.path.endsWith('/clone')).body;
  assert.equal(refreshedClone.expectedRevision, 4, 'Clone uses the refreshed revision, not the opened page revision');
  assert.equal(refreshedClone.refresh, false, 'Clone consumes its prepared snapshot without a second backend refresh');
  assert.equal(calls.filter(call => call.path.endsWith('/sync?recheck=false')).length, cloneRefreshes + 1, 'a fresh Clone prepares upstream once');
  h.failClone = false;
  h.nextUpstream = { revision: 5, manifestUrl: publicRepository.manifestUrl.replace('revision=4', 'revision=5') };
  await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent);
  assert.deepEqual(calls.findLast(call => call.path.endsWith('/clone')).body, refreshedClone, 'uncertain Clone retries preserve both revision and request ID');
  assert.equal(calls.filter(call => call.path.endsWith('/sync?recheck=false')).length, cloneRefreshes + 1, 'uncertain Clone retries do not refresh upstream');
  assert.ok(document.querySelector('textarea')?.value.includes('revision=4'), 'retry opens the originally prepared snapshot');
  await click(zh.space.syncCancel);
  const transferred = await loadAgentWorkspaceFiles(publicRepository, new Set([41]), () => {}, undefined, publicAgentRepositoryTransferSource(publicRepository));
  assert.equal(Buffer.from(transferred[0].bytes).toString(), freshBytes.toString(), 'refreshed file IDs resolve to the latest upstream bytes');

  // A new operation can refresh again; a failed Fork must not be retargeted by
  // another upstream commit before the user retries it.
  h.extraFiles['/api/agent/repositories/7/files/41?revision=5'] = { ...freshFile, contentBase64: freshBytes.toString('base64') };
  h.failFork = true;
  const forkRefreshes = calls.filter(call => call.path.endsWith('/sync?recheck=false')).length;
  await click(labels.forkRepository);
  const refreshedFork = calls.findLast(call => call.path.endsWith('/fork')).body;
  assert.equal(refreshedFork.expectedRevision, 5);
  assert.equal(refreshedFork.refresh, false, 'Fork consumes its prepared snapshot without a second backend refresh');
  assert.equal(calls.filter(call => call.path.endsWith('/sync?recheck=false')).length, forkRefreshes + 1);
  h.failFork = false;
  h.nextUpstream = { revision: 6, manifestUrl: publicRepository.manifestUrl.replace('revision=5', 'revision=6') };
  await click(labels.forkRepository);
  assert.deepEqual(calls.findLast(call => call.path.endsWith('/fork')).body, refreshedFork, 'uncertain Fork retries stay on the prepared snapshot');
  assert.equal(calls.filter(call => call.path.endsWith('/sync?recheck=false')).length, forkRefreshes + 1);
  assert.equal(publicRepository.revision, 5, 'a pending action is not resynchronized during retry');
  delete h.nextUpstream;

  h.failSync = true;
  await mount(AgentPublicRepositoryPage);
  await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent);
  assert.equal(document.querySelector('textarea'), null, 'upstream refresh failure never offers a stale install prompt');
  assert.ok(document.querySelector('[role="alert"]'), 'upstream refresh failure is visible');
  h.failSync = false;
  h.nextUpstream = { githubSource: { ...publicRepository.githubSource, upstreamStatus: 'archived' } };
  h.syncResult = { status: 'skipped', code: 'archived' };
  await click(labels.syncGitHub);
  assert.ok(document.body.textContent.includes(labels.githubUpstreamArchived), 'manual refresh displays the saved upstream mark');
  h.failSync = true;
  const beforeRetiredClone = calls.filter(call => call.path.endsWith('/sync?recheck=false')).length;
  await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent);
  assert.ok(document.querySelector('textarea')?.value.includes('revision=5'), 'known-retired upstream keeps the last saved snapshot usable');
  assert.equal(calls.filter(call => call.path.endsWith('/sync?recheck=false')).length, beforeRetiredClone + 1, 'server preparation skips the retired upstream even during an outage');
  await click(zh.space.syncCancel);

  // A lost Clone response can be retried after the publication was replaced.
  // Conflict recovery must stop pinning retired and non-GitHub views to r5.
  const retiredSnapshot = structuredClone(publicRepository);
  for (const origin of ['retired', 'ordinary']) {
    Object.assign(publicRepository, structuredClone(retiredSnapshot));
    if (origin === 'ordinary') delete publicRepository.githubSource;
    await mount(AgentPublicRepositoryPage);
    h.loseCloneResponse = true;
    await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent);
    const uncertain = calls.findLast(call => call.path.endsWith('/clone')).body;
    h.loseCloneResponse = false;
    const updatedBytes = Buffer.from('# Recovered snapshot\n' + origin);
    const updatedFile = { fileId: 91, path: 'README.md', mimeType: 'text/markdown', sizeBytes: updatedBytes.length, sha256: createHash('sha256').update(updatedBytes).digest('hex') };
    Object.assign(publicRepository, { revision: 6, files: [updatedFile], manifestUrl: publicRepository.manifestUrl.replace('revision=5', 'revision=6') });
    h.extraFiles['/api/agent/repositories/7/files/91?revision=6'] = { ...updatedFile, contentBase64: updatedBytes.toString('base64') };
    await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent);
    assert.ok(document.querySelector('[role="alert"]'), 'the expired initiation reports a conflict');
    assert.equal(client.getQueryData(['public-agent-repository', 7, h.user.id]).repository.revision, 6, 'conflict reloads the current publication');
    await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent);
    const recovered = calls.findLast(call => call.path.endsWith('/clone')).body;
    assert.equal(recovered.expectedRevision, 6, 'retry uses the replacement publication');
    assert.notEqual(recovered.requestId, uncertain.requestId, 'replacement publication gets a new initiation');
    assert.ok(document.querySelector('textarea')?.value.includes('revision=6'), 'installation instructions pin the replacement revision');
    const content = await loadAgentWorkspaceFiles(publicRepository, new Set([91]), () => {}, undefined, publicAgentRepositoryTransferSource(publicRepository));
    assert.equal(Buffer.from(content[0].bytes).toString(), updatedBytes.toString(), 'replacement file bytes can actually be downloaded');
    await click(zh.space.syncCancel);
  }
  Object.assign(publicRepository, retiredSnapshot);
  await mount(AgentPublicRepositoryPage);
  h.failSync = false;
  h.nextUpstream = { githubSource: { ...githubSource, commitSha: 'b'.repeat(40) } };
  h.syncResult = { status: 'unchanged' };
  await click(labels.syncRecheckGitHub);
  assert.ok(!document.body.textContent.includes(labels.githubUpstreamArchived), 'manual recovery clears the upstream mark');
  delete h.syncResult;
  Object.assign(publicRepository, beforeRefresh); delete h.extraFiles;

  // Manual Sync cannot turn an uncertain action into a new request. Even an
  // updated source must replay a committed Fork; Clone lets the server reject
  // a replaced snapshot before issuing a new initiation.
  for (const action of ['fork', 'clone']) {
    for (const status of ['unchanged', 'skipped', 'updated']) {
      Object.assign(publicRepository, structuredClone(beforeRefresh));
      await mount(AgentPublicRepositoryPage);
      const startClone = async () => { await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent); };
      const start = action === 'fork' ? () => click(labels.forkRepository) : startClone;
      const count = () => action === 'fork' ? h.forkResults.size : h.cloneIDs.size;
      const beforeCount = count();
      h.loseForkResponse = action === 'fork';
      h.loseCloneResponse = action === 'clone';
      await start();
      const uncertain = calls.findLast(call => call.path.endsWith(`/${action}`)).body;
      assert.equal(count(), beforeCount + 1, 'the initial action committed before its response was lost');
      h.loseForkResponse = false; h.loseCloneResponse = false;
      h.syncResult = { status, ...(status === 'skipped' ? { code: 'personal_fork' } : {}) };
      if (status === 'updated') h.nextUpstream = { revision: beforeRefresh.revision + 1, manifestUrl: beforeRefresh.manifestUrl.replace(`revision=${beforeRefresh.revision}`, `revision=${beforeRefresh.revision + 1}`) };
      await click(labels.syncGitHub);
      if (status === 'skipped') {
        assert.ok(document.body.textContent.includes(labels.syncSkippedPersonalFork));
        assert.ok(!labels.syncSkippedPersonalFork.includes('你的'), 'public fork feedback does not claim the viewer owns the repository');
      }
      delete h.syncResult;
      await start();
      assert.deepEqual(calls.findLast(call => call.path.endsWith(`/${action}`)).body, uncertain, `${action} keeps its uncertain request through ${status} Sync`);
      assert.equal(count(), beforeCount + 1, 'retry never duplicates the committed action');
      if (action === 'clone' && status === 'updated') {
        assert.ok(document.querySelector('[role="alert"]'), 'a replaced Clone snapshot conflicts instead of silently retargeting the retry');
        assert.equal(document.querySelector('textarea'), null);
      } else if (action === 'clone') {
        await click(zh.space.syncCancel);
      }
    }
  }
  Object.assign(publicRepository, structuredClone(beforeRefresh));

  // A native confirmation can stay open while another device updates the repository.
  h.user={id:1,membershipTier:'lifetime'}; h.publication=null;h.source=null;h.privateRevision=3;
  const approvedSnapshot={...workspace,revision:3,githubSource:undefined};
  await mount(AgentRepositorySharingCard,{workspace:approvedSnapshot});
  await input('select','MIT');await consent(true);
  const originalConfirm=h.confirm;
  let answer;
  h.confirm=async message=>{confirmations.push(message);return new Promise(resolve=>{answer=resolve;});};
  await click(labels.publishSnapshot);
  assert.ok(confirmations.at(-1).includes('r3'));
  assert.equal(button(labels.publishSnapshot).disabled,true,"pending confirmation cannot be opened twice");
  h.privateRevision=4;
  await act(async()=>{
    client.setQueryData(['agent-repository-sharing',7],{publication:{...publicRepository,license:'Apache-2.0'},source:null,currentRevision:4});
    root.render(createElement(QueryClientProvider,{client},createElement(AgentRepositorySharingCard,{workspace:{...approvedSnapshot,revision:4}})));
  });
  await settle();
  assert.equal(document.querySelector('select').value,'Apache-2.0',"background state really changed while confirming");
  await act(async()=>answer(true));await settle();
  assert.deepEqual(calls.findLast(call=>call.path.endsWith('/sharing')&&call.method==='PUT').body,{expectedRevision:3,license:'MIT',category:'other'},"publish uses the approved snapshot and license");
  assert.ok(document.body.textContent.includes(labels.sharingConflict),"newer private changes produce a visible conflict");
  assert.equal(h.publication,null,"unapproved files never become public");
  assert.equal(document.querySelector('input[type="checkbox"]').checked,false,"new revision needs renewed consent");

  h.privateRevision=3;
  await mount(AgentRepositorySharingCard,{workspace:approvedSnapshot});await consent(true);
  await click(labels.publishSnapshot);
  const publications=calls.filter(call=>call.path.endsWith('/sharing')&&call.method==='PUT').length;
  await act(async()=>root.render(null));
  await act(async()=>answer(true));await settle();
  assert.equal(calls.filter(call=>call.path.endsWith('/sharing')&&call.method==='PUT').length,publications,"leaving the page cancels a pending confirmation");
  h.confirm=originalConfirm;
  // System curation is public provenance, never the curator's private ownership.
  publicRepository.systemManaged=true;h.publication=publicRepository;h.withdrawn=false;h.privateRevision=3;
  h.user={id:2,membershipTier:'free'};calls.length=0;
  await mount(AgentPublicRepositoryPage);
  assert.ok(document.body.textContent.includes(labels.hubSystemBadge));
  assert.ok(!calls.some(call=>call.path.endsWith('/sharing')), 'members never request private ownership of system repos');
  await mount(AgentPublicRepositoriesPage);
  assert.ok(document.body.textContent.includes(labels.hubSystemBadge));
  h.user={id:1,isAdmin:true,membershipTier:'free'};calls.length=0;
  await mount(AgentPublicRepositoryPage);
  assert.ok(calls.some(call=>call.path==='/api/admin/agent-repositories/7/sharing'&&call.method==='GET'));
  await click(labels.revokeSharing);
  assert.equal(calls.findLast(call=>call.method==='DELETE').path,'/api/admin/agent-repositories/7/sharing');
  await mount(SystemRepositoriesAdminPanel);
  assert.ok(document.body.textContent.includes(labels.systemRepositoriesDescription));
  assert.ok(document.body.textContent.includes(labels.systemUnpublished));
  await click(labels.publishSnapshot);
  assert.equal(calls.findLast(call=>call.method==='PUT').path,'/api/admin/agent-repositories/7/sharing');
  assert.ok(document.body.textContent.includes(labels.publishedRevision.replace('{revision}','3')));
  h.failPublish=true;
  await click(labels.revokeSharing);
  assert.ok(document.body.textContent.includes(labels.sharingSensitive), 'system management failures are visible');
  h.failPublish=false;
  await input('#system-github-link', 'https://github.com/dontbesilent2025/dbskill');
  await submit();
  const collectedLink = calls.findLast(call => call.path === '/api/admin/agent-repositories/import/github').body;
  assert.equal(collectedLink.repositoryUrl, 'https://github.com/dontbesilent2025/dbskill');
  assert.equal(collectedLink.linkOnly, true, 'admin collection saves a link, never a mirror');
  assert.ok(collectedLink.requestId);
  assert.equal(document.querySelector('#system-github-link').value, '');
  h.user=null;h.directoryPageSize=2;
  h.directory=[
    {workspaceId:101,name:'Design one',systemManaged:true,category:'design',koiInstallable:true},
    {workspaceId:102,name:'Build tools',systemManaged:true,category:'development'},
    {workspaceId:103,name:'Community design',systemManaged:false,category:'design'},
    {workspaceId:104,name:'Design two',systemManaged:true,category:'design',koiInstallable:true},
    {workspaceId:105,name:'Writing tools',systemManaged:false,category:'writing',koiInstallable:true},
    {workspaceId:106,name:'Focus agent',systemManaged:true,category:'design',koiInstallable:true},
  ].map(item=>({...publicRepository,fileCount:1,sizeBytes:bytes.length,...item}));
  await mount(AgentPublicRepositoriesPage);
  const cards=()=>[...document.querySelectorAll('[data-repository-card]')].map(card=>card.querySelector('h3').textContent);
  async function filter(label) {const target=[...document.querySelectorAll('button[aria-pressed]')].find(b=>b.textContent.startsWith(label));assert.ok(target,`Missing filter ${label}`);await act(async()=>target.click());await settle();}
  assert.deepEqual(cards(),['Design one','Build tools']);
  assert.ok(document.body.textContent.includes(labels.publicSortUpdated), 'the directory explains Koi installation priority');
  const initialCards=[...document.querySelectorAll('[data-repository-card]')];
  assert.ok(initialCards[0].textContent.includes(labels.hubKoiInstallable), 'verified compatible repositories show their installation badge');
  assert.equal(initialCards[1].textContent.includes(labels.hubKoiInstallable),false,'unchecked repositories do not promise installation compatibility');
  await filter(labels.hubKoiInstallable);
  assert.deepEqual(cards(),['Design one','Design two'],'the Koi view filters on the server before paging');
  assert.ok(document.body.textContent.includes(labels.hubResultCount.replace('{count}','4')));
  assert.ok(document.body.textContent.includes(labels.hubKoiInstallableHint));
  await filter(labels.hubKoiInstallable);
  assert.deepEqual(cards(),['Design one','Build tools'],'the standalone filter toggles off');
  await filter(labels.hubKoiInstallable);
  await click(labels.loadMore);
  assert.deepEqual(cards(),['Design one','Design two','Writing tools','Focus agent']);
  await filter(labels.hubCategory_writing);
  assert.deepEqual(cards(),['Writing tools'],'Koi eligibility combines with a topic');
  assert.equal(h.directorySearch.koiInstallable,true);
  h.pendingKoi=2;
  await filter(labels.hubSystemBadge);
  assert.equal(cards().length,0,'Koi eligibility combines with source filtering');
  assert.ok(document.body.textContent.includes(labels.hubKoiChecking.replace('{count}','2')),'pending compatibility has its own status');
  assert.equal(document.body.textContent.includes(labels.publicEmpty),false,'pending checks do not claim the directory is empty');
  h.pendingKoi=0;
  await click(labels.refresh);
  assert.equal(document.body.textContent.includes(labels.hubKoiChecking.replace('{count}','2')),false,'refresh removes completed checks');
  assert.ok(document.body.textContent.includes(labels.hubEmptyFiltered));
  await click(labels.hubClearFilters);
  await filter(labels.hubCategory_design);
  assert.deepEqual(cards(),['Design one','Community design']);
  await filter(labels.hubSystemBadge);
  assert.deepEqual(cards(),['Design one','Design two']);
  assert.ok(document.body.textContent.includes(labels.hubResultCount.replace('{count}','3')));
  const filteredRequest=new URL(calls.findLast(call=>call.path.startsWith('/api/agent/repositories?')).path,'https://koinote.example');
  assert.equal(filteredRequest.searchParams.get('source'),'system');
  assert.equal(filteredRequest.searchParams.get('category'),'design');
  assert.equal(filteredRequest.searchParams.has('cursor'),false,'changing filters starts at the first page');
  await click(labels.loadMore);
  assert.deepEqual(cards(),['Design one','Design two','Focus agent'],'filters reach repositories beyond the initial page');
  await filter(labels.hubCommunity);
  assert.deepEqual(cards(),['Community design']);
  await click(labels.hubClearFilters);
  await input('input[type="search"]','Focus');await submit();
  assert.deepEqual(cards(),['Focus agent']);
  await filter(labels.hubCategory_writing);
  assert.equal(cards().length,0);assert.ok(document.body.textContent.includes(labels.hubEmptyFiltered));
  await click(labels.hubClearFilters);
  assert.deepEqual(cards(),['Design one','Build tools']);
  await input('input[type="search"]','  Portable  ');await submit();
  await filter(labels.hubCategory_design);await filter(labels.hubSystemBadge);
  await filter(labels.hubKoiInstallable);
  const savedFilters={q:'Portable',source:'system',category:'design',koiInstallable:true};
  assert.deepEqual(h.directorySearch,savedFilters,'all committed filters are stored in the URL');
  await click(labels.loadMore);
  const selectedCards=cards();
  const detailHref=document.querySelector('[data-repository-card] a').getAttribute('href');
  const detailSearch=parseRepositorySearch(Object.fromEntries(new URL(detailHref,'https://koinote.example').searchParams));
  assert.deepEqual(detailSearch,{...savedFilters,file:undefined},'repository links retain the directory context');
  // Keep the query client alive as the real router does when changing pages.
  publicRepository.files=[...originalFiles,guideFile];
  h.extraFiles={...h.extraFiles,'/api/agent/repositories/7/files/31?revision=3':guideFile};
  h.search={...detailSearch,file:guideFile.path};h.hash='';
  await act(async()=>root.render(createElement(QueryClientProvider,{client},createElement(AgentPublicRepositoryPage))));await settle();
  await click(labels.readmeBack);
  assert.deepEqual(parseRepositoryDirectorySearch(navigations.at(-1).search),savedFilters,'README navigation preserves the directory context');
  const backHref=[...document.querySelectorAll('a')].find(a=>a.textContent===`← ${labels.publicRepositories}`).getAttribute('href');
  const backSearch=parseRepositoryDirectorySearch(Object.fromEntries(new URL(backHref,'https://koinote.example').searchParams));
  assert.deepEqual(backSearch,savedFilters,'Back to Hub links retain filters');
  publicRepository.files=originalFiles;
  await act(async()=>root.render(createElement(QueryClientProvider,{client},createElement(AgentPublicRepositoriesPage))));await settle();
  assert.deepEqual(cards(),selectedCards,'returning to the directory retains filters and loaded pages');
  assert.equal(document.querySelector('input[type="search"]').value,'Portable');
  assert.equal(document.querySelector('.hub-source-button[aria-pressed="true"]').textContent,`${labels.hubSystemBadge}3`);
  assert.equal(document.querySelector('.hub-category-button[aria-pressed="true"]').textContent,`${labels.hubCategory_design}3`);
  await click(labels.hubClearFilters);
  assert.deepEqual(h.directorySearch,{},'clear removes all URL filters');
  // Browser Back/Forward can change the URL without remounting the directory.
  await act(async()=>h.navigate({to:'/repositories',search:backSearch}));await settle();
  assert.deepEqual(cards(),selectedCards);
  assert.equal(document.querySelector('input[type="search"]').value,'Portable','history navigation restores the input');
  await mount(AgentPublicRepositoriesPage);
  assert.deepEqual(cards(),['Design one','Design two'],'a fresh load restores filters from the URL');
  assert.equal(document.querySelector('input[type="search"]').value,'Portable');
  await click(labels.hubClearFilters);h.search={};
  delete h.directory;delete h.directoryPageSize;

  // Use the installed router: validateSearch results are merged with raw URL
  // values, and defaultParseSearch JSON-parses numbers, booleans and objects.
  const {createRouter,createRootRoute,createRoute,defaultParseSearch}=await import('@tanstack/react-router');
  const {createMemoryHistory}=await import('@tanstack/history');
  const routeRoot=createRootRoute();
  const directoryRoute=createRoute({getParentRoute:()=>routeRoot,path:'/repositories',validateSearch:parseRepositoryDirectorySearch});
  const detailRoute=createRoute({getParentRoute:()=>routeRoot,path:'/repositories/$repositoryId',validateSearch:parseRepositorySearch});
  const router=createRouter({routeTree:routeRoot.addChildren([directoryRoute,detailRoute]),isServer:true,history:createMemoryHistory({initialEntries:['/repositories']})});
  assert.deepEqual(router.matchRoutes(loginReturn.pathname,defaultParseSearch(loginReturn.search)).at(-1).search,{...loginContext,installKoi:true},'the real router restores the login context and install intent');
  for(const [raw,expected] of [
    ['?koiInstallable=true',{koiInstallable:true}],
    ['?koiInstallable=false',{}],
    ['?koiInstallable=%5Btrue%5D',{}],
    ['?q=123',{q:'123'}],
    ['?q=true',{q:'true'}],
    ['?q=null',{}],
    ['?q=%7B%22text%22%3A%22skills%22%7D',{}],
    ['?q=%5B%22skills%22%5D&source=%5B%22system%22%5D&category=null',{}],
    ['?q='+ 'x'.repeat(81)+'&source=admin&category=unknown',{}],
    ['?q=%20skills%20&source=system&category=design',{q:'skills',source:'system',category:'design'}],
    ['?q=%22123%22&source=community&category=writing',{q:'123',source:'community',category:'writing'}],
  ]) {
    const matched=router.matchRoutes('/repositories',defaultParseSearch(raw)).at(-1).search;
    assert.deepEqual(matched,{...emptyFilters,...expected},`real route must normalize ${raw}`);
    h.directorySearch=matched;
    await mount(AgentPublicRepositoriesPage);
    assert.equal(document.querySelector('input[type="search"]').value,expected.q??'');
    await submit();
    const request=new URL(calls.findLast(call=>call.path.startsWith('/api/agent/repositories?')).path,'https://koinote.example');
    assert.equal(request.searchParams.get('q'),expected.q??'');
    assert.equal(request.searchParams.get('source'),expected.source??null);
    assert.equal(request.searchParams.get('category'),expected.category??null);
    const location=router.buildLocation({to:'/repositories',search:matched});
    const roundTrip=router.matchRoutes('/repositories',defaultParseSearch(new URL(location.href,'https://koinote.example').search)).at(-1).search;
    assert.deepEqual(roundTrip,{...emptyFilters,...expected},'normalized filters survive URL serialization and reload');
  }
  assert.deepEqual(router.matchRoutes('/repositories/7',defaultParseSearch('?q=null&category=unknown&file=%5B%22README.md%22%5D')).at(-1).search,{...emptyFilters,file:undefined},'detail routes also overwrite invalid URL values');
  h.directorySearch={};

  // A failed refetch and a failed next-page request require different retries.
  h.directoryPageSize=2;
  h.directory=Array.from({length:5},(_,index)=>({...publicRepository,workspaceId:200+index,name:`Retry ${index}`,category:'design',systemManaged:true,fileCount:1,sizeBytes:bytes.length}));
  h.failDirectoryPage='first';
  await mount(AgentPublicRepositoriesPage);
  assert.ok(document.querySelector('[role="alert"]'),'initial-load failure is visible');
  delete h.failDirectoryPage;
  let beforeRetry=calls.length;
  await click(labels.refresh);
  assert.deepEqual(calls.slice(beforeRetry).map(call=>new URL(call.path,'https://koinote.example').searchParams.get('cursor')),[null],'initial-load retry starts at the first page');
  assert.deepEqual(cards(),['Retry 0','Retry 1']);
  await click(labels.loadMore);
  h.directory[0]={...h.directory[0],name:'Updated Retry 0'};
  h.directory[2]={...h.directory[2],name:'Updated Retry 2'};
  h.failDirectoryPage='2';
  await act(async()=>client.invalidateQueries({queryKey:['public-agent-repositories']}));await settle();
  assert.ok(document.querySelector('[role="alert"]'),'background refetch failure is visible');
  delete h.failDirectoryPage;beforeRetry=calls.length;
  await click(labels.refresh);
  assert.deepEqual(calls.slice(beforeRetry).map(call=>new URL(call.path,'https://koinote.example').searchParams.get('cursor')),[null,'2'],'refetch retry refreshes all loaded pages instead of appending the next page');
  assert.deepEqual(cards(),['Updated Retry 0','Retry 1','Updated Retry 2','Retry 3'],'refetch retry replaces stale content');
  assert.equal(document.querySelector('[role="alert"]'),null);
  h.failDirectoryPage='4';
  await click(labels.loadMore);
  assert.ok(document.querySelector('[role="alert"]'),'next-page failure is visible');
  delete h.failDirectoryPage;beforeRetry=calls.length;
  await click(labels.refresh);
  assert.deepEqual(calls.slice(beforeRetry).map(call=>new URL(call.path,'https://koinote.example').searchParams.get('cursor')),['4'],'next-page retry reuses its cursor');
  assert.deepEqual(cards(),['Updated Retry 0','Retry 1','Updated Retry 2','Retry 3','Retry 4']);
  assert.equal(document.querySelector('[role="alert"]'),null);
  delete h.directory;delete h.directoryPageSize;

  // A manual sync can outlive the view that started it: the viewer navigates to
  // another repository, switches accounts, or leaves and returns. The response
  // belongs to the initiating viewer/repository only, so it must neither render
  // its snapshot at the new URL nor write it into the new repository's cache.
  publicRepository.systemManaged = false; h.publication = null; h.withdrawn = false;
  h.user = { id: 1, membershipTier: 'lifetime' }; h.enabled = true; h.failSync = false;
  h.search = {}; h.hash = ''; h.cloneIDs = undefined;
  const staleSeven = { ...structuredClone(publicRepository), revision: 9, name: 'Stale seven', starCount: 5, cloneCount: 5, starred: true };
  const repositoryTitle = () => document.querySelector('h1')?.textContent;
  const cached = (repositoryId, viewerId) => client.getQueryData(['public-agent-repository', repositoryId, viewerId])?.repository;

  const workspaceNavigations = () => navigations.filter(target => target.to === '/agent/workspaces/$workspaceId').length;
  h.syncPayload = staleSeven; h.syncResult = { status: 'updated' };
  await mount(AgentPublicRepositoryPage);
  assert.equal(repositoryTitle(), 'Shared skills');
  const navigationsBeforeStale = workspaceNavigations();
  const releaseSevenSync = hold('POST', '/api/agent/repositories/7/sync');
  await click(labels.syncGitHub);
  assert.equal(document.querySelector('[role="menu"]'), null);
  assert.equal(actionProgress()?.textContent, labels.syncingGitHub, 'sync progress does not require reopening the menu');
  assert.ok(await actionButton(labels.syncingGitHub), 'the sync stays pending while its response is held');
  await act(async () => h.setRepository('8')); await settle();
  assert.equal(actionProgress(), null, 'navigation drops the previous repository’s progress');
  assert.equal(repositoryTitle(), 'Second skills', 'navigating to repository 8 renders B while A is still in flight');
  assert.equal((await actionButton(labels.transferZip)).disabled, false, 'the new view does not inherit the previous view’s busy state');
  assert.equal(cached(8, 1)?.workspaceId, 8);
  await act(async () => { releaseSevenSync(); }); await settle();
  assert.equal(repositoryTitle(), 'Second skills', 'B keeps its heading after A’s late response');
  assert.equal(cached(8, 1)?.workspaceId, 8, 'A’s snapshot is never written under B’s cache key');
  assert.equal(cached(8, 1)?.name, 'Second skills');
  assert.equal(cached(8, 1)?.revision, 2, 'B’s cache keeps its own revision');
  assert.ok(!document.body.textContent.includes('Stale seven'), 'A’s late snapshot never renders at B');
  assert.ok(!document.body.textContent.includes(labels.syncUpdated), 'A’s late result does not post status into B');
  assert.notEqual(cached(7, 1)?.name, 'Stale seven', 'the initiating repository’s cache never receives the late payload either');
  assert.equal(cached(7, 1)?.name, 'Shared skills');
  assert.equal(workspaceNavigations(), navigationsBeforeStale, 'A’s late response cannot navigate');

  // The same held response after a viewer switch must not leak the initiating
  // viewer’s engagement snapshot into the new viewer’s cache.
  h.search = {}; h.hash = ''; h.syncPayload = { ...structuredClone(publicRepository), revision: 9, name: 'Viewer one stale', starCount: 6, starred: true, cloneCount: 6 };
  await mount(AgentPublicRepositoryPage);
  const releaseViewerSync = hold('POST', '/api/agent/repositories/7/sync');
  await click(labels.syncGitHub);
  await act(async () => h.setUser({ id: 2, membershipTier: 'free' })); await settle();
  await act(async () => { releaseViewerSync(); }); await settle();
  assert.equal(cached(7, 2)?.name, 'Shared skills', 'the second viewer keeps its own fresh snapshot');
  assert.equal(cached(7, 2)?.starred, false);
  assert.notEqual(cached(7, 1)?.name, 'Viewer one stale', 'the initiating viewer’s cache is not pinned with the late response either');
  assert.ok(!document.body.textContent.includes(labels.syncUpdated), 'the second viewer never sees the first viewer’s result');

  // Leave and return: the old visit is unmounted, its late response must not
  // clear or retarget the newer visit’s request state; a fresh sync still works.
  h.user = { id: 1, membershipTier: 'lifetime' };
  h.syncPayload = { ...structuredClone(publicRepository), revision: 9, name: 'Stale after return' };
  await mount(AgentPublicRepositoryPage);
  const releaseOldVisit = hold('POST', '/api/agent/repositories/7/sync');
  await click(labels.syncGitHub);
  await act(async () => h.setRepository('8')); await settle();
  await act(async () => h.setRepository('7')); await settle();
  assert.equal(repositoryTitle(), 'Shared skills', 'returning to repository 7 starts a new visit');
  await act(async () => { releaseOldVisit(); }); await settle();
  assert.equal(repositoryTitle(), 'Shared skills', 'the earlier visit’s response cannot overwrite the newer visit');
  assert.notEqual(cached(7, 1)?.name, 'Stale after return');
  delete h.syncPayload; delete h.syncResult;
  h.nextUpstream = { revision: 10, name: 'Fresh seven', manifestUrl: publicRepository.manifestUrl.replace('revision=3', 'revision=10') };
  const releaseNewVisit = hold('POST', '/api/agent/repositories/7/sync');
  await click(labels.syncGitHub);
  await act(async () => { releaseNewVisit(); }); await settle();
  assert.equal(repositoryTitle(), 'Fresh seven', 'the newer visit applies its own response');
  assert.ok(document.body.textContent.includes(labels.syncUpdated));
  assert.equal(cached(7, 1)?.name, 'Fresh seven');
  delete h.nextUpstream;

  // Fork/Clone preparation also awaits a refresh. Leaving the view mid-refresh
  // must cancel the prepared action instead of posting it for the old snapshot.
  const clonePosts = () => calls.filter(call => call.path.endsWith('/clone')).length;
  await mount(AgentPublicRepositoryPage);
  const clonesBeforeLeave = clonePosts();
  const releaseClonePrep = hold('POST', '/api/agent/repositories/7/sync?recheck=false');
  await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent);
  await act(async () => h.setRepository('8')); await settle();
  await act(async () => { releaseClonePrep(); }); await settle();
  assert.equal(clonePosts(), clonesBeforeLeave, 'a Clone whose view left before preparation never posts');
  assert.equal(document.querySelector('textarea'), null, 'the new repository never opens the old install prompt');
  assert.equal(document.querySelector('[role="dialog"]'), null);
  const forksBeforeLeave = calls.filter(call => call.path.endsWith('/fork')).length;
  const navigationsBeforeFork = workspaceNavigations();
  await act(async () => h.setRepository('7')); await settle();
  const releaseForkPrep = hold('POST', '/api/agent/repositories/7/sync?recheck=false');
  await click(labels.forkRepository);
  await act(async () => h.setUser({ id: 2, membershipTier: 'lifetime' })); await settle();
  await act(async () => { releaseForkPrep(); }); await settle();
  assert.equal(calls.filter(call => call.path.endsWith('/fork')).length, forksBeforeLeave, 'a Fork prepared by the previous account never posts');
  assert.equal(workspaceNavigations(), navigationsBeforeFork, 'the stale Fork cannot navigate to its workspace');
  assert.equal(repositoryTitle(), 'Fresh seven', 'the new account keeps the repository it is viewing');

  // A page's cached upstream status must not choose the preparation policy.
  h.user = { id: 1, membershipTier: 'lifetime' }; h.enabled = true;
  h.failSync = false; h.failClone = false; h.failFork = false;
  publicRepository.githubSource = { ...githubSource, upstreamStatus: 'archived' };
  for (const action of ['clone', 'fork']) {
    publicRepository.githubSource.upstreamStatus = 'archived';
    await mount(AgentPublicRepositoryPage);
    const oldRevision = publicRepository.revision;
    // Another visitor cleared the mark without changing the revision; a later
    // upstream commit must still be checked before consuming the snapshot.
    delete publicRepository.githubSource.upstreamStatus;
    h.nextUpstream = { revision: oldRevision + 1, manifestUrl: publicRepository.manifestUrl.replace(`revision=${oldRevision}`, `revision=${oldRevision + 1}`) };
    if (action === 'fork') await click(labels.forkRepository);
    else { await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent); }
    assert.equal(calls.findLast(call => call.path.endsWith(`/${action}`)).body.expectedRevision, oldRevision + 1, `${action} checks the recovered source instead of trusting a cached archived mark`);
    if (action === 'clone') await click(zh.space.syncCancel);
  }
  for (const action of ['clone', 'fork']) {
    delete publicRepository.githubSource.upstreamStatus;
    await mount(AgentPublicRepositoryPage);
    // The server has since retired the source. Preparation must preserve the
    // last good snapshot without turning this action into a manual recheck.
    publicRepository.githubSource.upstreamStatus = 'archived';
    h.failSync = true;
    if (action === 'fork') await click(labels.forkRepository);
    else { await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent); }
    assert.equal(calls.findLast(call => call.path.endsWith(`/${action}`)).body.expectedRevision, publicRepository.revision);
    assert.equal(document.querySelector('[role="alert"]'), null, `${action} can consume a server-known retired source while GitHub is unavailable`);
    if (action === 'clone') await click(zh.space.syncCancel);
    h.failSync = false;
  }

  // Independent/edited/disabled copies explain why a GitHub recheck cannot run.
  for (const [reason, key] of [['personal_fork', 'syncSkippedPersonalFork'], ['local_changes', 'syncSkippedLocalChanges'], ['agent_workspace_disabled', 'syncSkippedDisabled']]) {
    publicRepository.syncDisabledReason = reason;
    await mount(AgentPublicRepositoryPage);
    assert.equal((await actionButton(labels.syncGitHub)).disabled, true);
    assert.ok(![...document.querySelectorAll('button')].some(el => el.textContent === labels.syncRecheckGitHub), 'saved copies never advertise a working recheck');
    assert.ok(document.body.textContent.includes(labels[key]));
    assert.equal((await actionButton(labels.transferZip)).disabled, false, 'the saved copy remains clonable');
  }
  delete publicRepository.syncDisabledReason;
  delete publicRepository.githubSource.upstreamStatus;
  for (const [code, key] of [['license_changed', 'githubLicenseChanged'], ['license_review_required', 'githubLicenseReviewRequired'], ['publication_license_mismatch', 'githubPublicationLicenseMismatch'], ['repository_identity_mismatch', 'githubRepositoryIdentityMismatch']]) {
    h.syncErrorCode = code;
    await mount(AgentPublicRepositoryPage);
    await click(labels.syncGitHub);
    assert.equal(document.querySelector('[role="alert"]')?.textContent, labels[key]);
    // A manual update failure must not prevent consuming its valid publication.
    for (const action of ['clone', 'fork']) {
      await mount(AgentPublicRepositoryPage);
      const previous = calls.filter(call => call.path.endsWith(`/${action}`)).length;
      if (action === 'fork') await click(labels.forkRepository);
      else { await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent); }
      assert.equal(calls.filter(call => call.path.endsWith(`/${action}`)).length, previous + 1, `${action} keeps the saved snapshot after ${code}`);
      assert.equal(calls.findLast(call => call.path.endsWith(`/${action}`)).body.expectedPublication, publicRepository.publicationId);
      assert.ok(document.body.textContent.includes(labels[key]), 'preparation preserves the reason the update was skipped');
      assert.equal(document.querySelector('[role="alert"]'), null);
      if (action === 'clone') {
        assert.ok(document.querySelector('textarea')?.value.includes(publicRepository.manifestUrl));
        await click(zh.space.syncCancel);
      }
    }
  }
  delete h.syncErrorCode;
  for (const [code, key] of [['license_changed', 'githubLicenseChanged'], ['license_review_required', 'githubLicenseReviewRequired'], ['publication_license_mismatch', 'githubPublicationLicenseMismatch'], ['repository_identity_mismatch', 'githubRepositoryIdentityMismatch'], ['agent_workspace_disabled', 'syncSkippedDisabled'], ['github_token_required', 'githubTokenRequired'], ['koi_skills_unavailable', 'githubKoiSkillsUnavailable']]) {
    h.syncResult = { status: 'skipped', code };
    await mount(AgentPublicRepositoryPage);
    await click(labels.syncGitHub);
    assert.equal(document.querySelector('[role="status"]')?.textContent, labels[key]);
  }
  delete h.syncResult;
  // Navigation must unmount the public page and mount the destination notice,
  // rather than merely record a route change while leaving the source visible.
  h.openForkDestination = true;
  for (const result of [
    { status: 'skipped', code: 'koi_skills_unavailable' },
    { status: 'unchanged', warningCode: 'github_credential_unavailable' },
    { status: 'skipped', code: 'publication_license_mismatch' },
    { status: 'skipped', code: 'license_changed', warningCode: 'github_credential_unavailable' },
  ]) {
    h.syncResult = result;
    await mount(AgentPublicRepositoryPage);
    await click(labels.forkRepository);
    assert.equal(document.querySelector('h1'), null, 'successful Fork leaves the source page');
    const expected = (result.status === 'unchanged' ? labels.syncUnchanged : result.code === 'koi_skills_unavailable' ? labels.githubKoiSkillsUnavailable : result.code === 'license_changed' ? labels.githubLicenseChanged : labels.githubPublicationLicenseMismatch)
      + (result.warningCode ? ' ' + labels.githubCredentialPublicFallback : '');
    assert.ok(document.querySelector('[role="status"]')?.textContent.includes(expected), 'the destination preserves the preparation notice');
    const target = h.forkDestination;
    assert.deepEqual(client.getQueryData([AGENT_REPOSITORY_FORK_NOTICE_QUERY_KEY, target.userId, target.workspaceId]), result);
    await act(async () => renderForkDestination({ ...target, userId: target.userId + 1 })); await settle();
    assert.equal(document.querySelector('[role="status"]'), null, 'another account cannot see this notice');
    await act(async () => renderForkDestination({ ...target, workspaceId: target.workspaceId + 1 })); await settle();
    assert.equal(document.querySelector('[role="status"]'), null, 'another repository cannot see this notice');
    await act(async () => renderForkDestination(target)); await settle();
    assert.ok(document.querySelector('[role="status"]')?.textContent.includes(expected));
    await click(zh.announcements.close);
    assert.equal(document.querySelector('[role="status"]'), null, 'the destination notice is dismissible');
    await act(async () => renderForkDestination(target)); await settle();
    assert.equal(document.querySelector('[role="status"]'), null, 'dismissed notices do not reappear on remount');
  }
  delete h.openForkDestination;
  delete h.forkDestination;
  delete h.syncResult;
  // Successful public access must keep both its real result and the credential
  // warning visible, including during preparation before Fork and Clone.
  for (const status of ['updated', 'unchanged', 'skipped']) {
    h.syncResult = { status, warningCode: 'github_credential_unavailable', ...(status === 'skipped' ? { code: 'publication_license_mismatch' } : {}) };
    const key = status === 'updated' ? 'syncUpdated' : status === 'unchanged' ? 'syncUnchanged' : 'githubPublicationLicenseMismatch';
    await mount(AgentPublicRepositoryPage);
    await click(labels.syncGitHub);
    assert.equal(document.querySelector('[role="status"]')?.textContent, labels[key] + ' ' + labels.githubCredentialPublicFallback);
    for (const action of ['clone', 'fork']) {
      await mount(AgentPublicRepositoryPage);
      const previous = calls.filter(call => call.path.endsWith(`/${action}`)).length;
      if (action === 'fork') await click(labels.forkRepository);
      else { await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent); }
      assert.equal(calls.filter(call => call.path.endsWith(`/${action}`)).length, previous + 1);
      assert.ok(document.body.textContent.includes(labels[key] + ' ' + labels.githubCredentialPublicFallback));
      assert.equal(document.querySelector('[role="alert"]'), null);
      if (action === 'clone') await click(zh.space.syncCancel);
    }
  }
  delete h.syncResult;
  for (const [state, key] of [['archived', 'githubUpstreamArchivedNotice'], ['disabled', 'githubUpstreamDisabledNotice'], ['unavailable', 'githubUpstreamUnavailableNotice'], ['private', 'githubUpstreamPrivateNotice']]) {
    publicRepository.githubSource.upstreamStatus = state;
    await mount(AgentPublicRepositoryPage);
    assert.ok(document.body.textContent.includes(labels[key]), `${state} has its own attribution explanation`);
    h.syncResult = { status: 'skipped', code: state };
    await click(labels.syncRecheckGitHub);
    delete h.syncResult;
    assert.equal(document.querySelector('[role="status"]')?.textContent, labels[key]);
    await mount(AgentPublicRepositoriesPage);
    assert.equal(document.querySelector('.hub-repository-card span[title]')?.getAttribute('title'), labels[key]);
  }
  delete publicRepository.githubSource.upstreamStatus;

  // Same-revision republication during an action must conflict and recover the
  // new publication before the next request creates a Fork or Clone prompt.
  for (const action of ['clone', 'fork']) {
    publicRepository.license = 'MIT';
    await mount(AgentPublicRepositoryPage);
    const original = structuredClone(publicRepository);
    const release = hold('POST', `/api/agent/repositories/7/${action}`);
    if (action === 'fork') await click(labels.forkRepository);
    else { await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent); }
    const stale = calls.findLast(call => call.path.endsWith(`/${action}`)).body;
    assert.equal(stale.expectedPublication, original.publicationId);
    publicRepository.license = 'Apache-2.0';
    publicRepository.publicationId = original.publicationId + '-republished';
    const manifest = new URL(publicRepository.manifestUrl);
    manifest.searchParams.set('publication', publicRepository.publicationId);
    publicRepository.manifestUrl = manifest.toString();
    await act(async () => release()); await settle();
    assert.equal(publicRepository.revision, original.revision, 'the race changes no file revision');
    assert.ok(document.querySelector('[role="alert"]'), 'republication is reported as a conflict');
    assert.equal(document.querySelector('textarea'), null, 'a conflicting Clone must not generate stale license instructions');
    await assert.rejects(() => loadAgentWorkspaceFiles(original, new Set(original.files.map(file => file.fileId)), () => {}, undefined, publicAgentRepositoryTransferSource(original)), error => error.code === 'transferChanged');
    if (action === 'fork') await click(labels.forkRepository);
    else { await click(labels.repositoryActions); await click(zh.space.configSnapshots.syncWithAgent); }
    const retried = calls.findLast(call => call.path.endsWith(`/${action}`)).body;
    assert.equal(retried.expectedPublication, publicRepository.publicationId);
    assert.notEqual(retried.requestId, stale.requestId, 'a conflict starts a new operation');
    if (action === 'clone') {
      const prompt = document.querySelector('textarea')?.value;
      assert.ok(prompt.includes('"license": "Apache-2.0"'));
      assert.ok(prompt.includes('"publicationId": "' + publicRepository.publicationId + '"'));
      assert.ok(prompt.includes('&publication='), 'installation pins file requests as well as the manifest');
      await click(zh.space.syncCancel);
    }
  }

  // Private workspaces and unpublished Forks share this attribution component.
  h.publication = null;
  workspace.githubSource = { ...githubSource, upstreamStatus: 'private' };
  await mount(AgentRepositorySharingCard, {workspace});
  assert.ok(document.body.textContent.includes(labels.notPublished));
  assert.ok(document.body.textContent.includes(labels.githubUpstreamPrivateNotice));
  assert.ok(!document.body.textContent.includes('已保存的公开版本'), 'the private notice must not claim this workspace is published');

  console.log('Repository sharing/category retention, system ownership, Hub filters/navigation/pagination, real-router URL validation, refetch/page retries, confirmed revisions, Star, Clone, attribution, and late route/account sync races passed');
} finally {
  await act(async()=>root.unmount());client?.clear();stop();delete globalThis.__sharingTest;
}
