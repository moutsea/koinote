import assert from 'node:assert/strict';
import { organizationChoices, organizationDrafts, organizationPath, organizationPollInterval } from './_ai_organizer_bundle.mjs';
const folders=[{id:'a',name:'Notes',parentId:''},{id:'b',name:'AI',parentId:'a'}];
assert.deepEqual(organizationPath(folders,'b'),['Notes','AI']);
assert.throws(()=>organizationPath(folders,'other-account'));
assert.throws(()=>organizationPath([{id:'a',name:'Cycle',parentId:'a'}],'a'));
const drafts=organizationDrafts([{docId:'one',suggested:{docId:'one',folderId:'b',newFolders:[],tags:['Go']}},{docId:'pending'}]);
assert.equal(drafts.one.selected,true);
assert.equal(drafts.pending,undefined);
const fallback=organizationDrafts([{docId:'review',needsReview:true,suggested:{folderId:'a',newFolders:[],tags:['Keep']}}]);
assert.equal(fallback.review.selected,false,'fallback suggestions require explicit confirmation');
assert.deepEqual(organizationChoices(fallback,folders),[]);
fallback.review.selected=true;
assert.deepEqual(organizationChoices(fallback,folders),[{docId:'review',folderId:'a',newFolders:[],tags:['Keep']}]);
drafts.one.tags=['Go', '#go', '数据库、性能', ''];
assert.deepEqual(organizationChoices(drafts,folders)[0].tags,['Go','数据库、性能']);
const originalTags=['商业、营销','a,b','中文，标签','"quoted"','full-width！'];
const preserved=organizationDrafts([{docId:'punctuation',suggested:{folderId:'',newFolders:[],tags:originalTags}}]);
assert.deepEqual(organizationChoices(preserved,folders)[0].tags, originalTags);
preserved.punctuation.tags[0]='修改后的标签、保留标点';
assert.equal(originalTags[0],'商业、营销', 'editing must not mutate the fetched preview');
assert.equal(organizationChoices(preserved,folders)[0].tags[0],'修改后的标签、保留标点');
drafts.one.newPath='系统设计/连接池';
assert.deepEqual(organizationChoices(drafts,folders)[0].newFolders,['系统设计','连接池']);
for(const invalid of ['../bad','a//b','x/'.repeat(8)+'x','x'.repeat(61),'control\x01']){
 assert.throws(()=>organizationChoices({...drafts,one:{...drafts.one,newPath:invalid}},folders));
}
assert.throws(()=>organizationChoices({...drafts,one:{...drafts.one,tags:['a','b','c','d','e','f']}},folders));
assert.throws(()=>organizationChoices({...drafts,one:{...drafts.one,tags:['太'.repeat(33)]}},folders));
for (let code = 0x80; code <= 0x9f; code++) {
 const control = String.fromCharCode(code);
 assert.throws(()=>organizationChoices({...drafts,one:{...drafts.one,newPath:`a${control}b`}},folders));
 assert.throws(()=>organizationChoices({...drafts,one:{...drafts.one,tags:[`a${control}b`]}},folders));
}
assert.deepEqual(organizationChoices({...drafts,one:{...drafts.one,selected:false,newPath:'invalid//path'}},folders),[]);

// Exercise the real QueryObserver lifecycle: a failed initial detail request
// must recover from the running status returned by /latest, then stop polling.
globalThis.window = {};
const {QueryClient, QueryObserver, timeoutManager} = await import('@tanstack/query-core');
timeoutManager.setTimeoutProvider({
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: id => clearTimeout(id),
  setInterval: (callback, delay) => setInterval(callback, Math.min(delay, 20)),
  clearInterval: id => clearInterval(id),
});
const client=new QueryClient();
let calls=0;
const observer=new QueryObserver(client,{
  queryKey:['organization-regression'],
  queryFn:async()=>{ if(++calls===1) throw Object.assign(new Error('temporary'),{status:503}); return {organization:{status:'ready'}}; },
  retry:false,
  refetchInterval: query=>organizationPollInterval(query.state.data?.organization.status,'running',query.state.error?.status),
});
const unsubscribe=observer.subscribe(()=>{});
try {
  const deadline=Date.now()+2000;
  while(observer.getCurrentResult().data?.organization.status!=='ready' && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(observer.getCurrentResult().data?.organization.status,'ready');
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(calls,2,'terminal detail status must override stale running status');
  assert.equal(organizationPollInterval(undefined,'running',401),false);
  assert.equal(organizationPollInterval('running','running',404),false);
  assert.equal(organizationPollInterval(undefined,'running',429),5000);
  assert.equal(organizationPollInterval(undefined,'running'),1500);
} finally { unsubscribe(); client.clear(); delete globalThis.window; }
console.log('AI organizer: lossless tags, editable destinations, exclusions, validation and failed-first-read recovery passed');
