import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {audioExecutable} from '../src/host/audio.js';
import {detectEnvironment} from '../src/host/renderer.js';
import {findBrowserExecutable, findToolExecutable, isExecutableFile, type ToolEnvironmentOptions} from '../src/host/tool-environment.js';

function fixture(platform:NodeJS.Platform,env:NodeJS.ProcessEnv,files:string[]):ToolEnvironmentOptions {
  const available=new Set(files);
  return {platform,env,isExecutable:(file,detectedPlatform)=>{
    assert.equal(detectedPlatform,platform);
    return available.has(file);
  }};
}

test('Windows discovers Chrome and Edge in user, system and 32-bit install roots',()=>{
  for(const variable of ['LOCALAPPDATA','PROGRAMFILES','PROGRAMFILES(X86)']){
    for(const vendor of [['Google','Chrome','Application','chrome.exe'],['Chromium','Application','chrome.exe'],['Microsoft','Edge','Application','msedge.exe']]){
      const root='C:\\'+variable,file=path.win32.join(root,...vendor);
      const env=detectEnvironment({},fixture('win32',{[variable]:root},[file]));
      assert.equal(env.browserPath,file);assert.equal(env.browserAvailable,true);
      assert.equal(env.platform,'win32');assert.equal(env.localSpeechAvailable,false);
    }
  }
});

test('Windows PATH uses semicolons, native separators, quoted folders and case-insensitive environment keys',()=>{
  const files=['D:\\Video Tools\\ffmpeg.exe','C:\\Other\\ffprobe.exe','C:\\Other\\msedge.exe'];
  const options=fixture('win32',{Path:';"D:\\Video Tools";C:\\Other;;'},files);
  const env=detectEnvironment({},options);
  assert.equal(env.ffmpegPath,files[0]);assert.equal(env.ffprobePath,files[1]);assert.equal(env.browserPath,files[2]);
  assert.equal(audioExecutable('ffmpeg',undefined,options),files[0]);
  const chrome='C:\\Users\\创作\\Google\\Chrome\\Application\\chrome.exe';
  assert.equal(findBrowserExecutable(fixture('win32',{localAppData:'C:\\Users\\创作'},[chrome])),chrome);
});

test('macOS discovers system and user applications and Homebrew tools',()=>{
  for(const file of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Users/作者/Applications/Chromium.app/Contents/MacOS/Chromium','/opt/homebrew/bin/chromium']){
    const options=fixture('darwin',{HOME:'/Users/作者'},[file,'/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffprobe','/usr/bin/say']);
    const env=detectEnvironment({},options);
    assert.equal(env.browserPath,file);assert.equal(env.ffmpegPath,'/opt/homebrew/bin/ffmpeg');assert.equal(env.ffprobePath,'/usr/local/bin/ffprobe');
    assert.equal(env.platform,'darwin');assert.equal(env.localSpeechAvailable,true);
  }
});

test('Linux discovers PATH browsers and tools, standard installs and Snap Chromium',()=>{
  for(const file of ['/tools/bin/google-chrome-stable','/usr/bin/chromium-browser','/snap/bin/chromium','/snap/chromium/current/usr/lib/chromium-browser/chrome']){
    const options=fixture('linux',{PATH:'/tools/bin:/another/bin'},[file,'/tools/bin/ffmpeg','/another/bin/ffprobe']);
    const env=detectEnvironment({},options);
    assert.equal(env.browserPath,file);assert.equal(env.ffmpegPath,'/tools/bin/ffmpeg');assert.equal(env.ffprobePath,'/another/bin/ffprobe');
    assert.equal(env.platform,'linux');assert.equal(env.localSpeechAvailable,false);
  }
});

test('platform discovery ignores installation paths belonging to other operating systems',()=>{
  const mac='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',linux='/usr/bin/chromium';
  const win='C:\\Programs\\Google\\Chrome\\Application\\chrome.exe';
  const options=fixture('linux',{PROGRAMFILES:'C:\\Programs'},[mac,win]);
  assert.equal(findBrowserExecutable(options),'');
  assert.equal(findBrowserExecutable(fixture('darwin',{},[linux,win])),'');
  assert.equal(findBrowserExecutable(fixture('win32',{},[mac,linux])),'');
  assert.equal(findToolExecutable('ffmpeg',fixture('win32',{},['/opt/homebrew/bin/ffmpeg'])),'');
});

