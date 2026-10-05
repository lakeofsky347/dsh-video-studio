import {readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import {compileSpec} from '../src/core/index.ts';

const repo=path.resolve(import.meta.dirname,'..');
const artifacts=path.join(repo,'artifacts');
const verification=path.join(artifacts,'verification');
const example=path.join(artifacts,'examples/native-30s-project');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const project=await json(path.join(example,'project.json'));
const runtime=await json(path.join(example,'runtime/spec.json'));
const spec=compileSpec(project);
assert.deepEqual(spec,runtime.spec);
assert.equal(spec.shots.length,5);
assert.equal(spec.durationFrames,900);
assert.equal(spec.durationSeconds,30);
assert.equal(project.assets.length,4);
assert.equal(project.revision,16);
const fingerprints=[];
for(const asset of project.assets.filter(a=>a.kind==='image')) {
  const bytes=await readFile(path.join(example,asset.path));
  assert.ok(bytes.length>0);
  fingerprints.push({path:asset.path,sha256:sha(bytes)});
}
for(const shot of spec.shots) {
  const source={};
  for(const [field,file] of [['html','index.html'],['css','style.css'],['js','scene.js']]) {
    const relative=path.join(shot.sourcePath,file);
    const bytes=await readFile(path.join(example,relative));
    source[field]=bytes.toString('utf8');
    fingerprints.push({path:relative,sha256:sha(bytes)});
  }
  const backup=await json(path.join(example,shot.sourcePath,'source.json'));
  for(const key of ['html','css','js'])assert.equal(source[key],backup[key]);
  const runtimeSource=runtime.sources.find(s=>s.id===shot.id);
  assert.ok(runtimeSource);
  assert.equal(source.html,runtimeSource.html);
  assert.equal(source.css,runtimeSource.css);
  assert.equal(source.js,await readFile(path.resolve(example,'runtime',runtimeSource.moduleUrl),'utf8'));
}
const output=project.outputs[0];
assert.ok(!path.isAbsolute(output.path));
const mediaHash=sha(await readFile(path.join(example,output.path)));
const delivery=await json(path.join(verification,'delivery.json'));
assert.equal(mediaHash,delivery.nativeMedia.sha256);
await writeFile(path.join(verification,'example-readback.json'),JSON.stringify({status:'PASS',recordedAt:new Date().toISOString(),root:example,revision:project.revision,shots:spec.shots.length,assets:project.assets.length,durationFrames:spec.durationFrames,durationSeconds:spec.durationSeconds,projectSpecMatchesExportRuntime:true,editableSourcesMatchExportRuntime:true,output:{path:output.path,sha256:mediaHash},files:fingerprints},null,2)+'\n');

async function walk(root,relative='') {
  const files=[];
  for(const entry of (await readdir(path.join(root,relative))).sort()) {
    const next=path.join(relative,entry),info=await lstat(path.join(root,next));
    assert.ok(!info.isSymbolicLink(),`Archive source is a symlink: ${next}`);
    if(info.isDirectory())files.push(...await walk(root,next));
    else if(info.isFile())files.push(next);
  }
  return files;
}
const sourceFiles=['package.json','package-lock.json','tsconfig.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md','cordis.patch.yml','.gitignore'];
for(const folder of ['src','scripts','tests','docs','licenses','types'])for(const file of await walk(path.join(repo,folder)))sourceFiles.push(path.join(folder,file));
const jobs=[
  {kind:'source',root:repo,prefix:'dsh-video-studio',path:path.join(artifacts,'dsh-video-studio-source-0.1.0.zip'),files:sourceFiles.sort()},
  {kind:'example',root:example,prefix:'native-30s-project',path:path.join(artifacts,'dsh-video-studio-example-30s.zip'),files:await walk(example)}
];
const python=String.raw`import sys,json,zipfile,pathlib,hashlib
jobs=json.load(sys.stdin)
results=[]
for job in jobs:
    root=pathlib.Path(job['root'])
    with zipfile.ZipFile(job['path'],'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
        for file in job['files']:
            archive.write(root/file,job['prefix']+'/'+file)
    with zipfile.ZipFile(job['path'],'r') as archive:
        assert archive.testzip() is None
        for file in job['files']:
            assert archive.read(job['prefix']+'/'+file)==(root/file).read_bytes(),file
    output=pathlib.Path(job['path'])
    results.append({'kind':job['kind'],'path':job['path'],'bytes':output.stat().st_size,'files':len(job['files']),'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'readback':'PASS'})
print(json.dumps(results))
`;
const packed=spawnSync('/usr/bin/python3',['-c',python],{input:JSON.stringify(jobs),encoding:'utf8',maxBuffer:1024*1024});
assert.equal(packed.status,0,packed.stderr);
const archives=JSON.parse(packed.stdout);
delivery.archives=archives;
delivery.exampleReadback='PASS: project specification, image files, editable sources and MP4 match the native export snapshot';
await writeFile(path.join(verification,'archives.json'),JSON.stringify({status:'PASS',recordedAt:new Date().toISOString(),archives},null,2)+'\n');
await writeFile(path.join(verification,'delivery.json'),JSON.stringify(delivery,null,2)+'\n');
console.log(JSON.stringify({exampleReadback:'PASS',archives},null,2));
