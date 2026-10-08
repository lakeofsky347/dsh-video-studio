import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {defaultTtsSettings,ttsCapability,validateTtsSettings} from '../src/shared/tts-capability.ts';
import {TtsConfig} from '../src/client/AudioPanel.tsx';
import type {StudioSnapshot} from '../src/shared/types.ts';
import type {StudioController} from '../src/client/controller.ts';

function snapshot(localSpeechAvailable:boolean):StudioSnapshot{return {project:null,root:null,task:null,previewUrl:null,previewRevision:null,providers:[],recent:[],environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:false,ffmpegAvailable:false,ffprobeAvailable:false,platform:localSpeechAvailable?'darwin':'linux',localSpeechAvailable}};}
test('fresh unsupported hosts require a speech endpoint; imported audio stays independent',()=>{
  assert.equal(defaultTtsSettings(snapshot(false).environment).endpoint,'');
  assert.equal(defaultTtsSettings(snapshot(true).environment).endpoint,'local:say');
  const legacy={...defaultTtsSettings(snapshot(false).environment),endpoint:'local:say',enabled:true};
  assert.equal(ttsCapability(legacy,snapshot(false).environment).available,false);
  assert.throws(()=>validateTtsSettings(legacy,snapshot(false).environment),/本机语音/);
  assert.doesNotThrow(()=>validateTtsSettings({...legacy,enabled:false},snapshot(false).environment));
  assert.doesNotThrow(()=>validateTtsSettings(legacy,snapshot(true).environment));
});
test('speech settings fail before enabling a malformed or incomplete remote service',()=>{
  const environment=snapshot(false).environment,base={...defaultTtsSettings(environment),enabled:true};
  for(const endpoint of ['', 'file:///voice', 'not-a-url'])assert.throws(()=>validateTtsSettings({...base,endpoint,model:'model',voice:'voice'},environment));
  assert.throws(()=>validateTtsSettings({...base,endpoint:'https://tts.example/v1'},environment),/模型和声音/);
  assert.doesNotThrow(()=>validateTtsSettings({...base,endpoint:'https://tts.example/v1',model:'model',voice:'voice'},environment));
});
test('speech UI explains unavailable local speech without advertising it on a fresh Linux host',()=>{
  const state=snapshot(false),controller={} as StudioController;
  const fresh=renderToStaticMarkup(createElement(TtsConfig,{snapshot:state,controller,busy:false}));
  assert.match(fresh,/自己的语音接口地址/);assert.doesNotMatch(fresh,/value="local:say"/);
  state.tts={...defaultTtsSettings(state.environment),endpoint:'local:say',enabled:false};
  const legacy=renderToStaticMarkup(createElement(TtsConfig,{snapshot:state,controller,busy:false}));
  assert.match(legacy,/没有可用的本机语音服务/);assert.match(legacy,/aria-label="启用配音服务"[^>]*disabled/);
});
