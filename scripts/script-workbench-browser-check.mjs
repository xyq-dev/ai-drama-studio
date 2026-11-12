/** Real Next + Nest + disposable PostgreSQL. No model, storage, or media provider calls. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDb = createRequire(resolve(root, 'packages/database/package.json'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const { chromium } = createRequire(resolve(root, 'package.json'))('playwright');
requireApi('reflect-metadata');
const { NestFactory } = requireApi('@nestjs/core');
const { Pool } = requireDb('pg');
const database = requireDb('./dist/index.js');
const { AppModule } = requireApi('./dist/app.module.js');
const { loadApiEnv } = requireApi('./dist/config/env.js');
const { hashPassword } = requireApi('./dist/auth/password-hash.js');
const { SafeExceptionFilter } = requireApi('./dist/http/safe-exception.filter.js');
const url = process.env.WORKBENCH_BROWSER_TEST_URL;
if (!url || process.env.WORKBENCH_BROWSER_ALLOW_WRITES !== 'true' || process.env.WORKBENCH_BROWSER_ALLOW_DRAFT !== 'true') {
  throw Error('Requires explicit disposable browser URL and WORKBENCH_BROWSER_ALLOW_WRITES/ALLOW_DRAFT=true');
}
const parsed = new URL(url);
assert.match(parsed.pathname, /^\/ads_workbench_browser_[a-z0-9_]+$/);
assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname), 'Only loopback disposable PostgreSQL is accepted');
const pool = new Pool({ connectionString: url });
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const WEB = 'http://127.0.0.1:3012';
const output = resolve(root, process.env.WORKBENCH_BROWSER_EVIDENCE ?? 'test-results/script-workbench-browser');
const password = `qa-${randomUUID()}`;
const evidence = { kind: 'real-next-nest-postgresql-chromium', checks: [], screenshots: [], errors: [], externalRequests: [], paidCalls: 0 };
let app, web, browser, page;
let webLogs = '';

async function screenshot(name, width = 1586, height = 992) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `${name}: horizontal overflow`);
  const file = `${name}-${width}.png`;
  await page.screenshot({ path: resolve(output, file), fullPage: !['12-editing-conflict', '13-older-restored-history'].includes(name) && !(width === 1586 && ['03-writing','04-delete-draft','05-review','06-confirm-version','08-dependent-lock-protected','10-project-delete','11-recovered-drafts'].includes(name)) });
  evidence.screenshots.push(file);
}

async function request(path, body, version, actor = page) {
  const cookies = await actor.context().cookies();
  const csrf = cookies.find(c => c.name === 'ads_csrf' || c.name === '__Host-ads_csrf')?.value;
  const response = await actor.request.fetch(`${WEB}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { data: body }),
    headers: { Origin: WEB, 'Idempotency-Key': randomUUID(), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(version === undefined ? {} : { 'If-Match': String(version) }) },
  });
  const result = await response.json();
  assert.ok(response.ok(), `${path}: ${response.status()} ${JSON.stringify(result)}`);
  return result;
}

async function runFlows() {
  await page.goto(`${WEB}/studio`);
  await page.waitForURL(/\/login/);
  await page.getByLabel('账号', { exact: true }).fill('qa');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(`${WEB}/studio`);
  evidence.checks.push('real session login');
  assert.equal((await fetch(`${WEB}/api/v1/script-workbench/trash`)).status, 401, 'anonymous workbench read');
  const project = await request('/projects', { title: '无名碑 · 验收样本', premise: '石匠之女从一块无名碑追查父亲旧案。', episodeCount: 3, targetEpisodeSeconds: 60 });
  const base = `/projects/${project.id}`;
  const snapshot = () => request(`${base}/script-workbench`);
  const plan = {
    brief: { genre: '古装悬疑', audience: '喜欢线索推理与女性成长的观众', productionConstraints: '两个室内场地、三名演员，竖屏拍摄。', logline: '石匠之女发现无名碑上的暗号，必须在七天内查明父亲旧案。', targetEpisodeSeconds: 210, dialogueQuota: 20 },
    bible: { ending: '许照青揭开旧案，为无名者刻上名字。', openThreads: '陈长渡为何隐瞒签押。', characters: [
      { id: 'R01', name: '许照青', appearance: '青色布衣，右手沾石粉', voice: '克制清晰的年轻女声', aliases: '照青、许姑娘', knownInformation: '知道父亲留下了木牌。' },
      { id: 'R02', name: '差役', appearance: '深灰差服，腰挂旧牌', voice: '低沉简短的男声', aliases: '官差', knownInformation: '知道石铺来过陌生人。' },
    ] },
    outline: { episodes: [
      { episodeNo: 1, title: '活人认碑', openingHook: '碑上刻着活人的名字。', change: '许照青发现父亲旧案有疑点。', endingHandoff: '她藏起陈长渡，攥着木牌开门。' },
      { episodeNo: 2, title: '差役登门', openingHook: '差役盯住她攥紧的手。', change: '旧案签押指向许守义。', endingHandoff: '差役翻开旧案卷，露出许守义的签押。' },
      { episodeNo: 3, title: '旧案签押', openingHook: '墨迹下藏着第二个人的签名。', change: '她决定查验官府原卷。', endingHandoff: '她走进案房。' },
    ] },
  };
  await request(`${base}/script-workbench/plan`, { plan }, project.version);
  async function reviewStory(to) { const view = await snapshot(); await request(`${base}/stories/${view.story.id}/review`, { to, expectedReviewVersion: view.story.reviewVersion }, view.project.version); }
  await reviewStory('IN_REVIEW');
  await page.goto(`${WEB}${base}/script`);
  await page.getByRole('heading', { name: '剧本工作台', exact: true }).waitFor();
  await page.getByRole('tab', { name: /立项/ }).click();
  await page.getByLabel('题材', { exact: true }).waitFor();
  await screenshot('01-brief');
  await page.getByRole('tab', { name: /设定与大纲/ }).click();
  await page.getByLabel('故事结局', { exact: false }).waitFor();
  await screenshot('02-bible');
  await page.getByRole('tab', { name: /定稿交接/ }).click();
  await page.getByRole('button', { name: '确认设定版本', exact: true }).click();
  await page.getByRole('button', { name: '确认锁定 v1', exact: true }).click();
  await page.getByText('设定 v1 已确认，可以逐集编写。', { exact: true }).waitFor();
  evidence.checks.push('specific plan version confirmed through UI');
  let view = await snapshot();
  const scene = { id: 'scene1', heading: '石铺门口', interiorExterior: 'INT', timeOfDay: 'DAY', characterIds: ['R01','R02'], beats: [
    { id: 'beat1', kind: 'action', text: '门一开，差役盯住她攥紧的手。', seconds: 5 },
    { id: 'beat2', kind: 'dialogue', characterId: 'R02', text: '刚才谁来过？', seconds: 3 },
    { id: 'beat3', kind: 'dialogue', characterId: 'R01', text: '来问碑价的。', seconds: 3 },
    { id: 'beat4', kind: 'action', text: '许照青将握牌的手缩进袖口。', seconds: 4 },
    { id: 'beat5', kind: 'sound', text: '门轴轻响', seconds: 2 },
    { id: 'beat6', kind: 'pause', text: '差役打量石铺。', seconds: 2 },
  ] };
  const checks = { identityClear: true, goalClear: true, obstacleClear: true, continuityChecked: true, lockedMaterialsChecked: true, note: '合成验收样本，逐项人工确认。' };
  const first = { ...plan.outline.episodes[0], previousRevisionId: null, previousHandoff: '', characterKnowledge: '许照青知道木牌与旧案有关。', unresolvedThreads: '陈长渡的身份。', scenes: [scene], review: checks };
  delete first.episodeNo;
  await request(`${base}/episodes/${view.episodes[0].id}/script-workbench`, { sourceStoryRevisionId: view.story.id, script: first }, view.episodes[0].rowVersion);
  async function reviewEpisode(index, to) { const state = await snapshot(), ep = state.episodes[index]; await request(`${base}/episodes/${ep.id}/scripts/${ep.script.id}/review`, { to, expectedReviewVersion: ep.script.reviewVersion }, ep.rowVersion); }
  await reviewEpisode(0, 'IN_REVIEW'); await reviewEpisode(0, 'APPROVED');
  view = await snapshot();
  const second = { ...first, ...plan.outline.episodes[1], previousRevisionId: view.episodes[0].script.id, previousHandoff: first.endingHandoff, review: { ...checks, identityClear: false, goalClear: false, obstacleClear: false, continuityChecked: false, lockedMaterialsChecked: false } };
  delete second.episodeNo;
  await request(`${base}/episodes/${view.episodes[1].id}/script-workbench`, { sourceStoryRevisionId: view.story.id, script: second }, view.episodes[1].rowVersion);
  await page.reload();
  await page.getByLabel('本集标题', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('本集标题', { exact: true }).inputValue(), '差役登门');
  await screenshot('03-writing');
  await screenshot('03-writing', 390, 844);
  await page.setViewportSize({ width: 1586, height: 992 });
  await page.getByRole('button', { name: /删除第 2 集草稿/ }).click();
  await page.getByRole('dialog').waitFor(); await screenshot('04-delete-draft');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByLabel('本集标题', { exact: true }).fill('差役登门 · 修订');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await page.getByText('第 2 集草稿已保存。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '提交审稿', exact: true }).click();
  await page.getByText('第 2 集已提交审稿，尚未进入制作。', { exact: true }).waitFor();
  for (const label of ['只看画面、听对白，能分清谁是谁', '能理解主角这一集要什么', '能理解为什么此刻不能走', '已回查前后集、角色已知信息和未回收悬念', '已核对已锁分镜、配音和视频素材的影响']) await page.getByLabel(label, { exact: true }).check();
  await screenshot('05-review');
  await page.getByRole('button', { name: '提交审稿', exact: true }).click();
  await page.getByText('第 2 集已提交审稿，尚未进入制作。', { exact: true }).waitFor();
  await page.getByRole('tab', { name: /定稿交接/ }).click();
  await page.getByRole('button', { name: '确认本集定稿', exact: true }).nth(1).click();
  await page.getByRole('dialog').waitFor(); await screenshot('06-confirm-version');
  await page.getByRole('dialog').getByRole('button', { name: /确认锁定 v/ }).click();
  await page.getByText(/第 2 集 v\d+ 已定稿。/).waitFor();
  await screenshot('07-handoff');
  view = await snapshot(); assert.equal(view.episodes[1].script.reviewStatus, 'APPROVED');
  evidence.checks.push('edit/save/review/checklist/explicit episode lock persist in PostgreSQL');
  await page.getByRole('tab', { name: /逐集编写/ }).click();
  await page.getByRole('button', { name: /第1集 活人认碑/ }).click();
  await page.getByRole('button', { name: '版本记录', exact: true }).click();
  await page.getByRole('button', { name: '删除已锁版本', exact: true }).first().click();
  await page.getByRole('dialog', { name: /删除第 1 集/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: '移入回收站', exact: true }).isDisabled(), true);
  await screenshot('08-dependent-lock-protected');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  if (await page.getByRole('dialog', { name: '版本记录', exact: true }).count()) await page.getByRole('dialog', { name: '版本记录', exact: true }).getByRole('button', { name: '关闭弹窗', exact: true }).click();
  evidence.checks.push('locked preceding episode cannot be deleted while a later episode references it');
  const latest = view.episodes[1];
  const newDraft = structuredClone(latest.script.content.workbench.script); newDraft.title = '差役登门 · 待删修订稿';
  await request(`${base}/episodes/${latest.id}/script-workbench`, { sourceStoryRevisionId: view.story.id, script: newDraft }, latest.rowVersion);
  await page.reload(); await page.getByLabel('本集标题', { exact: true }).waitFor();
  await page.getByRole('button', { name: /删除第 2 集草稿/ }).click();
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByText(/第 2 集 v\d+ 已移入回收站/).waitFor();
  await page.goto(`${WEB}/studio/trash`);
  await page.getByRole('button', { name: /恢复第 2 集/ }).waitFor();
  await screenshot('09-trash'); await screenshot('09-trash', 390, 844);
  await page.setViewportSize({ width: 1586, height: 992 });
  await page.getByRole('button', { name: /恢复第 2 集/ }).click();
  await page.getByText(/已恢复《无名碑 · 验收样本》第 2 集/).waitFor();
  await page.goto(`${WEB}${base}/script`); await page.getByLabel('本集标题', { exact: true }).waitFor();
  await page.getByRole('button', { name: '版本记录', exact: true }).click();
  await page.getByRole('button', { name: '载入为修订草稿', exact: true }).first().click();
  assert.equal(await page.getByLabel('本集标题', { exact: true }).inputValue(), '差役登门 · 待删修订稿');
  await page.getByRole('button', { name: '我已核对前集版本', exact: true }).click();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await page.getByText('第 2 集草稿已保存。', { exact: true }).waitFor();
  evidence.checks.push('draft trash/restore/history reload/save new revision');
  await page.goto(`${WEB}/studio`);
  await page.getByRole('checkbox', { name: '选择作品：无名碑 · 验收样本', exact: true }).check();
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByText(/全部 3 集/).waitFor();
  await screenshot('10-project-delete');
  await page.getByRole('button', { name: '确认移入 1 部', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal((await request('/library/projects')).total, 0);
  await page.goto(`${WEB}/studio/trash`);
  await page.getByRole('button', { name: '恢复作品：无名碑 · 验收样本', exact: true }).click();
  await page.getByText('已恢复《无名碑 · 验收样本》，可在「我的作品」继续创作。', { exact: true }).waitFor();
  assert.equal((await request('/library/projects')).total, 1);
  evidence.checks.push('whole project trash/count filtering/restore');

  // A second real login represents another editor. Keep its cookies separate while expiring this tab.
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await otherPage.goto(`${WEB}/login`);
  await otherPage.getByLabel('账号', { exact: true }).fill('qa');
  await otherPage.getByLabel('密码', { exact: true }).fill(password);
  await otherPage.getByRole('button', { name: '登录', exact: true }).click();
  await otherPage.waitForURL(`${WEB}/studio`);

  await page.goto(`${WEB}${base}/script`);
  await page.getByLabel('本集标题', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^第2集 / }).click();
  const original = await snapshot(), episodeBeforeExpiry = original.episodes[1];
  const scriptPath = `${base}/episodes/${episodeBeforeExpiry.id}/script-workbench`;
  const localTitle = '差役登门 · 登录前未保存的正文';
  const localGenre = '古装悬疑 · 登录前未保存的题材';
  const remoteTitle = '差役登门 · 另一编辑者已保存的正文';
  await page.getByLabel('本集标题', { exact: true }).fill(localTitle);
  await page.getByRole('tab', { name: /立项/ }).click();
  await page.getByLabel('题材', { exact: true }).fill(localGenre);
  await page.getByRole('tab', { name: /逐集编写/ }).click();
  const beforeUnload = async dialog => {
    if (dialog.type() !== 'beforeunload') { evidence.errors.push(`Unexpected native dialog: ${dialog.type()}`); await dialog.dismiss(); return; }
    evidence.acceptedBeforeUnload = (evidence.acceptedBeforeUnload ?? 0) + 1;
    await dialog.accept();
  };
  page.on('dialog', beforeUnload);
  const saveResponse = () => page.waitForResponse(response => response.url() === `${WEB}/api/v1${scriptPath}` && response.request().method() === 'POST');
  const expiredSave = saveResponse();
  await page.context().clearCookies();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  const expired = await expiredSave;
  assert.equal(expired.status(), 401, 'expired save must reach the real authentication guard');
  const expiredHeaders = expired.request().headers();
  assert.equal(expiredHeaders['if-match'], String(episodeBeforeExpiry.rowVersion));
  assert.equal(expired.request().postDataJSON().sourceStoryRevisionId, original.story.id);
  await page.waitForURL(/\/login\?.*reason=expired/);
  assert.equal(new URL(page.url()).searchParams.get('returnTo'), `${base}/script`);

  const remoteScript = structuredClone(episodeBeforeExpiry.script.content.workbench.script);
  remoteScript.title = remoteTitle;
  await request(scriptPath, { script: remoteScript, sourceStoryRevisionId: original.story.id }, episodeBeforeExpiry.rowVersion, otherPage);
  const remote = await request(`${base}/script-workbench`, undefined, undefined, otherPage);
  assert.ok(remote.episodes[1].rowVersion > episodeBeforeExpiry.rowVersion);
  await page.getByLabel('账号', { exact: true }).fill('qa');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(`${WEB}${base}/script`);
  await page.getByText('已恢复此标签页的未保存草稿；保留原编辑版本，服务器更新不会被自动覆盖。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('本集标题', { exact: true }).inputValue(), localTitle);
  await page.getByRole('tab', { name: /立项/ }).click();
  assert.equal(await page.getByLabel('题材', { exact: true }).inputValue(), localGenre);
  await page.getByRole('tab', { name: /逐集编写/ }).click();
  await screenshot('11-recovered-drafts'); await screenshot('11-recovered-drafts', 390, 844);
  await page.setViewportSize({ width: 1586, height: 992 });
  const blockedSave = saveResponse();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  const blocked = await blockedSave;
  assert.equal(blocked.status(), 409, 'old editing CAS must reject a concurrent server update');
  assert.equal(blocked.request().headers()['if-match'], String(episodeBeforeExpiry.rowVersion));
  assert.equal(blocked.request().headers()['idempotency-key'], expiredHeaders['idempotency-key']);
  assert.equal(blocked.request().postDataJSON().sourceStoryRevisionId, original.story.id);
  assert.equal((await snapshot()).episodes[1].script.content.workbench.script.title, remoteTitle, 'failed retry must not overwrite the other editor');
  await page.getByRole('button', { name: '对照并处理版本冲突', exact: true }).click();
  const comparison = page.getByRole('dialog', { name: '处理编辑版本冲突', exact: true });
  assert.ok((await comparison.textContent()).includes(remoteTitle));
  assert.ok((await comparison.textContent()).includes(localTitle));
  await screenshot('12-editing-conflict'); await screenshot('12-editing-conflict', 390, 844);
  const mobileDialog = await comparison.boundingBox();
  assert.ok(mobileDialog && mobileDialog.x >= 0 && mobileDialog.x + mobileDialog.width <= 390 && mobileDialog.height <= 844, 'mobile conflict dialog must fit the viewport');
  await page.setViewportSize({ width: 1586, height: 992 });
  await comparison.getByRole('button', { name: '保留我的内容，采用此基线', exact: true }).click();
  await page.getByRole('button', { name: '我已核对前集版本', exact: true }).click();
  const reconciledSave = saveResponse();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  const reconciled = await reconciledSave;
  assert.equal(reconciled.status(), 201);
  assert.equal(reconciled.request().headers()['if-match'], String(remote.episodes[1].rowVersion));
  await page.getByText('第 2 集草稿已保存。', { exact: true }).waitFor();
  const after = await snapshot();
  assert.equal(after.episodes[1].script.content.workbench.script.title, localTitle);
  assert.ok(after.episodes[1].history.some(revision => revision.content.workbench?.script.title === remoteTitle), 'the concurrent server version remains in history');
  await page.getByRole('tab', { name: /立项/ }).click();
  assert.equal(await page.getByLabel('题材', { exact: true }).inputValue(), localGenre, 'saving this episode must retain the restored dirty plan');
  const planSave = page.waitForResponse(response => response.url() === `${WEB}/api/v1${base}/script-workbench/plan` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  const savedPlan = await planSave;
  assert.equal(savedPlan.status(), 201);
  assert.equal(savedPlan.request().headers()['if-match'], String(original.project.version), 'restored plan keeps its original editing CAS');
  await page.getByText('设定草稿已保存，原有版本保留在版本记录中。', { exact: true }).waitFor();
  assert.equal((await snapshot()).story.content.workbench.plan.brief.genre, localGenre);
  page.off('dialog', beforeUnload); await otherContext.close();
  evidence.checks.push('real 401/re-login restores plan and episode with original CAS and retry identity');
  evidence.checks.push('concurrent server edit survives rejected retry; explicit comparison/reconciliation saves a new revision');
  evidence.checks.push('desktop/mobile recovery and conflict screenshots have no document overflow; mobile dialog fits viewport');
  evidence.projectId = project.id;
}


async function runHistoryFlow() {
  await page.goto(`${WEB}/studio`);
  await page.waitForURL(/\/login/);
  await page.getByLabel('账号', { exact: true }).fill('qa');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(`${WEB}/studio`);
  const project = await request('/projects', { title: '百版历史 · 合成验收', episodeCount: 1, targetEpisodeSeconds: 60 });
  const base = `/projects/${project.id}`;
  const plan = {
    brief: { genre: '悬疑', audience: '短剧观众', productionConstraints: '一名演员、一个室内场地', logline: '她找到一封旧信。', targetEpisodeSeconds: 60, dialogueQuota: 4 },
    bible: { ending: '查明真相', openThreads: '谁寄来的信', characters: [{ id: 'R01', name: '阿青', appearance: '青衣', voice: '清晰', aliases: '小青', knownInformation: '见过旧信' }] },
    outline: { episodes: [{ episodeNo: 1, title: '旧信', openingHook: '信落在门前', change: '发现暗号', endingHandoff: '打开信封' }] },
  };
  const story = await request(`${base}/script-workbench/plan`, { plan }, project.version);
  const submitted = await request(`${base}/stories/${story.revisionId}/review`, { to: 'IN_REVIEW', expectedReviewVersion: 1 }, story.rowVersion);
  await request(`${base}/stories/${story.revisionId}/review`, { to: 'APPROVED', expectedReviewVersion: submitted.reviewVersion }, submitted.rowVersion);
  let view = await request(`${base}/script-workbench`);
  const episode = view.episodes[0], path = `${base}/episodes/${episode.id}/script-workbench`;
  const originalTitle = '回收站恢复的第一版正文';
  const script = { title: originalTitle, previousRevisionId: null, previousHandoff: '', openingHook: '信落在门前', change: '发现暗号', endingHandoff: '打开信封', characterKnowledge: '阿青见过旧信', unresolvedThreads: '寄信人身份',
    scenes: [{ id: 'scene1', heading: '门口', interiorExterior: 'INT', timeOfDay: 'DAY', characterIds: ['R01'], beats: [{ id: 'beat1', kind: 'action', text: '阿青拾起信封。', seconds: 3 }] }] };
  let saved = await request(path, { script, sourceStoryRevisionId: story.revisionId }, episode.rowVersion);
  const first = saved;
  for (let number = 2; number <= 105; number += 1) {
    saved = await request(path, { script: { ...script, title: `较新正文第 ${number} 版` }, sourceStoryRevisionId: story.revisionId }, saved.rowVersion);
  }
  view = await request(`${base}/script-workbench`);
  assert.equal(view.episodes[0].history.length, 100);
  assert.equal(view.episodes[0].script.id, saved.revisionId);
  assert.ok(!view.episodes[0].history.some(item => item.id === first.revisionId));
  assert.equal((await fetch(`${WEB}/api/v1${base}/episodes/${episode.id}/scripts?cursor=6`)).status, 401);
  assert.equal((await page.request.get(`${WEB}/api/v1/projects/${randomUUID()}/episodes/${episode.id}/scripts?cursor=6`)).status(), 404);
  assert.equal((await page.request.get(`${WEB}/api/v1${base}/episodes/${randomUUID()}/scripts?cursor=6`)).status(), 404);
  assert.equal((await page.request.get(`${WEB}/api/v1${base}/episodes/${episode.id}/scripts?cursor=invalid`)).status(), 400);
  await request(`${base}/episodes/${episode.id}/scripts/${first.revisionId}/trash`, { expectedVersion: saved.rowVersion }, saved.rowVersion);
  assert.ok(!(await request(`${base}/episodes/${episode.id}/scripts?cursor=6`)).items.some(item => item.id === first.revisionId), 'deleted versions are excluded even on older pages');
  await page.goto(`${WEB}/studio/trash`);
  await page.getByRole('button', { name: '恢复第 1 集 v1：百版历史 · 合成验收', exact: true }).click();
  await page.getByRole('link', { name: '查看本集版本记录', exact: true }).waitFor();
  const restored = await request(`${base}/script-workbench`);
  assert.equal(restored.episodes[0].currentScriptRevisionId, saved.revisionId, 'restoring history must preserve the current version');
  assert.equal(restored.episodes[0].approvedScriptRevisionId, null, 'restoring must not approve any version');
  await page.getByRole('link', { name: '查看本集版本记录', exact: true }).click();
  const history = page.getByRole('dialog', { name: '版本记录', exact: true });
  await history.waitFor();
  assert.equal(await history.locator('article').count(), 100);
  assert.equal(await history.locator('article').filter({ hasText: originalTitle }).count(), 0);
  const olderResponse = page.waitForResponse(response => response.url() === `${WEB}/api/v1${base}/episodes/${episode.id}/scripts?cursor=6`);
  await history.getByRole('button', { name: '加载更早版本', exact: true }).click();
  const older = await olderResponse;
  assert.equal(older.status(), 200);
  const pageBody = await older.json();
  assert.ok(pageBody.items.length <= 20, 'existing history endpoint stays bounded');
  assert.equal(pageBody.nextCursor, null);
  const original = pageBody.items.find(item => item.id === first.revisionId);
  assert.equal(original.freshnessStatus, 'STALE');
  assert.equal(original.reviewStatus, 'DRAFT');
  const oldRow = history.locator('article').filter({ hasText: originalTitle });
  await oldRow.waitFor();
  await oldRow.getByText('查看这个版本的正文', { exact: true }).click();
  await oldRow.scrollIntoViewIfNeeded();
  await screenshot('13-older-restored-history');
  await page.setViewportSize({ width: 390, height: 844 });
  await oldRow.scrollIntoViewIfNeeded();
  await screenshot('13-older-restored-history', 390, 844);
  await page.setViewportSize({ width: 1586, height: 992 });
  await oldRow.getByRole('button', { name: '载入为修订草稿', exact: true }).click();
  await history.waitFor({ state: 'hidden' });
  assert.equal(await page.getByLabel('本集标题', { exact: true }).inputValue(), originalTitle);
  assert.equal((await request(`${base}/script-workbench`)).episodes[0].currentScriptRevisionId, saved.revisionId, 'loading history is only a local edit');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await page.getByText('第 1 集草稿已保存。', { exact: true }).waitFor();
  const after = await request(`${base}/script-workbench`);
  assert.equal(after.episodes[0].script.revisionNo, 106);
  assert.equal(after.episodes[0].script.content.workbench.script.title, originalTitle);
  assert.equal(after.episodes[0].script.reviewStatus, 'DRAFT');
  assert.equal(after.episodes[0].approvedScriptRevisionId, null);
  assert.equal((await request(`${base}/episodes/${episode.id}/scripts?cursor=6`)).items.find(item => item.id === first.revisionId).freshnessStatus, 'STALE');
  evidence.projectId = project.id;
  evidence.checks.push('105 actual HTTP script versions; latest-100 snapshot stays bounded');
  evidence.checks.push('older pages enforce auth/project/episode/cursor/deleted filtering');
  evidence.checks.push('restore v1 through recycle UI opens the episode history; bounded older page exposes it');
  evidence.checks.push('loading v1 is local; explicit save creates v106 DRAFT and preserves v1 STALE without automatic approval');
  evidence.checks.push('desktop/mobile restored-history screenshots have no horizontal overflow');
}

try {
  await mkdir(output, { recursive: true });
  const identity = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  assert.equal(identity, parsed.pathname.slice(1));
  assert.equal((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rowCount, 0, 'Refusing to reset a nonempty database');
  evidence.migrations = (await database.runMigrations(pool)).applied;
  for (const name of ['20261111000100_project_library.sql', '20261111000300_script_workbench_trash.sql']) {
    await pool.query(await readFile(resolve(root, 'packages/database/prisma/drafts', name), 'utf8'));
  }
  await pool.query('INSERT INTO workspace(id,name) VALUES($1,$2)', [WORKSPACE, 'Synthetic workbench browser acceptance']);
  const env = loadApiEnv({ NODE_ENV: 'test', DATABASE_URL: url, REDIS_URL: 'redis://127.0.0.1:6399',
    S3_ENDPOINT: 'http://127.0.0.1:59000', S3_REGION: 'us-east-1', S3_BUCKET: 'isolated-qa', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test',
    APP_WORKSPACE_ID: WORKSPACE, SITE_AUTH_ENABLED: 'true', SITE_AUTH_USERNAME: 'qa', SITE_AUTH_PUBLIC_ORIGIN: WEB,
    SITE_AUTH_PASSWORD_HASH: await hashPassword(password, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 }) });
  app = await NestFactory.create(AppModule.register(env), { logger: ['error'] });
  app.setGlobalPrefix('api/v1'); app.useGlobalFilters(new SafeExceptionFilter());
  app.useBodyParser('json', { limit: '300kb' });
  await app.listen(3001, '127.0.0.1');
  web = spawn(process.execPath, [requireWeb.resolve('next/dist/bin/next'), process.env.WORKBENCH_BROWSER_WEB_MODE === 'dev' ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', '3012'], {
    cwd: resolve(root, 'apps/web'), stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: process.env.WORKBENCH_BROWSER_WEB_MODE === 'dev' ? 'development' : 'production', NEXT_TELEMETRY_DISABLED: '1' },
  });
  for (const stream of [web.stdout, web.stderr]) stream.on('data', chunk => { webLogs = (webLogs + chunk.toString()).slice(-8000); });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${WEB}/login`)).ok) break; } catch { /* startup */ }
    if (i > 100) throw Error('Web startup failed: ' + webLogs);
    await delay(200);
  }
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1586, height: 992 } });
  page = await context.newPage();
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.route('**/*', route => {
    const target = new URL(route.request().url());
    if (target.hostname !== '127.0.0.1') { evidence.externalRequests.push(target.origin); return route.abort(); }
    return route.continue();
  });
  if (process.argv.includes('--history-only')) await runHistoryFlow();
  else await runFlows();
  assert.deepEqual(evidence.errors, []);
  assert.deepEqual(evidence.externalRequests, []);
  evidence.passed = true;
  console.log(JSON.stringify(evidence));
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error);
  if (page) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (web && web.exitCode === null) { web.kill('SIGTERM'); await new Promise(resolve => web.once('exit', resolve)); }
  await app?.close(); await pool.end();
  await writeFile(resolve(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
}
