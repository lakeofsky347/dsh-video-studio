// v0.4 acceptance on an owned, isolated DSH profile. No cloud model requests.
// Set DSH_V04_SESSION_FIXTURE=1 only when the profile uses session-provider.mjs.
import { chromium, request } from 'playwright-core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const repo = path.resolve(import.meta.dirname, '..');
const url = process.env.DSH_TEST_URL;
assert.ok(url, 'Set DSH_TEST_URL to an owned isolated DSH profile URL.');
const out = path.resolve(process.env.DSH_V04_REPORT_DIR || path.join(repo, 'artifacts/verification/v0.4/home'));
await mkdir(out, { recursive: true });
const native = Boolean(process.env.DSH_NATIVE_CDP);
const report = {
  version: '0.4.0', startedAt: new Date().toISOString(),
  surface: native ? 'owned isolated DSH Desktop' : 'official isolated DSH Web',
  realProvider: false, packageSha256: process.env.DSH_PACKAGE_SHA,
  checks: [], errors: [], notChecked: [],
};
report.libSha256 = Object.fromEntries(await Promise.all(['index.js', 'client.js'].map(async name => [name, createHash('sha256').update(await readFile(path.join(repo, 'lib', name))).digest('hex')])));
const api = await request.newContext();
await api.get(url);
const base = new URL(url).origin;
const browser = native
  ? await chromium.connectOverCDP(process.env.DSH_NATIVE_CDP)
  : await chromium.launch({ headless: true, executablePath: process.env.DSH_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const context = native ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1540, height: 1120 }, deviceScaleFactor: 2 });
const page = native ? context.pages().find(item => item.url().startsWith('dsh-app://')) : await context.newPage();
assert.ok(page, 'Owned DSH browser page is unavailable.');
page.on('pageerror', error => report.errors.push(error.message));
let a, b, sessionA, sessionB, workspaceId;