test('local speech availability requires macOS and an executable say',()=>{
  assert.equal(detectEnvironment({},fixture('darwin',{},[])).localSpeechAvailable,false);
  assert.equal(detectEnvironment({},fixture('linux',{},['/usr/bin/say'])).localSpeechAvailable,false);
  assert.equal(detectEnvironment({},fixture('win32',{},['/usr/bin/say'])).localSpeechAvailable,false);
});

test('explicit paths take priority, remain visible when invalid and never silently fall back',()=>{
  const options=fixture('linux',{PATH:'/available'},['/available/chromium','/available/ffmpeg','/available/ffprobe']);
  const configured={browserPath:'/chosen/browser',ffmpegPath:'/chosen/ffmpeg',ffprobePath:'/chosen/ffprobe'};
  const env=detectEnvironment(configured,options);
  assert.equal(env.browserPath,configured.browserPath);assert.equal(env.ffmpegPath,configured.ffmpegPath);assert.equal(env.ffprobePath,configured.ffprobePath);
  assert.equal(env.browserAvailable,false);assert.equal(env.ffmpegAvailable,false);assert.equal(env.ffprobeAvailable,false);
  assert.throws(()=>audioExecutable('ffmpeg',configured.ffmpegPath,options),/配置路径不可执行/);
  assert.throws(()=>audioExecutable('ffprobe',configured.ffprobePath,options),/配置路径不可执行/);
  const valid=fixture('linux',{PATH:'/available'},['/chosen/ffmpeg','/available/ffmpeg']);
  assert.equal(audioExecutable('ffmpeg','/chosen/ffmpeg',valid),'/chosen/ffmpeg');
});

test('automatic discovery skips unusable files, and empty PATH entries do not search the current directory',()=>{
  const options=fixture('linux',{PATH:':/invalid::/usable:'},['/usable/ffmpeg','/usable/chromium']);
  assert.equal(findToolExecutable('ffmpeg',options),'/usable/ffmpeg');
  assert.equal(findBrowserExecutable(options),'/usable/chromium');
  assert.equal(findToolExecutable('ffmpeg',fixture('linux',{PATH:'::'},['ffmpeg'])),'');
  assert.throws(()=>audioExecutable('ffprobe',undefined,options),/未就绪/);
});

test('health checks reject directories, missing files and Unix files without executable permission',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tool-health-'));
  try{
    const binary=path.join(directory,'ffmpeg');await fs.writeFile(binary,'fixture');await fs.chmod(binary,0o600);
    assert.equal(isExecutableFile(directory),false);assert.equal(isExecutableFile(path.join(directory,'missing')),false);
    if(process.platform!=='win32'){
      assert.equal(isExecutableFile(binary),false);
      await fs.chmod(binary,0o700);assert.equal(isExecutableFile(binary),true);
    }
    const env=detectEnvironment({browserPath:directory,ffmpegPath:directory,ffprobePath:directory});
    assert.equal(env.browserAvailable,false);assert.equal(env.ffmpegAvailable,false);assert.equal(env.ffprobeAvailable,false);
    assert.throws(()=>audioExecutable('ffmpeg',directory),/配置路径不可执行/);
    const executable=path.join(directory,'ffmpeg.exe');await fs.writeFile(executable,'fixture');
    assert.equal(isExecutableFile(executable,'win32'),true);
    const batch=path.join(directory,'ffmpeg.cmd');await fs.writeFile(batch,'fixture');
    assert.equal(isExecutableFile(batch,'win32'),false);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('default detection reports the current host platform and actual local speech file availability',()=>{
  const env=detectEnvironment();
  assert.equal(env.platform,process.platform);
  assert.equal(env.localSpeechAvailable,process.platform==='darwin'&&isExecutableFile('/usr/bin/say'));
});
