// Seal already verified production bytes. Does not build, install, start hosts or call models.
import {readFile,writeFile,mkdir,copyFile,readdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const repo=path.resolve(import.meta.dirname,'..'),artifacts=path.join(repo,'artifacts'),verify=path.join(artifacts,'verification/v0.4');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const writeJson=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+'\n');};
const manifest=await json(path.join(repo,'package.json'));assert.equal(manifest.version,'0.4.0');
const candidate=path.resolve(process.argv[2]??path.join(artifacts,'candidate/dsh-video-studio-0.4.0.tgz'));
const bytes=await readFile(candidate),hash=sha(bytes);
const preparedFile=path.resolve(process.argv[3]??path.join(repo,'.local/native',hash.slice(0,12),'prepared.json'));
const prepared=await json(preparedFile);assert.equal(prepared.archive.sha256,hash);assert.equal(sha(await readFile(prepared.archive.copy)),hash);
const libSha256=Object.fromEntries(await Promise.all(['index.js','client.js'].map(async name=>[name,sha(await readFile(path.join(repo,'lib',name)))])));
const reportPaths={home:'home/verification.json',theme:'ui-theme/report.json',agents:'agents/verification.json',native:'native/verification.json',nativeAgents:'native-agents/verification.json',restart:'native/restart.json',agentRestart:'native-agents/restart.json',media:'native/media.json',cleanup:'cleanup.json'};
const records={},data={};
for(const [name,file] of Object.entries(reportPaths)){
  const value=await json(path.join(verify,file));assert.equal(value.status,'PASS',file);assert.deepEqual(value.errors??[],[],file);
  if(value.packageSha256)assert.equal(value.packageSha256,hash,file+' uses another package');
  if(value.libSha256)assert.deepEqual(value.libSha256,libSha256,file+' uses another build');
  if(['native','nativeAgents','restart','agentRestart','media'].includes(name))assert.equal(value.packageSha256,hash,file);
  data[name]=value;records[name]={status:'PASS',checks:value.checks?.length??0,path:path.join(verify,file)};
}
const testText=(await readFile(path.join(verify,'tests.tap'),'utf8')).replaceAll(/\x1b\[[0-9;]*m/g,'');
const number=name=>Number([...testText.matchAll(new RegExp('(?:^|\\n)\\s*(?:ℹ|#)?\\s*'+name+'\\s+(\\d+)\\b','g'))].at(-1)?.[1]);
const tests={pass:number('pass'),fail:number('fail'),skip:number('skipped'),cancelled:number('cancelled')};
assert.ok(tests.pass>0);assert.equal(tests.fail,0);assert.equal(tests.skip,0);assert.equal(tests.cancelled,0);
assert.equal(data.agents.realProvider,false);assert.equal(data.nativeAgents.realProvider,false);assert.equal(prepared.mock.realProvidersDisabled,true);
const fixture=await json(path.join(verify,'native-agents/fixture.json'));
assert.equal(sha(await readFile(fixture.fixture)),fixture.sha256);
assert.equal(sha(await readFile(path.join(prepared.profile,'offline-provider-home.mjs'))),prepared.mock.sha256);
const previous=await json(path.join(artifacts,'verification/v0.3/delivery.json'));
const historical=[...previous.legacyDeliverablesPreserved.files,previous.archive,...previous.archives];
for(const item of historical)assert.equal(sha(await readFile(item.path)),item.sha256,'Historical deliverable changed: '+item.path);
async function walk(root,relative=''){
  const result=[];
  for(const name of (await readdir(path.join(root,relative))).sort()){
    const next=path.join(relative,name),info=await lstat(path.join(root,next));assert.equal(info.isSymbolicLink(),false,next);
    if(info.isDirectory())result.push(...await walk(root,next));else {assert.ok(info.isFile());result.push(next);}
  }
  return result;
}
const sourceFiles=['package.json','package-lock.json','tsconfig.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md','cordis.patch.yml','.gitignore'];
for(const folder of ['src','scripts','tests','docs','licenses','types'])for(const file of await walk(path.join(repo,folder)))sourceFiles.push(path.join(folder,file));
const output=path.join(artifacts,'dsh-video-studio-0.4.0.tgz'),sourceZip=path.join(artifacts,'dsh-video-studio-source-0.4.0.zip');
try{assert.equal(sha(await readFile(output)),hash,'A different final 0.4 archive already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
await copyFile(candidate,output);assert.equal(sha(await readFile(output)),hash);
const python=String.raw`import sys,json,pathlib,tarfile,zipfile,hashlib
j=json.load(sys.stdin);p=j['prepared'];root=pathlib.Path(j['repo']);installed=pathlib.Path(p['installed'])
sha=lambda b:hashlib.sha256(b).hexdigest()
with tarfile.open(j['archive'],'r:gz') as t:
 members=t.getmembers()
 assert all(m.name.startswith('package/') and '..' not in pathlib.PurePosixPath(m.name).parts for m in members)
 assert all(m.isdir() or m.isfile() for m in members),'Non-regular entry in package'
 assert not any(m.name.startswith(('package/tests/','package/scripts/','package/.local/','package/artifacts/')) for m in members),'Fixture leaked into release'
 assert json.loads(t.extractfile('package/package.json').read())==j['manifest']
 actual=[]
 for m in members:
  if not m.isfile():continue
  name=m.name.removeprefix('package/');b=t.extractfile(m).read();f=installed/name
  assert f.is_file() and not f.is_symlink(),name
  assert f.read_bytes()==b,name
  if not name.startswith('node_modules/'):assert (root/name).read_bytes()==b,name
  actual.append({'path':name,'bytes':len(b),'sha256':sha(b)})
 actual.sort(key=lambda v:v['path'])
 assert actual==sorted(p['installedFiles'],key=lambda v:v['path'])
 files=[]
 for f in installed.rglob('*'):
  assert not f.is_symlink(),str(f)
  if f.is_file():files.append(str(f.relative_to(installed)))
 assert sorted(files)==[v['path'] for v in actual]
formal=pathlib.Path(p['nativeProgram']['source'])/'Contents/Resources/app.asar'
assert sha(formal.read_bytes())==p['nativeProgram']['originalAsarSha256']
with zipfile.ZipFile(j['sourceZip'],'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for name in sorted(j['sourceFiles']):z.write(root/name,'dsh-video-studio/'+name)
with zipfile.ZipFile(j['sourceZip']) as z:
 assert z.testzip() is None
 assert sorted(z.namelist())==sorted('dsh-video-studio/'+n for n in j['sourceFiles'])
 for name in j['sourceFiles']:assert z.read('dsh-video-studio/'+name)==(root/name).read_bytes(),name
s=pathlib.Path(j['sourceZip'])
print(json.dumps({'physicalFiles':actual,'source':{'kind':'source','path':str(s),'bytes':s.stat().st_size,'sha256':sha(s.read_bytes()),'files':len(j['sourceFiles']),'readback':'PASS'},'formalAppAsarUnchanged':True}))`;
const sealed=spawnSync('/usr/bin/python3',['-c',python],{input:JSON.stringify({repo,archive:output,prepared,manifest,sourceZip,sourceFiles}),encoding:'utf8',maxBuffer:8*1024*1024});
assert.equal(sealed.status,0,sealed.stderr||sealed.error?.message);
const result=JSON.parse(sealed.stdout),archive={path:output,sha256:hash,bytes:bytes.length};
const integrity={status:'PASS',archive,installedRoot:prepared.installed,physicalFilesCompared:result.physicalFiles.length,productionFilesMatchCurrentBuild:true,formalAppAsarUnchanged:true,formalAppAsarSha256:prepared.nativeProgram.originalAsarSha256,testFixture:{path:fixture.fixture,sha256:fixture.sha256,originalHomeFixtureSha256:prepared.mock.sha256,scope:fixture.scope,excludedFromRelease:true},files:result.physicalFiles};
await copyFile(preparedFile,path.join(verify,'native/installation-prepared.json'));await writeJson(path.join(verify,'native/installation-integrity.json'),integrity);
const mediaPath=data.media.checks.find(check=>check.outputPath)?.outputPath;assert.ok(mediaPath);
const media={path:mediaPath,sha256:sha(await readFile(mediaPath)),playback:data.media.checks[0].playback,width:data.media.checks[1].width,height:data.media.checks[1].height,frames:data.media.checks[1].frames,fullDecode:'PASS'};
const delivery={status:'DELIVERED_WITH_NATIVE_OFFLINE_AGENT_TEAM_AND_ACTUAL_MEDIA_VALIDATION',recordedAt:new Date().toISOString(),plugin:manifest.name,version:manifest.version,sourceRoot:repo,archive,archives:[result.source],libSha256,validation:{typecheck:'PASS',build:'PASS',tests,...records,physicalPackageFiles:result.physicalFiles.length,sourceZipReadback:'PASS'},media,
  realChatProvider:{status:'NOT_CHECKED',reason:'Actual DSH Agent/subagent/Team runtime was driven by local deterministic model fixtures.'},remoteTts:{status:'NOT_CHECKED',reason:'No remote speech provider was called in this acceptance.'},fullHumanFilmReview:{status:'NOT_CHECKED',reason:'Automated playback, keyframe and decode checks do not establish whole-film human viewing/listening.'},formalUserProfileInstallation:{status:'NOT_PERFORMED'},formalApplication:{modified:false,asarSha256:prepared.nativeProgram.originalAsarSha256},legacyDeliverablesPreserved:{status:'PASS',files:historical},cleanupRecord:records.cleanup.path};
await writeJson(path.join(verify,'archives.json'),{status:'PASS',archives:[result.source]});await writeJson(path.join(verify,'delivery.json'),delivery);
await writeFile(path.join(artifacts,'dsh-video-studio-0.4.0.sha256'),hash+'  dsh-video-studio-0.4.0.tgz\n'+result.source.sha256+'  dsh-video-studio-source-0.4.0.zip\n');
await writeFile(path.join(verify,'acceptance.md'),`# 映流 0.4 最终交付验收\n\n完成时间：${delivery.recordedAt}\n\n本版交付独立影片首页、已有 Session 与工程的多关联/当前工程管理，以及原生 subagent 和 Agent Team 路由。工作台保留镜头图、帧预览、源码编辑、声音和成片导出。\n\n- [安装包](${output})（${bytes.length} 字节）\n- [源码 ZIP](${sourceZip})（${result.source.files} 个文件，逐文件回读通过）\n- [会话与代理制作说明](${path.join(repo,'docs/SESSION-WORKFLOW.md')})\n- [详细交付数据](${path.join(verify,'delivery.json')})\n\n安装包 SHA-256：\n\n\`${hash}\`\n\n| 检查 | 结果 | 证据 |\n|---|---|---|\n| TypeScript、构建 | PASS | pack 前置检查及当前生产产物 |\n| 完整回归 | ${tests.pass}/${tests.pass} PASS | [测试记录](${path.join(verify,'tests.tap')}) |\n${Object.entries(records).filter(([name])=>name!=='cleanup').map(([name,row])=>`| ${name} | ${row.checks}/${row.checks} PASS | [报告](${row.path}) |`).join('\n')}\n| 包/实体安装/生产文件一致性 | ${result.physicalFiles.length} 个文件 PASS | [完整性报告](${path.join(verify,'native/installation-integrity.json')}) |\n| 历史交付物保留 | ${historical.length} 个 SHA-256 一致 | delivery.json |\n\n原生检查将同一份 TGZ 实体安装在本轮独立 DSH Desktop 副本中，使用独立 profile、项目目录和 app 标识。正式 DSH app ASAR 保持原哈希，日常用户 profile 未升级。安装本版请在「插件管理 → 添加插件」选择上面的绝对 TGZ 路径，完成后启用插件。\n\n代理验收使用宿主实际的 subagent、spawn_teammate、wait_agent 和 send_message 机制，模型响应由离线 fixture 给出。已验证主工程继承、专属工程、实际调用者回执、工具卡片帧定位及重启后持久子会话地址。SDK 的标题缓存没有完整目录时会补读完整 projections，回归测试覆盖该合法合同。没有调用真实云端聊天模型或远程 TTS。真人全片观看/听音、远程供应商效果均为 NOT_CHECKED。\n\n实际本地成片：H.264 ${media.width}×${media.height}，${media.frames} 帧，播放器可推进且无解码错误，FFmpeg 全片解码通过。\n\n验收资源均已关闭，详见 [清理记录](${records.cleanup.path})。源码、安装包和报告均已保存；本轮未提交或推送 Git。\n`);
console.log(JSON.stringify({archive,source:result.source,tests,physicalFiles:result.physicalFiles.length,reports:records},null,2));
