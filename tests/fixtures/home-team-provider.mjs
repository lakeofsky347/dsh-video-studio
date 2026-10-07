// Offline responses drive real DSH delegation, Team membership and video tools.
// The production package excludes this fixture. It never calls a network API.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const inject = ['llm'];
const states = new Map();
function objects(value, found = []) {
  if (value === null || typeof value !== 'object') return found;
  if (value.kind === 'video-studio' && typeof value.projectId === 'string') found.push(value);
  if (typeof value.text === 'string') for (const text of [value.text, ...value.text.split('\n')]) {
    try { objects(JSON.parse(text), found); } catch { /* Ordinary narrative is not a receipt. */ }
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) if (item && typeof item === 'object') objects(item, found);
  return found;
}
function command(messages) {
  for (const message of [...messages].reverse()) for (const block of [...message.content ?? []].reverse()) {
    const match = block.type === 'text' && block.text?.match(/\[VS_AGENTS:([A-Z_]+)\]/);
    if (match) return match[1];
  }
}
async function log(value) {
  const file = process.env.DSH_V04_AGENTS_LOG;
  if (!file) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ ...value, time: new Date().toISOString(), realProvider: false }) + '\n');
}

class HomeTeamAdapter extends LlmAdapter {
  providerInfo(id) { return { id, name: 'V04 子代理与团队 · 离线验收' }; }
  async listModels(provider) { return [{ provider, id: 'offline-session-video', name: '离线真实 Agent 工具回合', inputModalities: ['text', 'image'] }]; }
  async *stream(options) {
    const key = command(options.messages);
    if (!key) {
      yield { type: 'text-delta', index: 0, text: 'V04 视频协作验收' };
      yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    let state = states.get(options.sessionId);
    if (!state || state.command !== key) { state = { command: key, step: 0 }; states.set(options.sessionId, state); }
    const step = state.step++, receipts = objects(options.messages);
    const full = [...receipts].reverse().find(value => Array.isArray(value.shots));
    let tool, args;
    if (key === 'LEAD') {
      if (step === 0) { tool = 'video_project'; args = { action: 'get' }; }
      if (step === 1) {
        tool = 'subagent'; args = { description: 'V04 一次性镜头助手', prompt: '[VS_AGENTS:CHILD] 在当前影片第一镜头写入子代理字幕，保留其他镜头。', run_in_background: false };
      }
      if (step === 2) {
        tool = 'spawn_teammate'; args = { name: 'v04-editor', description: 'V04 团队镜头协作', prompt: '[VS_AGENTS:TEAM] 在当前影片第二镜头写入团队字幕，保留其他镜头。', context: 'fresh' };
      }
      if (step === 3) { tool = 'wait_agent'; args = { timeout_ms: 30000 }; }
      if (step === 4) { tool = 'video_project'; args = { action: 'get' }; }
    } else if (key === 'PRIVATE_LEAD') {
      if (step === 0) { tool = 'send_message'; args = { target: 'v04-editor', message: '[VS_AGENTS:TEAM_PRIVATE] 在当前影片第一镜头写入专属工程字幕。' }; }
      if (step === 1) { tool = 'wait_agent'; args = { timeout_ms: 30000 }; }
      if (step === 2) { tool = 'video_project'; args = { action: 'get' }; }
    } else if (['CHILD', 'TEAM', 'TEAM_PRIVATE'].includes(key)) {
      const index = key === 'TEAM' ? 1 : 0;
      const text = key === 'CHILD' ? 'V04 一次性子代理完成' : key === 'TEAM' ? 'V04 团队成员完成' : 'V04 团队专属工程完成';
      if (step === 0) { tool = 'video_project'; args = { action: 'get' }; }
      if (step === 1 && full?.shots?.[index]) {
        const shot = full.shots[index];
        tool = 'video_update'; args = { expectedRevision: full.revision, update: { shotPatches: [{ id: shot.id, patch: { params: { ...shot.params, subtitle: text } } }] } };
      }
      if (step === 2 && full?.shots?.[index]) {
        tool = 'video_inspect'; args = { shotId: full.shots[index].id, frame: index === 0 ? 3 : full.shots[0].durationFrames + 3, includeSource: true };
      }
    }
    await log({ sessionId: options.sessionId, command: key, step, tool: tool ?? null, projectId: full?.projectId, callerSessionId: full?.callerSessionId, ownerSessionId: full?.ownerSessionId, routingSource: full?.routingSource, revision: full?.revision, nativeTools: (options.tools ?? []).map(value => value.name) });
    if (tool) {
      const native = (options.tools ?? []).some(value => value.name === tool);
      const name = native ? tool : 'run_code';
      const payload = native ? args : { code: `const result = await tools.${tool}(${JSON.stringify(args)}); text(result);`, description: `V04 离线协作验收：${tool}` };
      yield { type: 'tool-call-delta', index: 0, id: 'v04-agent-' + randomUUID(), name, argumentsDelta: JSON.stringify(payload) };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      yield { type: 'text-delta', index: 0, text: `[VS_AGENTS_DONE:${key}] 离线模型已完成真实协作工具调用。` };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}
export function apply(ctx) { ctx.llm.registerAdapter(['video-studio-session-offline'], new HomeTeamAdapter()); }
