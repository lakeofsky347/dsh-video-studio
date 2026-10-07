import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionDirectory, sessionTarget, type HostSessionList } from '../src/client/session-host-adapter.ts';
import { isDelegatedSession, projectSessions, resolveSessionBinding, type SessionDirectoryEntry } from '../src/client/session-directory.ts';
import type { SessionBindings } from '../src/shared/types.ts';

const workspaces={items:[],archivedSessionIds:[]};
const binding=(id:string)=>({currentProjectId:id,relatedProjectIds:[id],updatedAt:'2026-10-07T00:00:00.000Z'});
function directory():HostSessionList{return {
  ids:['lead','fork'],
  byId:{
    lead:{id:'lead',displayTitle:'主会话',cwd:'/films/one',updatedAt:20},
    fork:{id:'fork',displayTitle:'普通分叉',parentId:'lead',updatedAt:10},
    unrelated:{id:'unrelated',displayTitle:'保留的旧子代理',origin:'subagent',parentId:'gone'},
  },
  projectionsBySession:{},
};}

test('homepage Session directory uses host catalog membership, excluding unrelated retained fallback rows',()=>{
  const rows=sessionDirectory(directory(),workspaces);
  assert.deepEqual(rows.map(row=>row.id),['lead','fork']);
  assert.equal(rows[0]!.displayTitle,'主会话');
  assert.equal(rows.find(row=>row.id==='fork')!.rootSessionId,'fork');
});

test('cold subagent catalog discovers children with the current durable title and parent archive state',()=>{
  const list=directory();
  list.byId.child={id:'child',displayTitle:'更新后的镜头导演',title:'更新后的镜头导演',origin:'subagent',parentId:'lead'};
  list.projectionsBySession!.lead={values:{subagentCatalog:[{id:'child',mode:'one-shot',label:'旧创建标签'}]}};
  const rows=sessionDirectory(list,{items:[],archivedSessionIds:['lead']});
  const child=rows.find(row=>row.id==='child');assert.ok(child);
  assert.equal(child.kind,'subagent');assert.equal(child.displayTitle,'更新后的镜头导演');
  assert.equal(child.rootSessionId,'lead');assert.equal(child.archived,true);
  assert.equal(child.cwd,'/films/one');
});

test('team projection includes active teammates once, excludes provisioning and failed members',()=>{
  const list=directory();
  list.projectionsBySession!.lead={values:{
    subagentCatalog:[{id:'writer',mode:'continuable',label:'writer'}],
    agentTeam:{members:[
      {id:'lead',name:'lead',role:'lead',phase:'active'},
      {id:'writer',name:'分镜编剧',role:'teammate',phase:'active'},
      {id:'starting',name:'启动中的成员',role:'teammate',phase:'provisioning'},
      {id:'failed',name:'失败成员',role:'teammate',phase:'failed'},
    ],tasks:[]},
  }};
  const rows=sessionDirectory(list,workspaces);
  assert.equal(rows.filter(row=>row.id==='writer').length,1);
  const member=rows.find(row=>row.id==='writer');assert.ok(member);
  assert.equal(member.kind,'team');assert.equal(member.teamId,'lead');
  assert.equal(member.displayTitle,'分镜编剧');assert.equal(member.rootSessionId,'lead');
  assert.equal(rows.some(row=>['starting','failed'].includes(row.id)),false);
});

test('discovered nested catalogs retain the exact direct parent and root without host-list child membership',()=>{
  const list=directory();
  list.projectionsBySession!.lead={values:{subagentCatalog:[{id:'child',mode:'continuable',label:'镜头导演'}]}};
  list.projectionsBySession!.child={values:{subagentCatalog:[{id:'grandchild',mode:'one-shot',label:'布局助手'}]}};
  const rows=sessionDirectory(list,workspaces),grandchild=rows.find(row=>row.id==='grandchild');
  assert.ok(grandchild);assert.equal(grandchild.parentId,'child');assert.equal(grandchild.rootSessionId,'lead');
  assert.equal(grandchild.cwd,'/films/one');
  assert.deepEqual(sessionTarget('grandchild',list,()=>undefined),{parentSessionId:'child',childSessionId:'grandchild',mode:'one-shot'});
});

