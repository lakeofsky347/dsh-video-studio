// Read-only checks against the restarted owned native host and its persisted Session projects.
import {request} from 'playwright-core';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const root=path.resolve(process.env.DSH_ACCEPTANCE_ROOT??'artifacts/verification/v0.2'),reportPath=path.join(root,'native/restart.json');
const report=JSON.parse(await readFile(reportPath,'utf8')),session=JSON.parse(await readFile(path.join(root,'native-session/session-acceptance.json'),'utf8'));
assert.equal(report.status,'PASS');assert.equal(report.archiveSha256,session.archiveSha256);
const api=await request.newContext(),url=process.env.DSH_TEST_URL;assert.ok(url);await api.get(url);
const base=new URL(url).origin;
async function current(sessionId){const response=await api.post(base+'/api/video-studio/current',{data:{type:'client-request',rpcId:randomUUID(),method:'video-studio/current',payload:sessionId?{sessionId}:{}}});assert.ok(response.ok());const data=await response.json();assert.equal(data.result.ok,true);return data.result.value;}
try{
 const before=await current(),evidence=[];
 for(const [index,sessionId] of session.sessionIds.entries()){
  const original=JSON.parse(await readFile(path.join(session.projects[index===0?'a':'b'],'project.json'),'utf8')),restored=await current(sessionId);
  assert.equal(restored.project.id,original.id);assert.equal(restored.project.revision,original.revision);assert.ok(restored.project.sessionIds.includes(sessionId));assert.deepEqual(restored.project.shots,original.shots);assert.deepEqual(restored.project.audioClips,original.audioClips);assert.equal(restored.project.outputs.length,original.outputs.length);
  evidence.push({sessionId,projectId:original.id,revision:original.revision,shots:original.shots.length,outputs:original.outputs.length});
 }
 assert.equal((await current()).project.id,before.project.id);
 report.checks.push({name:'native restart restores both Session project bindings and latest manual/audio data without changing the visible project',evidence});report.completedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log('PASS restored both actual Session bindings after native restart');
}finally{await api.dispose();}
