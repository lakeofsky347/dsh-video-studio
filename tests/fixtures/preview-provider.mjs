// Offline DSH integration fixture. Never shipped as a production provider.
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {fixtureResponse,fixtureChunks} from './fixture-response.mjs';
export const inject=['llm'];
class OfflineVideoAdapter extends LlmAdapter {
  providerInfo(id){return {id,name:'本地验收 · 模拟模型'};}
  async listModels(provider){return [{provider,id:'offline-video',name:'离线分镜与源码（模拟）',inputModalities:['text']}];}
  async *stream(options){
    const input=JSON.parse(options.messages[0].content.find(b=>b.type==='text').text);
    yield* fixtureChunks(JSON.stringify(fixtureResponse(input)),{signal:options.signal,delayMs:Number(process.env.DSH_VIDEO_FIXTURE_DELAY??8)});
  }
}
export function apply(ctx){ctx.llm.registerAdapter(['video-studio-offline'],new OfflineVideoAdapter());}