function pass(name, evidence = {}) {
  report.checks.push({ name, evidence });
  console.log('PASS ' + name);
}
async function rpc(endpoint, payload = {}, remote = false) {
  const response = await api.post(base + '/api/' + endpoint, {
    data: { type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: remote ? { args: payload } : payload },
  });
  const result = await response.json();
  assert.equal(response.ok(), true, `${endpoint}: HTTP ${response.status()}`);
  assert.equal(result.result?.ok, true, `${endpoint}: ${JSON.stringify(result.result)}`);
  return result.result.value;
}
const studio = (endpoint, payload = {}) => rpc('video-studio/' + endpoint, payload);
const remote = (endpoint, payload = {}) => rpc(endpoint, { [endpoint === 'session/list' ? '_request' : 'request']: payload }, true);
async function poll(check, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await page.waitForTimeout(120);
  }
  throw new Error('State did not settle within ' + timeout + ' ms');
}
const home = () => page.locator('[data-video-home="true"]');
const card = id => page.locator(`[data-project-id="${id}"]`);
async function sidebarHome() {
  await page.getByText('映流 · 视频工作台', { exact: true }).click();
  await home().waitFor();
}
async function returnHome() {
  if (await home().isVisible().catch(() => false)) return;
  await page.getByRole('button', { name: /^(影片首页|工程列表)$/ }).first().click();
  await home().waitFor();
}
async function refreshHome() {
  await returnHome();
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await card(a.project.id).waitFor();
}
async function picker(projectId, id, name, mode = 'associate') {
  await card(projectId).getByRole('button', { name: mode === 'associate' ? '关联会话' : '继续会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: mode === 'associate' ? '关联会话' : '选择继续创作的会话', exact: true });
  await dialog.waitFor();
  await dialog.getByLabel('搜索会话', { exact: true }).fill(name);
  const row = dialog.locator(`[data-session-id="${id}"]`);
  await row.waitFor();
  await row.locator('input[type="radio"]').check();
  return dialog;
}
async function associate(project, sessionId, title, previousTitle) {
  const before = (await studio('current', { projectId: project.project.id })).project.revision;
  const dialog = await picker(project.project.id, sessionId, title);
  if (previousTitle) await dialog.getByText(`此会话当前制作《${previousTitle}》，将切换为《${project.project.title}》。`, { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '关联并设为当前工程', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await poll(async () => (await studio('list')).bindings?.[sessionId]?.currentProjectId === project.project.id);
  assert.equal((await studio('current', { projectId: project.project.id })).project.revision, before);
}
async function openSession(id) {
  // Native DSH UI selection, not a synthetic plugin-only route.
  const group = page.locator(`[data-row-key="workspace:${workspaceId}"]`);
  await group.waitFor();
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
  await page.locator(`[data-row-key="session:${id}"]`).click();
}

try {
  if (!native) await page.goto(url);
  else await page.reload();
  const welcome = page.getByRole('button', { name: '继续', exact: true });
  if (await welcome.waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false)) await welcome.click();
  await page.getByText('映流 · 视频工作台', { exact: true }).waitFor({ timeout: 60000 });

  const stamp = Date.now().toString();
  const workspace = await remote('workspace/create', { path: repo });
  workspaceId = workspace.workspace.workspaceId;
  sessionA = (await remote('session/create', { workspaceId })).sessionId;
  sessionB = (await remote('session/create', { workspaceId })).sessionId;
  const titleA = 'V04 会话 A ' + stamp, titleB = 'V04 会话 B ' + stamp;
  await remote('session/rename', { sessionId: sessionA, title: titleA });
  await remote('session/rename', { sessionId: sessionB, title: titleB });
  const target = { width: 320, height: 180, fps: { num: 12, den: 1 }, audioMode: 'none' };
  a = await studio('create', { title: 'V04 影片甲 ' + stamp, topic: '首页与关联验收', target });
  b = await studio('create', { title: 'V04 影片乙 ' + stamp, topic: '当前工程切换验收', target });
  await sidebarHome();
  await refreshHome();
  assert.equal(await page.getByRole('heading', { name: b.project.title, exact: true }).count(), 0);
  await page.screenshot({ path: path.join(out, 'home-default.png') });
  pass('sidebar entry opens an independent film homepage despite a restored selected project', { selectedProject: b.project.id });

  await associate(a, sessionA, titleA);
  assert.equal((await studio('current', { sessionId: sessionA })).project.id, a.project.id);
  pass('unopened existing Session is searchable and binds an existing film without changing content revision', { sessionId: sessionA, projectId: a.project.id, revision: a.project.revision });
  await associate(b, sessionA, titleA, a.project.title);
  let list = await studio('list');
  assert.equal(list.bindings[sessionA].currentProjectId, b.project.id);
  assert.deepEqual(new Set(list.bindings[sessionA].relatedProjectIds), new Set([a.project.id, b.project.id]));
  assert.equal((await studio('current', { projectId: a.project.id })).project.revision, a.project.revision);
  pass('switching a Session current film retains both related films and explicitly previews the change', { binding: list.bindings[sessionA] });

  const filter = page.getByLabel('按会话筛选工程', { exact: true });
  await filter.selectOption(sessionA);
  assert.equal(await card(a.project.id).count(), 1);
  assert.equal(await card(b.project.id).count(), 1);
  await card(a.project.id).locator('.vs-project-card-title').click();
  await page.getByRole('heading', { name: a.project.title, exact: true }).waitFor();
  assert.equal((await studio('current', { sessionId: sessionA })).project.id, b.project.id);
  await returnHome();
  pass('Session filtering and opening a historical related film do not switch the model tool target');

  const continuing = await picker(a.project.id, sessionA, titleA, 'continue');
  await continuing.getByRole('button', { name: '设为当前工程并进入会话', exact: true }).click();
  await continuing.waitFor({ state: 'hidden' });
  await poll(async () => (await studio('current', { sessionId: sessionA })).project?.id === a.project.id);
  await sidebarHome();
  pass('continuing a historical film explicitly switches the current project and native Session navigation returns to homepage on reentry');

  await filter.selectOption('all');
  await associate(a, sessionB, titleB);
  const choose = await picker(a.project.id, sessionB, titleB, 'continue');
  await choose.getByRole('button', { name: '进入会话', exact: true }).click();
  await choose.waitFor({ state: 'hidden' });
  await sidebarHome();
  pass('one film can be related to multiple real Sessions and continue selects the intended Session', { sessionIds: [sessionA, sessionB], projectId: a.project.id });

  const remove = await picker(a.project.id, sessionA, titleA);
  await remove.getByRole('button', { name: '解除本影片与此会话的关联', exact: true }).click();
  await poll(async () => !(await studio('list')).bindings[sessionA]?.relatedProjectIds.includes(a.project.id));
  await remove.getByRole('button', { name: '关闭会话选择', exact: true }).click();
  list = await studio('list');
  assert.equal(list.bindings[sessionA]?.currentProjectId, undefined);
  assert.ok(list.bindings[sessionA]?.relatedProjectIds.includes(b.project.id));
  assert.equal(list.bindings[sessionB]?.currentProjectId, a.project.id);
  assert.equal((await studio('current', { sessionId: sessionA })).project, null);
  pass('unlink removes exactly one relation, clears that current project and preserves other films and Sessions', { bindings: list.bindings });

  await associate(b, sessionA, titleA);
  await page.reload();
  await sidebarHome();
  assert.equal((await studio('current', { sessionId: sessionA })).project.id, b.project.id);
  assert.equal((await studio('current', { sessionId: sessionB })).project.id, a.project.id);
  pass('client reload restores the homepage and complete independently routed Session relationships');

  if (process.env.DSH_V04_SESSION_FIXTURE === '1') {
    await remote('session/prompt', { sessionId: sessionA, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '[VS_SESSION:CREATE_A] 离线验收：创建影片并查看指定帧。' }] });
    await openSession(sessionA);
    await page.getByText('[VS_DONE:CREATE_A]', { exact: false }).first().waitFor({ timeout: 180000 });
    const output = await studio('current', { sessionId: sessionA });
    await page.getByText(/^已完成，用时/).first().click();
    const foldedTools = page.getByText('已调用工具并搜索代码', { exact: true }).first();
    if (await foldedTools.isVisible().catch(() => false)) await foldedTools.click();
    await page.locator('[data-video-tool="video_inspect"]').last().getByRole('button', { name: /^查看指定帧/ }).click();
    await page.getByRole('heading', { name: output.project.title, exact: true }).waitFor();
    assert.equal(await home().count(), 0);
    await page.getByRole('tab', { name: '影片预览', exact: true }).click();
    await poll(async () => (await page.getByTestId('current-frame').innerText()) === '3');
    await page.screenshot({ path: path.join(out, 'card-frame-intent.png') });
    pass('real offline Session tool card overrides the ordinary homepage entry and opens the exact project, shot and frame', { projectId: output.project.id, frame: 3, realProvider: false });
    await openSession(sessionA);
    await sidebarHome();
  } else report.notChecked.push('Tool-card agent-loop check requires an explicitly configured local session-provider.mjs profile.');

  await page.getByLabel('搜索影片工程', { exact: true }).fill(stamp);
  await page.screenshot({ path: path.join(out, 'home-related-films.png') });
  if (!native) {
    await page.setViewportSize({ width: 780, height: 980 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(out, 'home-narrow.png') });
    const overflow = await home().evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, right: element.getBoundingClientRect().right, viewport: innerWidth }));
    assert.ok(overflow.scrollWidth <= overflow.width + 1, JSON.stringify(overflow));
    assert.ok(overflow.right <= overflow.viewport + 1, JSON.stringify(overflow));
    pass('homepage remains usable at a narrow desktop width', overflow);
  }
  const keyboard = await picker(a.project.id, sessionB, titleB);
  await page.keyboard.press('Escape');
  await keyboard.waitFor({ state: 'hidden' });
  const restoredFocus = await page.evaluate(() => ({ label: document.activeElement?.textContent?.trim(), projectId: document.activeElement?.closest('[data-project-id]')?.getAttribute('data-project-id') }));
  assert.equal(restoredFocus.label, '关联会话');
  assert.equal(restoredFocus.projectId, a.project.id);
  pass('Session picker closes with Escape and restores keyboard focus to its original project action', restoredFocus);
  report.projectIds = [a.project.id, b.project.id];
  report.sessionIds = [sessionA, sessionB];
  report.finalBindings = (await studio('list')).bindings;
  report.notChecked.push('Real cloud-provider semantic quality and a real multi-agent model run are outside this offline acceptance.');
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.failure = error.stack;
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(out, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  await api.dispose();
  await browser.close();
}
