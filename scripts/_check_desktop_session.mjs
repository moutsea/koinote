import assert from 'node:assert/strict';
import { build, stop } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseHTML } from 'linkedom';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';

const dir=mkdtempSync(new URL('./.desktop-session-',import.meta.url).pathname);
const h=globalThis.__desktopSessionTest={};
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,CustomEvent:window.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true});
window.__TAURI_INTERNALS__={};
window.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
const mocks={
 '@tauri-apps/api/core':'export const invoke=(...args)=>globalThis.__desktopSessionTest.invoke(...args);',
 '@tauri-apps/plugin-opener':'export const openUrl=(url)=>globalThis.__desktopSessionTest.openUrl(url);',
 '@tauri-apps/plugin-http':'export const fetch=(...args)=>globalThis.__desktopSessionTest.fetch(...args);',
};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const user={authUserId:'synthetic-account-a',nickname:'A'};
const accountB={authUserId:'synthetic-account-b',nickname:'B'};
let stored,refreshes,clears,validRefresh,access,retired,requests,readFailure,writeFailure,updateGate;
function reset(){
 stored={accessToken:'knt_app_at_old',refreshToken:'knt_app_rt_old',accountId:user.authUserId,userJson:JSON.stringify(user)};
 refreshes=clears=0;validRefresh=stored.refreshToken;access=new Set();retired=new Map();requests=[];readFailure=writeFailure=false;updateGate=null;
 h.fetch=async(url,init)=>new URL(url).pathname==='/api/auth/desktop/token'?rotate(init):access.has(new Headers(init?.headers).get('Authorization')?.slice(7))?json({user}):json({code:'session_expired'},401);
}
// The native store's locked operations are emulated; the production auth,
// transport, API, session query and retry/error UI are all exercised unchanged.
h.invoke=async(cmd,args)=>{
 if(readFailure)throw Error('OS credential access denied');
 if(cmd==='desktop_pending_auth_store'){h.pending=args.pending;return;}
 if(cmd==='desktop_pending_auth_clear'){h.pending=null;return;}
 if(cmd==='desktop_session_get')return structuredClone(stored);
 if(cmd==='desktop_session_store'){stored=structuredClone(args.session);return;}
 if(cmd==='desktop_session_clear'){stored=null;clears++;return;}
 if(cmd==='desktop_session_prepare_refresh'){
  if(stored?.accessToken===args.accessToken&&!stored.refreshRequestId)stored.refreshRequestId=args.requestId;
  return structuredClone(stored);
 }
 if(cmd==='desktop_session_replace'){
  if(writeFailure){writeFailure=false;throw Error('OS credential write failed');}
  if(stored?.refreshToken===args.expectedRefreshToken&&(stored.refreshRequestId??null)===args.expectedRequestId){stored=structuredClone(args.session);if(!stored)clears++;}
  return structuredClone(stored);
 }
 if(cmd==='desktop_session_update_user'){
  if(updateGate)await updateGate.promise;
  if(stored?.accountId===args.accountId)stored.userJson=args.userJson;
  return;
 }
 throw Error('Unexpected native command: '+cmd);
};
function rotate(init){
 const body=JSON.parse(init.body);requests.push(body);
 if(body.refreshToken!==validRefresh){
  const prior=retired.get(body.refreshToken);
  if(!prior||prior.attempt!==body.refreshRequestId||prior.child!==validRefresh)return json({code:'desktop_token_invalid'},401);
 }else{
  assert.match(body.refreshRequestId,/^[A-Za-z0-9_-]{43}$/,'refresh attempt must be persisted before use');
  refreshes++;
  const child='knt_app_rt_new_'+refreshes;
  retired.set(validRefresh,{attempt:body.refreshRequestId,child});validRefresh=child;
 }
 const at='knt_app_at_new_'+requests.length;access.add(at);
 return json({accessToken:at,refreshToken:validRefresh,user,tokenType:'Bearer',expiresInSeconds:900});
}
let root;
try{
 const result=await build({stdin:{contents:`
 export {refreshDesktopSession,updateCachedDesktopUser,clearDesktopSession} from './spa/src/desktop/auth';
 export {desktopFetch} from './spa/src/desktop/network';
 export {getSession} from './spa/src/api';
 export {sessionQueryOptions} from './spa/src/auth';
 export {DesktopSessionError} from './spa/src/components/DesktopSessionError';
 export {DesktopCredentialStoreError,DesktopSessionChangedError,DesktopAccountMismatchError} from './spa/src/desktop/sessionErrors';
 `,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node',packages:'external',jsx:'automatic',logLevel:'error',plugins:[{name:'desktop-test-io',setup(b){
 b.onResolve({filter:/.*/},({path,importer})=>{
  if(path==='../i18n'&&importer.endsWith('/DesktopSessionError.tsx'))return {path:'labels',namespace:'mock'};
  return Object.hasOwn(mocks,path)?{path,namespace:'mock'}:undefined;
 });
 b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='labels'?`export const useI18n=()=>({t:{desktopAuth:{sessionUnavailable:'Cannot check sign-in',credentialsUnavailable:'Unlock your keychain and retry',sessionRetryHint:'Try again later',retrySession:'Retry',accountMismatch:'Account mismatch: saved documents kept',reauthorize:'Authorize again',reauthorizeOpened:'Complete authorization in your browser',failed:'Authorization failed'}}});`:mocks[path],loader:'js'}));
 }}]});
 const modulePath=dir+'/bundle.mjs';writeFileSync(modulePath,result.outputFiles[0].text);const api=await import(pathToFileURL(modulePath));
 const {QueryClient}=await import('@tanstack/react-query');

 // A first launch with no credentials must expose login/local mode immediately,
 // even offline or during deployment. An unreadable store is different.
 for(const unavailable of ['offline',503]){
  reset();stored=null;let networkCalls=0;
  h.fetch=async()=>{networkCalls++;if(unavailable==='offline')throw TypeError('offline');return json({},unavailable);};
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
  assert.deepEqual(await client.fetchQuery(api.sessionQueryOptions(client)),{user:null,revocationVersion:0});
  assert.equal(client.getQueryState(['session']).status,'success','an empty store must not activate the blocking error page');
  assert.equal(networkCalls,0,'signed-out startup must not wait on the network');
  assert.equal(clears,0);client.clear();
 }
 reset();h.fetch=async()=>{stored=null;throw TypeError('offline after local logout');};
 assert.deepEqual(await api.getSession(),{user:null},'logout during an unavailable request must keep login/local mode reachable');

 reset();h.fetch=async()=>json({error:'Temporarily unavailable'},503);
 assert.equal((await api.getSession()).user.authUserId,user.authUserId);assert.equal(clears,0);
 for(const status of [400,401,403]){
  h.fetch=async()=>new Response('Gateway unavailable',{status});
  assert.equal((await api.getSession()).user.authUserId,user.authUserId,'gateway responses must not sign out the user');assert.equal(clears,0);
 }

 reset();let lose=true;
 h.fetch=async(url,init)=>{const response=rotate(init);if(lose){lose=false;throw TypeError('Response interrupted after commit');}return response;};
 await assert.rejects(api.refreshDesktopSession(),/interrupted/);
 const pending=structuredClone(stored);
 assert.ok(pending.refreshRequestId);assert.equal(refreshes,1);
 const recovered=await api.refreshDesktopSession();assert.equal(recovered.refreshToken,validRefresh);assert.equal(refreshes,1);
 assert.deepEqual(requests[0],requests[1],'retry must keep both parent token and attempt secret');assert.equal(stored.refreshRequestId,undefined);

 reset();writeFailure=true;
 await assert.rejects(api.refreshDesktopSession(),api.DesktopCredentialStoreError);
 assert.ok(stored.refreshRequestId);await api.refreshDesktopSession();assert.equal(refreshes,1);assert.equal(stored.refreshToken,validRefresh);

 reset();updateGate=deferred();const profile=api.updateCachedDesktopUser({...user,nickname:'Updated'});
 await api.refreshDesktopSession();const latest=stored.refreshToken;updateGate.resolve();await profile;
 assert.equal(stored.refreshToken,latest,'updating profile must not restore stale tokens');assert.equal(JSON.parse(stored.userJson).nickname,'Updated');
 stored={...stored,accountId:accountB.authUserId,userJson:JSON.stringify(accountB)};
 await api.updateCachedDesktopUser(user);assert.equal(JSON.parse(stored.userJson).authUserId,accountB.authUserId,'late profile response must not mix accounts');

 reset();const late=deferred(),sessionRetry=deferred(),retryStarted=deferred();let docsFirst=true;
 h.fetch=async(url,init)=>{
  const path=new URL(url).pathname;if(path==='/api/auth/desktop/token')return rotate(init);
  const at=new Headers(init.headers).get('Authorization')?.slice(7);
  if(path==='/api/documents'&&docsFirst){docsFirst=false;return late.promise;}
  if(path==='/api/auth/session'&&at!=='knt_app_at_old'){retryStarted.resolve();await sessionRetry.promise;}
  return access.has(at)?json({user}):json({code:'session_expired'},401);
 };
 const sessionRequest=api.desktopFetch('/api/auth/session');const docsRequest=api.desktopFetch('/api/documents');
 await retryStarted.promise;late.resolve(json({code:'session_expired'},401));assert.equal((await docsRequest).status,200);
 sessionRetry.resolve();assert.equal((await sessionRequest).status,200);assert.equal(refreshes,1,'delayed old 401 must reuse the new token');

 for(const invalid of [false,true]){
  reset();const gate=deferred(),started=deferred();
  h.fetch=async(url,init)=>{const response=invalid?json({code:'desktop_token_invalid'},401):rotate(init);started.resolve();await gate.promise;return response;};
  const pendingRefresh=api.refreshDesktopSession();await started.promise;await api.clearDesktopSession();gate.resolve();await pendingRefresh;
  assert.equal(stored,null,'late refresh must not undo logout');
  reset();const newGate=deferred(),newStarted=deferred();
  h.fetch=async(url,init)=>{const response=invalid?json({code:'desktop_token_invalid'},401):rotate(init);newStarted.resolve();await newGate.promise;return response;};
  const stale=api.refreshDesktopSession();await newStarted.promise;
  stored={accessToken:'knt_app_at_b',refreshToken:'knt_app_rt_b',accountId:accountB.authUserId,userJson:JSON.stringify(accountB)};
  newGate.resolve();await stale;assert.equal(stored.accountId,accountB.authUserId,'late success/rejection must not overwrite or clear a new login');
 }

 reset();const switching=deferred(),refreshStarted=deferred();
 h.fetch=async(url,init)=>{if(new URL(url).pathname!=='/api/auth/desktop/token')return json({code:'session_expired'},401);const response=rotate(init);refreshStarted.resolve();await switching.promise;return response;};
 const oldMutation=assert.rejects(api.desktopFetch('/api/documents',{method:'POST',body:'old-account-write'}),api.DesktopSessionChangedError);
 await refreshStarted.promise;stored={accessToken:'knt_app_at_b',refreshToken:'knt_app_rt_b',accountId:accountB.authUserId,userJson:JSON.stringify(accountB)};switching.resolve();await oldMutation;

 reset();h.fetch=async()=>json({code:'desktop_token_invalid'},401);
 const qc=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 const loggedOut=await qc.fetchQuery(api.sessionQueryOptions(qc));assert.equal(loggedOut.user,null);assert.equal(stored,null);qc.clear();

 reset();readFailure=true;
 await assert.rejects(api.getSession(),api.DesktopCredentialStoreError);assert.ok(stored);assert.equal(clears,0);
 let retries=0;root=createRoot(document.getElementById('root'));
 await act(async()=>root.render(React.createElement(api.DesktopSessionError,{error:new api.DesktopCredentialStoreError(),retrying:false,onRetry:()=>retries++})));
 assert.ok(document.body.textContent.includes('Unlock your keychain'));
 await act(async()=>document.querySelector('button').click());assert.equal(retries,1);
 await act(async()=>root.render(React.createElement(api.DesktopSessionError,{error:new api.DesktopCredentialStoreError(),retrying:true,onRetry:()=>retries++})));
 assert.equal(document.querySelector('button').disabled,true);
 readFailure=false;assert.equal((await api.getSession()).user.authUserId,user.authUserId,'retry after unlocking resumes the existing session');

 // A successful refresh for the wrong account is never accepted or concealed
 // by the offline fallback, even when React Query already holds user A.
 reset();
 h.fetch=async(url)=>new URL(url).pathname==='/api/auth/desktop/token'?json({accessToken:'knt_app_at_wrong',refreshToken:'knt_app_rt_wrong',user:accountB}):json({code:'session_expired'},401);
 const mismatchClient=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 mismatchClient.setQueryData(['session'],{user});
 await assert.rejects(mismatchClient.fetchQuery({...api.sessionQueryOptions(mismatchClient),staleTime:0}),api.DesktopAccountMismatchError);
 assert.equal(stored.accountId,user.authUserId);assert.equal(stored.accessToken,'knt_app_at_old');assert.ok(stored.refreshRequestId);assert.equal(clears,0);
 assert.equal(mismatchClient.getQueryData(['session']).user.authUserId,user.authUserId);
 let opened;
 h.openUrl=async(url)=>{opened=new URL(url);};
 await act(async()=>root.render(React.createElement(api.DesktopSessionError,{error:mismatchClient.getQueryState(['session']).error,retrying:false,onRetry:()=>{}})));
 assert.ok(document.body.textContent.includes('Account mismatch'));
 const authorize=Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Authorize again');
 assert.ok(authorize,'account mismatch must offer explicit recovery');
 await act(async()=>authorize.click());
 for(let i=0;i<100&&!opened;i++) await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
 assert.equal(opened.pathname,'/desktop/authorize');assert.equal(opened.searchParams.get('state'),h.pending.state);assert.ok(h.pending.codeVerifier);
 assert.equal(stored.accountId,user.authUserId);assert.equal(clears,0,'starting authorization must retain the old session until success');
 assert.ok(document.body.textContent.includes('Complete authorization in your browser'));
 h.openUrl=async()=>{throw Error('no browser');};
 await act(async()=>authorize.click());
 for(let i=0;i<100&&!document.body.textContent.includes('Authorization failed');i++) await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
 assert.ok(document.body.textContent.includes('Authorization failed'));assert.equal(authorize.disabled,false);assert.equal(clears,0);assert.equal(h.pending,null);
 mismatchClient.clear();
 console.log('Desktop session recovery, persisted attempts, atomic profile updates, delayed 401s, account changes, logout/rejection and keychain retry UI checks passed');
}finally{if(root)await act(async()=>root.unmount());stop();rmSync(dir,{recursive:true,force:true});delete globalThis.__desktopSessionTest;}