test('navigation preserves durable one-shot, continuable, and team addresses',()=>{
  const list=directory();list.projectionsBySession!.lead={values:{
    subagentCatalog:[{id:'once',mode:'one-shot'},{id:'resumable',mode:'continuable',label:'导演'}],
    agentTeam:{members:[{id:'teammate',name:'reviewer',role:'teammate',phase:'active'}],tasks:[]},
  }};
  assert.deepEqual(sessionTarget('once',list,()=>undefined),{parentSessionId:'lead',childSessionId:'once',mode:'one-shot'});
  assert.deepEqual(sessionTarget('resumable',list,()=>undefined),{parentSessionId:'lead',childSessionId:'resumable',mode:'continuable'});
  assert.deepEqual(sessionTarget('teammate',list,()=>undefined),{parentSessionId:'lead',childSessionId:'teammate',mode:'continuable'});
  const address={parentSessionId:'actual-parent',childSessionId:'once',mode:'one-shot' as const};
  assert.equal(sessionTarget('once',list,()=>address),address);
  assert.equal(sessionTarget('fork',list,()=>undefined),'fork');
  assert.throws(()=>sessionTarget('missing',list,()=>undefined),/暂不可用/);
});

test('unknown-mode children remain visible but cannot be opened through an ordinary Session transport',()=>{
  const list=directory();list.projectionsBySession!.lead={values:{subagentCatalog:[{id:'unknown',mode:'unknown',label:'旧任务'}]}};
  list.byId.unknown={id:'unknown',origin:'subagent',parentId:'lead',displayTitle:'旧任务'};
  assert.ok(sessionDirectory(list,workspaces).some(row=>row.id==='unknown'));
  assert.throws(()=>sessionTarget('unknown',list,()=>undefined),/宿主地址暂不可用/);
});

test('nested child and teammate routing follow nearest explicit binding; an explicit empty binding stops inheritance',()=>{
  const rows:SessionDirectoryEntry[]=[
    {id:'lead',displayTitle:'主会话',kind:'user',rootSessionId:'lead'},
    {id:'child',displayTitle:'镜头导演',origin:'subagent',kind:'subagent',parentId:'lead',rootSessionId:'lead'},
    {id:'grandchild',displayTitle:'布局助手',origin:'subagent',kind:'subagent',parentId:'child',rootSessionId:'lead'},
    {id:'team',displayTitle:'审片成员',origin:'subagent',kind:'team',parentId:'lead',rootSessionId:'lead'},
  ];
  const bindings:SessionBindings={lead:binding('film-A'),child:binding('film-B')};
  assert.deepEqual(resolveSessionBinding('grandchild',rows,bindings),{binding:bindings.child,ownerSessionId:'child',inherited:true});
  assert.deepEqual(resolveSessionBinding('team',rows,bindings),{binding:bindings.lead,ownerSessionId:'lead',inherited:true});
  bindings.grandchild={relatedProjectIds:[],updatedAt:'2026-10-07T00:00:00.000Z'};
  assert.deepEqual(resolveSessionBinding('grandchild',rows,bindings),{binding:bindings.grandchild,ownerSessionId:'grandchild',inherited:false});
  assert.deepEqual(projectSessions('film-A',rows,bindings).map(row=>row.id),['lead','team']);
});

test('ordinary forks never inherit a parent film or appear as delegated team tasks',()=>{
  const rows:SessionDirectoryEntry[]=[
    {id:'lead',displayTitle:'主会话',kind:'user',rootSessionId:'lead'},
    {id:'fork',displayTitle:'普通分叉',kind:'user',parentId:'lead',rootSessionId:'fork'},
  ];
  assert.equal(isDelegatedSession(rows[1]!),false);
  assert.deepEqual(resolveSessionBinding('fork',rows,{lead:binding('film-A')}),{inherited:false});
});

test('a malformed cyclic child lineage terminates without selecting an unrelated film',()=>{
  const rows:SessionDirectoryEntry[]=[
    {id:'a',displayTitle:'A',kind:'subagent',origin:'subagent',parentId:'b'},
    {id:'b',displayTitle:'B',kind:'subagent',origin:'subagent',parentId:'a'},
  ];
  assert.deepEqual(resolveSessionBinding('a',rows,{other:binding('film-X')}),{inherited:false});
});
