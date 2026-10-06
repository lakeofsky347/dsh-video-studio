import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceDraftStore, type SourceDraft } from '../src/client/source-drafts.ts';

const storageKey='dsh-video-studio.source-drafts.v1';

function memoryStorage() {
  const values=new Map<string,string>();
  return {
    values,
    getItem(key:string):string|null{return values.get(key)??null;},
    setItem(key:string,value:string):void{values.set(key,value);},
    removeItem(key:string):void{values.delete(key);},
  };
}

function draft(projectId='project-a',shotId='shot-a'):SourceDraft {
  return {
    projectId,shotId,baseRevision:7,updatedAt:'2026-10-06T00:00:00.000Z',
    source:{html:'<h1>草稿</h1>',css:'h1 { color: red; }',js:'export function render() {}',shotPatch:{assetIds:['asset-a']}},
  };
}

test('a new store restores drafts persisted by the previous instance',()=>{
  const storage=memoryStorage(),first=new SourceDraftStore(storage),value=draft();
  first.set(value);
  assert.equal(storage.values.size,1);
  assert.ok(storage.values.has(storageKey));
  const restored=new SourceDraftStore(storage);
  assert.deepEqual(restored.get(value.projectId,value.shotId),value);
  assert.deepEqual(restored.list(value.projectId),[value]);
  assert.equal(restored.warning,'');
});

test('the same shot ID remains isolated between projects and tuple keys cannot collide',()=>{
  const storage=memoryStorage(),store=new SourceDraftStore(storage);
  const a=draft('project-a','shared-shot'),b=draft('project-b','shared-shot');
  b.source.html='另一个工程';
  store.set(a);store.set(b);store.set(draft('project\u0000shot','a'));store.set(draft('project','shot\u0000a'));
  const restored=new SourceDraftStore(storage);
  assert.deepEqual(restored.get('project-a','shared-shot'),a);
  assert.deepEqual(restored.get('project-b','shared-shot'),b);
  assert.equal(restored.list('project-a').length,1);
  assert.equal(restored.list('project-b').length,1);
  assert.ok(restored.get('project\u0000shot','a'));
  assert.ok(restored.get('project','shot\u0000a'));
});

test('a quota failure retains edited drafts in memory and reports session-only storage',()=>{
  const storage=memoryStorage();let blocked=true;
  const store=new SourceDraftStore({...storage,setItem(key:string,value:string){if(blocked)throw new Error('QuotaExceededError');storage.setItem(key,value);}});
  const value=draft();store.set(value);
  assert.deepEqual(store.get(value.projectId,value.shotId),value);
  assert.equal(store.persist(),false);
  assert.match(store.warning,/仅保留在本次会话/);
  blocked=false;
  assert.equal(store.persist(),true);
  assert.equal(store.warning,'');
  assert.deepEqual(new SourceDraftStore(storage).get(value.projectId,value.shotId),value);
});

test('storage read and removal failures do not throw or revert in-memory edits',()=>{
  const store=new SourceDraftStore({getItem(){throw new Error('SecurityError');},setItem(){throw new Error('SecurityError');},removeItem(){throw new Error('SecurityError');}});
  assert.match(store.warning,/仅保留在本次会话/);
  const value=draft();store.set(value);
  assert.deepEqual(store.get(value.projectId,value.shotId),value);
  store.delete(value.projectId,value.shotId);
  assert.equal(store.get(value.projectId,value.shotId),undefined);
  assert.equal(store.persist(),false);
  assert.match(store.warning,/仅保留在本次会话/);
});

test('delete persists only the selected draft and removes the cache after the last deletion',()=>{
  const storage=memoryStorage(),store=new SourceDraftStore(storage);
  store.set(draft());store.set(draft('project-b'));
  store.delete('project-a','shot-a');
  const restored=new SourceDraftStore(storage);
  assert.equal(restored.get('project-a','shot-a'),undefined);
  assert.deepEqual(restored.get('project-b','shot-a'),draft('project-b'));
  restored.delete('project-b','shot-a');
  assert.equal(storage.values.has(storageKey),false);
  assert.deepEqual(new SourceDraftStore(storage).list('project-b'),[]);
});

test('set, get and list clone nested source data to prevent external mutation',()=>{
  const store=new SourceDraftStore(memoryStorage()),value=draft();
  store.set(value);
  value.source.html='外部修改';value.source.shotPatch!.assetIds!.push('outside');
  const read=store.get('project-a','shot-a')!;
  assert.deepEqual(read,draft());
  read.source.css='读取后修改';read.source.shotPatch!.assetIds!.push('read');
  const listed=store.list('project-a');
  listed[0]!.source.js='列表修改';listed[0]!.source.shotPatch!.assetIds!.push('list');listed.pop();
  assert.deepEqual(store.get('project-a','shot-a'),draft());
  assert.deepEqual(store.list('project-a'),[draft()]);
});

test('restore ignores malformed entries while accepting the required source fields',()=>{
  const storage=memoryStorage(),valid=draft();
  storage.setItem(storageKey,JSON.stringify([valid,null,{}, {...valid,projectId:''},{...valid,baseRevision:-1},{...valid,source:{html:'',css:'',js:42}}]));
  assert.deepEqual(new SourceDraftStore(storage).list('project-a'),[valid]);
  storage.setItem(storageKey,'invalid JSON');
  assert.deepEqual(new SourceDraftStore(storage).list('project-a'),[]);
  storage.setItem(storageKey,JSON.stringify({draft:valid}));
  assert.deepEqual(new SourceDraftStore(storage).list('project-a'),[]);
});

test('without window the store works as a pure in-memory cache',()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window');
  Reflect.deleteProperty(globalThis,'window');
  try {
    const store=new SourceDraftStore();store.set(draft());
    assert.deepEqual(store.get('project-a','shot-a'),draft());
    assert.equal(store.persist(),false);
    store.delete('project-a','shot-a');assert.deepEqual(store.list('project-a'),[]);
  } finally {
    if(descriptor)Object.defineProperty(globalThis,'window',descriptor);
  }
});

test('access to window.localStorage is guarded and browser storage is used by default',()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window'),storage=memoryStorage();
  try {
    Object.defineProperty(globalThis,'window',{configurable:true,value:{get localStorage(){throw new Error('SecurityError');}}});
    const denied=new SourceDraftStore();denied.set(draft());
    assert.deepEqual(denied.get('project-a','shot-a'),draft());
    assert.match(denied.warning,/仅保留在本次会话/);
    Object.defineProperty(globalThis,'window',{configurable:true,value:{localStorage:storage}});
    new SourceDraftStore().set(draft());
    assert.deepEqual(new SourceDraftStore().get('project-a','shot-a'),draft());
  } finally {
    if(descriptor)Object.defineProperty(globalThis,'window',descriptor);
    else Reflect.deleteProperty(globalThis,'window');
  }
});
