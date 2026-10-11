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
const publicRepository = { ...workspace, starCount:0, starred:false, cloneCount:0, license: "MIT", url: "https://koinote.example/repositories/7", manifestUrl: "https://koinote.example/api/agent/repositories/7?revision=3" };
const calls = [], navigations = [], confirmations = [];
const h = globalThis.__sharingTest = {
  workspace, publicRepository, publication: null, source: null, labels: null,
  search: {}, directorySearch: {}, routeListeners: new Set(),
  user: { id: 1, membershipTier: "lifetime" }, enabled: true, confirmResult: true, failPublish: false, failFork: false, withdrawn: false, privateCalls: 0,
  navigate: async (target) => {
    const key = target.to === "/repositories" ? "directorySearch" : "search";
    const search = typeof target.search === "function" ? target.search(h[key]) : target.search;
    navigations.push({ ...target, search });
    if (target.to === "/repositories" || target.to === "/repositories/$repositoryId") {
      h[key] = search ?? {}; h.hash = target.hash;
      for (const listener of h.routeListeners) listener();
    }
  },
  confirm: async (message) => { confirmations.push(message); return h.confirmResult; },
  async api(path, init = {}) {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    if (path === "/api/agent/github-credential") {
      if (method === "PUT") h.credential = { configured: true, tokenHint: body.token.slice(-4) };
      if (method === "DELETE") h.credential = { configured: false };
      return { credential: h.credential ?? { configured: false } };
    }
    if (path === "/api/agent/workspaces/import/github") {
      if (h.failImport) throw new ApiError(422, "sensitive", "sensitive_data_detected");
      return { workspace: { ...workspace, workspaceId: 9 } };
    }
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
    if(path.endsWith("/clone")) {
      if(h.failClone) throw new ApiError(503,"Clone failed");
      if(!h.cloneIDs)h.cloneIDs=new Set();
      h.cloneIDs.add(body.requestId);publicRepository.cloneCount=h.cloneIDs.size;
      if(h.loseCloneResponse) throw new ApiError(503,"Clone response lost after recording");
      return {starred:publicRepository.starred,starCount:publicRepository.starCount,cloneCount:publicRepository.cloneCount};
    }
    if (path.endsWith("/fork")) {
      if (h.failFork) throw new ApiError(503, "network failure");
      return { workspace: { ...workspace, workspaceId: 8 } };
    }
    if (h.withdrawn) throw new ApiError(404, "withdrawn");
    if (h.extraFiles?.[path]) return { file: h.extraFiles[path] };
    if (path.includes("/files/21?revision=3")) return { file: { ...workspace.files[0], contentBase64: bytes.toString("base64") } };
    if (path.startsWith("/api/agent/repositories/7")) return { repository: publicRepository };
    if (path.startsWith("/api/agent/repositories?")) {
      const params=new URL(path,'https://koinote.example').searchParams;
      if (h.failDirectoryPage === (params.get('cursor') ?? 'first')) throw new ApiError(503,'Temporary directory failure');
      const entries=h.directory ?? [{...publicRepository,category:'other',fileCount:1,sizeBytes:bytes.length}];
      const searched=entries.filter(item=>(item.name+' '+item.description+' '+(item.githubSource?.author??'')).toLowerCase().includes((params.get('q')??'').toLowerCase()));
      const facets=[];
      for(const item of searched) {
        let facet=facets.find(f=>f.category===item.category&&f.systemManaged===Boolean(item.systemManaged));
        if(!facet) {facet={category:item.category,systemManaged:Boolean(item.systemManaged),count:0};facets.push(facet);} facet.count++;
      }
      const filtered=searched.filter(item=>(!params.get('category')||item.category===params.get('category'))&&(!params.get('source')||Boolean(item.systemManaged)===(params.get('source')==='system')));
      const start=Number(params.get('cursor')??0),size=h.directoryPageSize??12;
      return {repositories:filtered.slice(start,start+size),total:filtered.length,facets,nextCursor:start+size<filtered.length?String(start+size):null};
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
    export { AgentGitHubImportForm } from "./spa/src/components/AgentGitHubImportForm";
    export { AgentGitHubCredentialCard } from "./spa/src/components/AgentGitHubCredentialCard";
    export { SystemRepositoriesAdminPanel } from "./spa/src/components/SystemRepositoriesAdminPanel";
    export { AgentRepositorySharingCard } from "./spa/src/components/AgentRepositorySharingCard";
    export { AgentPublicRepositoryPage } from "./spa/src/pages/AgentPublicRepositoryPage";
    export { AgentPublicRepositoriesPage } from "./spa/src/pages/AgentPublicRepositoriesPage";
    export { parseRepositoryDirectorySearch } from "./spa/src/agentRepositoryDirectory";
    export { RepositoryMarkdown } from "./spa/src/components/RepositoryMarkdown";
    export { repositoryResource, repositoryReadme, repositoryPreview, repositoryFileHref, parseRepositorySearch, REPOSITORY_PREVIEW_BYTES } from "./spa/src/agentRepositoryMarkdown";
    export { publicAgentRepositoryTransferSource, publicRepositoryClonePrompt } from "./spa/src/agentRepositorySharing";
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
      "../auth": "export const useSession=()=>({data:{user:globalThis.__sharingTest.user}});",
      "../i18n": "export const useI18n=()=>({t:globalThis.__sharingTest.labels,locale:'zh'});",
      "../confirmAction": "export const confirmAction=(...args)=>globalThis.__sharingTest.confirm(...args);",
      "../desktop/runtime": "export const isDesktopRuntime=()=>false;",
      "./desktop/runtime": "export const isDesktopRuntime=()=>false;",
      "../modalStack": "export const pushModal=()=>()=>{};",
      "@tanstack/react-router": `import {createElement,useSyncExternalStore} from 'react';
        import {defaultStringifySearch} from '@tanstack/router-core';
        export {defaultStringifySearch};
        const subscribe=(listener)=>{globalThis.__sharingTest.routeListeners.add(listener);return ()=>globalThis.__sharingTest.routeListeners.delete(listener);};
        export const useParams=()=>({repositoryId:'7'});
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
const { createElement, act, createRoot, QueryClient, QueryClientProvider, useQuery, ApiError, SystemRepositoriesAdminPanel, AgentGitHubImportForm, AgentGitHubCredentialCard, AgentRepositorySharingCard, AgentPublicRepositoryPage, AgentPublicRepositoriesPage, RepositoryMarkdown, repositoryResource, repositoryReadme, repositoryPreview, repositoryFileHref, parseRepositorySearch, parseRepositoryDirectorySearch, REPOSITORY_PREVIEW_BYTES, publicAgentRepositoryTransferSource, publicRepositoryClonePrompt, loadAgentWorkspaceFiles, zh } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
h.labels = zh;
const labels = zh.agentWorkspace;
const emptyFilters={q:undefined,source:undefined,category:undefined};
const root = createRoot(document.getElementById("root"));
let client;
async function settle() { for (let i=0;i<3;i++) await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));}); }
async function mount(component,props={}) {
  await act(async()=>root.render(null));client?.clear();
  client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{retry:false,gcTime:Infinity}}});
  await act(async()=>root.render(createElement(QueryClientProvider,{client},createElement(component,props))));await settle();
}
function button(label) { const result=[...document.querySelectorAll('button')].find(item=>item.textContent===label);assert.ok(Boolean(result),`Missing button: ${label}`);return result; }
async function click(label) { await act(async()=>button(label).click());await settle(); }
function reactProps(element) { assert.ok(Boolean(element));return element[Object.keys(element).find(key=>key.startsWith('__reactProps'))]; }
async function input(selector,value) { await act(async()=>reactProps(document.querySelector(selector)).onChange({target:{value}}));await settle(); }
async function submit() { await act(async()=>reactProps(document.querySelector('form')).onSubmit({preventDefault(){}}));await settle(); }
async function consent(value) {
  const checkbox=document.querySelector('input[type="checkbox"]');
  const props=checkbox[Object.keys(checkbox).find(key=>key.startsWith('__reactProps'))];
  await act(async()=>props.onChange({target:{checked:value}}));await settle();
}
try {
  assert.equal(labels.publicRepositories, "Skills/Agent Hub");
  assert.equal(labels.githubImport, "从 GitHub 导入");
  assert.equal(labels.starRepository, "收藏");
  assert.equal(labels.changeComment, "变更说明（可选）");
  assert.ok(labels.publishConsent.includes("我已检查"));
  assert.ok(labels.publishConfirm.startsWith("将 r"));
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
  assert.ok(Boolean(document.querySelector('a[href="/pricing"]')),"free users get the Fork membership entry");
  assert.equal(button(labels.cloneRepository).disabled,false,"free users can clone");
  h.failStar=true;await click(`${labels.starRepository} · 0`);
  assert.ok(document.body.textContent.includes(labels.starFailed));
  h.failStar=false;await click(`${labels.starRepository} · 0`);
  assert.equal(publicRepository.starred,true,"free users can Star");
  await click(`${labels.unstarRepository} · 1`);assert.equal(publicRepository.starred,false);
  h.failClone=true;
  await click(labels.cloneRepository);await click(zh.space.configSnapshots.syncWithAgent);
  assert.ok(document.body.textContent.includes(labels.sharingUnavailable));
  const failedClone=calls.findLast(call=>call.path.endsWith('/clone')).body;
  h.failClone=false;
  await click(labels.cloneRepository);
  await click(zh.space.configSnapshots.syncWithAgent);
  assert.deepEqual(calls.findLast(call=>call.path.endsWith('/clone')).body,failedClone,"Clone retries preserve the request ID");
  const prompt=document.querySelector('textarea')?.value;
  assert.ok(prompt?.includes(publicRepository.manifestUrl));
  assert.ok(!prompt.includes('Authorization: Bearer'),"public clone must not mint or copy private tokens");
  assert.ok(prompt.includes('untrusted DATA')&&prompt.includes('SHA-256'));
  assert.equal(publicRepository.cloneCount,1,"a failed request followed by a successful retry counts once");
  await click(zh.space.syncCancel);
  h.loseCloneResponse=true;
  await click(labels.cloneRepository);await click(zh.space.configSnapshots.syncWithAgent);
  const nextClone=calls.findLast(call=>call.path.endsWith('/clone')).body;
  assert.notEqual(nextClone.requestId,failedClone.requestId,"a new Clone after success must use a new request ID");
  assert.equal(publicRepository.cloneCount,2,"another Clone on the same page counts separately");
  h.loseCloneResponse=false;
  await click(labels.cloneRepository);await click(zh.space.configSnapshots.syncWithAgent);
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

  h.enabled=false;
  await mount(AgentPublicRepositoryPage);
  assert.equal(button(labels.forkRepository).disabled,true);assert.ok(document.body.textContent.includes(labels.forkEnable));
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
  assert.deepEqual(parseRepositoryDirectorySearch({q:'  skills  ',source:'system',category:'design',file:'README.md'}),{q:'skills',source:'system',category:'design'});
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
  assert.equal(button(labels.revokeSharing).disabled,false,"authors retain withdrawal after sync/membership is disabled");
  await click(labels.revokeSharing);
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
  await input('input[type="password"]',secret);await submit();
  assert.equal(document.querySelector('input[type="password"]').value,'',"save clears the credential input");
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
  h.user=null;h.directoryPageSize=2;
  h.directory=[
    {workspaceId:101,name:'Design one',systemManaged:true,category:'design'},
    {workspaceId:102,name:'Build tools',systemManaged:true,category:'development'},
    {workspaceId:103,name:'Community design',systemManaged:false,category:'design'},
    {workspaceId:104,name:'Design two',systemManaged:true,category:'design'},
    {workspaceId:105,name:'Writing tools',systemManaged:false,category:'writing'},
    {workspaceId:106,name:'Focus agent',systemManaged:true,category:'design'},
  ].map(item=>({...publicRepository,fileCount:1,sizeBytes:bytes.length,...item}));
  await mount(AgentPublicRepositoriesPage);
  const cards=()=>[...document.querySelectorAll('[data-repository-card]')].map(card=>card.querySelector('h3').textContent);
  async function filter(label) {const target=[...document.querySelectorAll('button[aria-pressed]')].find(b=>b.textContent.startsWith(label));assert.ok(target,`Missing filter ${label}`);await act(async()=>target.click());await settle();}
  assert.deepEqual(cards(),['Design one','Build tools']);
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
  const savedFilters={q:'Portable',source:'system',category:'design'};
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
  for(const [raw,expected] of [
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
  console.log('Repository sharing/category retention, system ownership, Hub filters/navigation/pagination, real-router URL validation, refetch/page retries, confirmed revisions, Star, Clone and attribution checks passed');
} finally {
  await act(async()=>root.unmount());client?.clear();stop();delete globalThis.__sharingTest;
}
