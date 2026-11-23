import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseHTML} from 'linkedom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
const temporary=mkdtempSync(process.cwd()+'/scripts/.review-tabs-');
const nativeFetch=globalThis.fetch,roots=[],clients=[];
let apiA,apiB,saver,logout,finishSave,saving;
try {
 const compiled=await build({stdin:{contents:`export {useDocumentSaver} from './components/editor/useDocumentSaver';export {sessionQueryOptions,useLogout} from './auth';export {conflictDraftKey,clearConflictDrafts} from './conflictDrafts';`,resolveDir:process.cwd()+'/spa/src'},bundle:true,write:false,format:'esm',platform:'node',packages:'external',logLevel:'error'});
 for(const tab of ['A','B'])writeFileSync(temporary+'/tab'+tab+'.mjs',compiled.outputFiles[0].text);
 [apiA,apiB]=await Promise.all(['A','B'].map(tab=>import(pathToFileURL(temporary+'/tab'+tab+'.mjs').href)));
 const {window}=parseHTML('<html><body><div id="a"></div><div id="b"></div></body></html>');
 globalThis.window=window;globalThis.document=window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const storage=new Map();let beforeWrite;window.localStorage={get length(){return storage.size},key:i=>[...storage.keys()][i]??null,getItem:key=>storage.get(key)??null,setItem:(key,value)=>{beforeWrite?.(key);storage.set(key,String(value));},removeItem:key=>storage.delete(key)};
 let signedIn=true,delay;
 globalThis.fetch=async(path,init={})=>{
  if(path==='/api/auth/session')return signedIn?Response.json({user:{authUserId:'A'}}):Response.json({code:'unauthorized'},{status:401});
  if(path==='/api/auth/logout'){signedIn=false;return Response.json({success:true});}
  if(init.method==='PUT')return delay??Response.json({code:'document_revision_conflict'},{status:409});
  throw Error('Unexpected request '+path);
 };
 const flush=work=>act(async()=>{await work?.();await new Promise(resolve=>setTimeout(resolve,5));});
 function TabA(){saver=apiA.useDocumentSaver(undefined,'A');return null;}
 function TabB(){logout=apiB.useLogout();return null;}
 const first=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{gcTime:Infinity}}});
 const second=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{gcTime:Infinity}}});clients.push(first,second);
 await first.fetchQuery(apiA.sessionQueryOptions(first));await second.fetchQuery(apiB.sessionQueryOptions(second));
 for(const [id,client,component]of [['a',first,TabA],['b',second,TabB]]){const root=createRoot(document.getElementById(id));roots.push(root);await flush(()=>root.render(React.createElement(QueryClientProvider,{client},React.createElement(component))));}
 const base={title:'Article',content:'Cloud body',theme:'minimal',revision:1};
 await flush(async()=>{saver.seed('doc',base);saver.queue('doc',{content:'Sensitive unfinished text before logout'});assert.equal(await saver.flush('doc'),false);});
 const key=apiA.conflictDraftKey('doc','A');assert.equal(storage.has(key),true);
 delay=new Promise(resolve=>{finishSave=resolve;});
 await flush(()=>{saver.queue('doc',{content:'Sensitive latest unfinished text'});saving=saver.flush('doc');});
 await flush(()=>logout());assert.equal(storage.has(key),false,'explicit logout initially clears shared storage');
 await flush(()=>first.fetchQuery({...apiA.sessionQueryOptions(first),staleTime:0}));assert.equal(first.getQueryData(['session']).user,null);
 await flush(async()=>{finishSave(Response.json({code:'unauthorized'},{status:401}));assert.equal(await saving,false);});delay=null;
 assert.equal(storage.has(key),false,'another tab cannot recreate drafts after explicit logout');
 // Old format ownership is persisted for independent-module logout cleanup.
 const legacyKey=apiA.conflictDraftKey('old-doc');
 storage.set(legacyKey,JSON.stringify({...base,owner:'A',content:'Legacy fallback from another tab'}));
 const unownedLegacy=apiA.conflictDraftKey('unowned-old-doc');storage.set(unownedLegacy,JSON.stringify({...base,content:'Unattributed old backup'}));
 await flush(()=>apiB.clearConflictDrafts('A'));
 assert.equal(storage.has(legacyKey),false,'independent tab cleanup removes attributed legacy backup');
 assert.equal(storage.has(unownedLegacy),false,'logout also removes global legacy backups when attribution could not fit');
 const result={case:'independent_tab_logout_does_not_revoke_other_tab_backup_writes',moduleInstancesIndependent:apiA!==apiB,explicitLogoutInitiallyRemovedBackup:true,otherTabRecognized401:true,otherTabSession:null,backupRecreatedAfterLogout:false,actual:['production saver/auth/sessionCache/conflictDrafts/API','React and independent QueryClients','two independent production bundles with separate module globals'],simulated:['HTTP auth/logout/save results','Linkedom and shared Web Storage','late save response']};
 await flush(()=>roots[0].unmount());roots.shift();signedIn=true;
 const fresh=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{gcTime:Infinity}}});clients.push(fresh);
 await fresh.fetchQuery(apiA.sessionQueryOptions(fresh));const reopened=createRoot(document.getElementById('a'));roots.push(reopened);
 await flush(()=>reopened.render(React.createElement(QueryClientProvider,{client:fresh},React.createElement(TabA))));
 await flush(async()=>{saver.seed('doc',base);saver.queue('doc',{content:'New authenticated draft'});assert.equal(await saver.flush('doc'),false);});
 assert.equal(JSON.parse(storage.get(key)).content,'New authenticated draft','a new authenticated editor can create a fresh backup');
 beforeWrite=target=>{if(target===key){beforeWrite=undefined;apiB.clearConflictDrafts('A');}};
 await flush(async()=>{saver.queue('doc',{content:'Concurrent write after revocation'});await saver.flush('doc');});
 assert.equal(storage.has(key),false,'a revocation interleaved with setItem is caught by the post-write check');
 await flush(()=>reopened.unmount());roots.splice(roots.indexOf(reopened),1);
 await fresh.fetchQuery({...apiA.sessionQueryOptions(fresh),staleTime:0});
 const migrationRoot=createRoot(document.getElementById('a'));roots.push(migrationRoot);
 await flush(()=>migrationRoot.render(React.createElement(QueryClientProvider,{client:fresh},React.createElement(TabA))));
 const migratingKey=apiA.conflictDraftKey('migration','A');
 storage.set(migratingKey,JSON.stringify({...base,content:'Recovery interrupted by logout',conflict:true}));
 beforeWrite=target=>{if(target===migratingKey){beforeWrite=undefined;apiB.clearConflictDrafts('A');}};
 await flush(()=>saver.seed('migration',base));
 assert.equal(storage.has(migratingKey),false,'recovery migration cannot recreate a draft when another tab logs out during its write');
 console.log('independent browser modules: logout/401 revoke late writes; fresh login recovers permission; interleaved backup and recovery writes leave no backup');
} finally {
 apiA?.clearConflictDrafts('A');apiB?.clearConflictDrafts('A');
 await act(async()=>{for(const root of roots)root.unmount();});for(const client of clients)client.clear();globalThis.fetch=nativeFetch;rmSync(temporary,{recursive:true,force:true});
}
