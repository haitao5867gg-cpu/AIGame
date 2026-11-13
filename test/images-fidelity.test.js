'use strict';

// 2026-11-13「图和描述对得上」快修的测试：
//  1. 内容类失败（翻译里带汉字、被安全审查误判）只换这一张，不冷却整家；翻译带汉字先重译一次。
//  2. 物品图照着介绍画：缓存 key 带介绍；没介绍的先不画；老图照用。
//  3. 中文提示词先写要画的东西，不写「不要 / 无」，不想要的进负面提示词（和主体撞字的词去掉）。
//  4. 人物外貌：设定里的 look、人物档案里写到的外貌、主角 look。
//  5. 场景参考图：只放画面描述里真的出现的物品；说明用短名词，不截半句。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const images = require('../src/images.js');
const engine = require('../src/engine.js');
const npcs = require('../src/npcs.js');
const {
  JPEG, tmpDir, createT, baseCfg, makeState, stubWarn, cfFetch, freeFetch,
} = require('./helpers/images-helpers.js');

const CF_CFG = (over) => baseCfg(Object.assign({
  IMAGE_PROVIDER: 'cloudflare,zhipu', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_TOKEN: 'cf-t',
  ZHIPU_API_KEY: 'zp-k', IMAGE_SCENE_REF_MODEL: '',
}, over || {}));
const ART = {
  zh: '厚涂插画', en: 'painterly illustration', eraZh: '近未来末世废土', eraEn: 'near-future wasteland',
  avoidZh: '古装，刀剑，马车，霓虹灯', bgZh: '灰褐纯色背景', bgEn: 'plain grey-brown background',
};
const STYLE_ZH = '厚涂插画｜近未来末世废土｜灰褐纯色背景';
function twoItemState(id, info) {
  return makeState({
    id, character: { items: ['旧铜灯', '无字信'] }, npcAttitude: {},
    bible: { title: '测试世界', tone: '', art: ART, npcs: [] },
    itemInfo: info || { '旧铜灯': { desc: '灯身斑驳的铜灯' }, '无字信': { desc: '一封没有字的信' } },
  });
}
const cfCalls = (calls) => calls.filter((c) => c.url.startsWith(images.CLOUDFLARE_API_BASE));
const zpCalls = (calls) => calls.filter((c) => c.url === images.ZHIPU_URL);
const entryOf = (dataDir, name) => Object.values(images.readIndex(dataDir)).find((e) => e.name === name);

// ---- 1. 内容类失败只换这一张 ----

test('翻译两次都只有汉字：这一张换到中文提供方，但 cloudflare 不进冷却，下一张照样先走 cloudflare', async (t) => {
  const dataDir = tmpDir(t);
  const warns = stubWarn(t);
  const calls = [];
  const seen = [];
  const translate = async (job, messages) => {
    seen.push({ name: job.name, system: messages[0].content });
    return job.name === '旧铜灯' ? '一盏旧铜灯' : 'a blank sealed letter on worn paper';
  };
  const inst = createT(CF_CFG(), { fetchImpl: cfFetch(calls), translate });
  const st = twoItemState('wfid1');
  inst.ensureImages(dataDir, st, images.listForState(st).filter((x) => x.kind === 'item'));
  await inst.waitIdle();

  assert.equal(entryOf(dataDir, '旧铜灯').provider, 'zhipu', '翻译不出英文的这一张换到智谱');
  assert.equal(entryOf(dataDir, '无字信').provider, 'cloudflare', '下一张仍然先走 cloudflare（没有被冷却）');
  assert.equal(cfCalls(calls).length, 1);
  assert.equal(zpCalls(calls).length, 1);
  assert.deepEqual(inst.providerStatus().cooling, {}, '内容类失败不冷却任何一家');
  const lamp = seen.filter((x) => x.name === '旧铜灯');
  assert.equal(lamp.length, 2, '带汉字先重译一次');
  assert.doesNotMatch(lamp[0].system, /must not contain a single Chinese character/);
  assert.match(lamp[1].system, /must not contain a single Chinese character/, '重译时明确要求全英文');
  assert.ok(warns.some((w) => /cloudflare 出图失败，这一张换下一家/.test(w)));
});

test('翻译里夹了汉字：重译成功就用重译结果；重译还夹汉字就把汉字去掉，仍走 cloudflare', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  let n = 0;
  const translate = async (job) => {
    n += 1;
    if (job.name === '旧铜灯') return n === 1 ? 'An old bronze lamp（旧铜灯）' : 'An old bronze oil lamp with a dented shade';
    return 'A blank sealed letter (无字信) on worn yellowed paper';
  };
  const inst = createT(CF_CFG(), { fetchImpl: cfFetch(calls), translate });
  const st = twoItemState('wfid2');
  inst.ensureImages(dataDir, st, images.listForState(st).filter((x) => x.kind === 'item'));
  await inst.waitIdle();

  assert.equal(cfCalls(calls).length, 2, '两张都由 cloudflare 画');
  assert.equal(zpCalls(calls).length, 0);
  const lamp = entryOf(dataDir, '旧铜灯');
  assert.equal(lamp.enPrompt, 'An old bronze oil lamp with a dented shade');
  const letter = entryOf(dataDir, '无字信');
  assert.equal(letter.enPrompt, 'A blank sealed letter on worn yellowed paper', '括号里的汉字整段去掉');
  for (const c of cfCalls(calls)) assert.doesNotMatch(c.body.prompt, /[一-鿿]/, '绝不把汉字喂给只懂英文的模型');
});

test('cloudflare 安全审查误判（NSFW 400）：只这一张换家，cloudflare 不冷却', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  const calls = [];
  const base = cfFetch(calls);
  let first = true;
  const fetchImpl = async (url, opts) => {
    if (url.startsWith(images.CLOUDFLARE_API_BASE) && first) {
      first = false;
      calls.push({ url, body: JSON.parse(opts.body) });
      return {
        ok: false, status: 400,
        json: async () => ({ success: false, errors: [{ code: 3030, message: 'AiError: Input prompt contains NSFW content.' }] }),
      };
    }
    return base(url, opts);
  };
  const inst = createT(CF_CFG(), { fetchImpl, translate: async (job) => `an item called ${job.name === '旧铜灯' ? 'lamp' : 'letter'} here` });
  const st = twoItemState('wfid3');
  inst.ensureImages(dataDir, st, images.listForState(st).filter((x) => x.kind === 'item'));
  await inst.waitIdle();
  assert.equal(entryOf(dataDir, '旧铜灯').provider, 'zhipu');
  assert.equal(entryOf(dataDir, '无字信').provider, 'cloudflare');
  assert.deepEqual(inst.providerStatus().cooling, {});
});

test('服务本身出问题（429）照旧冷却 5 分钟：下一张直接走下一家', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  const calls = [];
  const inst = createT(CF_CFG(), {
    fetchImpl: async (url, opts) => {
      if (url.startsWith(images.CLOUDFLARE_API_BASE)) {
        calls.push({ url });
        return { ok: false, status: 429, json: async () => ({ success: false, errors: [{ code: 1, message: 'too many requests' }] }) };
      }
      return freeFetch(calls)(url, opts);
    },
    translate: async () => 'some plain english words here',
  });
  const st = twoItemState('wfid4');
  inst.ensureImages(dataDir, st, images.listForState(st).filter((x) => x.kind === 'item'));
  await inst.waitIdle();
  assert.equal(cfCalls(calls).length, 1, '第二张不再请求 cloudflare');
  assert.ok(inst.providerStatus().cooling.cloudflare > 0);
});

// ---- 2. 物品图照着介绍画 ----

test('没介绍的物品：skipBareItems 时不画、列表里报 pending；介绍到了按「带介绍」的 key 画', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  const inst = createT(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k' }), { fetchImpl: freeFetch(calls) });
  const bare = twoItemState('wfid5', { '旧铜灯': { desc: '灯身斑驳的铜灯' } }); // 无字信还没有介绍
  inst.ensureImages(dataDir, bare, images.listForState(bare).filter((x) => x.kind === 'item'), { skipBareItems: true });
  await inst.waitIdle();
  assert.equal(zpCalls(calls).length, 1, '只画了有介绍的那件');
  assert.match(zpCalls(calls)[0].body.prompt, /^旧铜灯：灯身斑驳的铜灯。/);
  const list = inst.imageList(dataDir, bare);
  await inst.waitIdle();
  assert.equal(list.items['旧铜灯'].status, 'ready');
  assert.equal(list.items['无字信'].status, 'pending', '等介绍：报 pending，前端继续轮询');
  assert.equal(zpCalls(calls).length, 1, 'GET /images 不画没介绍的物品');

  const full = twoItemState('wfid5');
  inst.ensureImages(dataDir, full, images.listForState(full).filter((x) => x.kind === 'item'), { skipBareItems: true });
  await inst.waitIdle();
  assert.equal(zpCalls(calls).length, 2);
  assert.match(zpCalls(calls)[1].body.prompt, /^无字信：一封没有字的信。/);
  const idx = images.readIndex(dataDir);
  const k = images.imageKey('item', '无字信', STYLE_ZH, 'wfid5', '一封没有字的信');
  assert.equal(idx[`item-${k}`].status, 'ready');
  assert.equal(idx[`item-${k}`].bare, undefined);
});

test('介绍补不出来：不带 skipBareItems 时照样按名字画一张（标 bare）；之后介绍到了会照着介绍重画', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  const inst = createT(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k' }), { fetchImpl: freeFetch(calls) });
  const bare = makeState({
    id: 'wfid6', character: { items: ['无字信'] }, npcAttitude: {},
    bible: { title: '测试世界', tone: '', art: ART, npcs: [] },
  });
  inst.ensureImages(dataDir, bare, images.listForState(bare).filter((x) => x.kind === 'item'));
  await inst.waitIdle();
  assert.equal(zpCalls(calls).length, 1);
  assert.match(zpCalls(calls)[0].body.prompt, /^无字信。游戏道具图标/);
  const bareKey = images.imageKey('item', '无字信', STYLE_ZH, 'wfid6');
  assert.equal(images.readIndex(dataDir)[`item-${bareKey}`].bare, true);
  assert.equal(inst.imageList(dataDir, bare).items['无字信'].status, 'ready');

  const full = Object.assign({}, bare, { itemInfo: { '无字信': { desc: '一封没有字的信' } } });
  const pendingList = inst.imageList(dataDir, full); // 顺手排队
  assert.equal(pendingList.items['无字信'].status, 'pending', '只按名字画的那张不算数，照着介绍重画');
  await inst.waitIdle();
  assert.equal(zpCalls(calls).length, 2);
  assert.equal(inst.imageList(dataDir, full).items['无字信'].status, 'ready');
});

test('老图照用：本世界以前只按名字画好的物品图（没有 bare 标记），介绍到了也不重画；别的世界不沾光', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  const inst = createT(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k' }), { fetchImpl: freeFetch(calls) });
  const imgDir = path.join(dataDir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const oldKey = images.imageKey('item', '无字信', STYLE_ZH, 'wold');
  fs.writeFileSync(path.join(imgDir, `item-${oldKey}.jpg`), JPEG);
  fs.writeFileSync(path.join(imgDir, 'index.json'), JSON.stringify({
    [`item-${oldKey}`]: {
      kind: 'item', name: '无字信', style: STYLE_ZH, worldId: 'wold', file: `item-${oldKey}.jpg`,
      status: 'ready', ts: 1, provider: 'cloudflare', enPrompt: 'a blank letter', prompt: '',
    },
  }));
  const one = (id) => makeState({
    id, character: { items: ['无字信'] }, npcAttitude: {},
    bible: { title: '测试世界', tone: '', art: ART, npcs: [] },
    itemInfo: { '无字信': { desc: '一封没有字的信' } },
  });
  const old = inst.imageList(dataDir, one('wold'));
  await inst.waitIdle();
  assert.equal(old.items['无字信'].status, 'ready');
  assert.equal(old.items['无字信'].url, `/api/images/item-${oldKey}.jpg`);
  assert.equal(zpCalls(calls).length, 0, '老世界不重画');

  const other = inst.imageList(dataDir, one('wnew'));
  assert.equal(other.items['无字信'].status, 'pending', '别的世界照着自己的介绍画');
  await inst.waitIdle();
  assert.equal(zpCalls(calls).length, 1);
});

// ---- 3. 中文提示词 ----

test('中文提示词：要画的东西在最前，不带世界标题，不写「不要 / 无」；时代只限定器物和服饰，画风在最后', () => {
  const style = { zh: STYLE_ZH, artZh: '厚涂插画', eraZh: '近未来末世废土', avoidZh: ART.avoidZh, bgZh: '灰褐纯色背景' };
  const item = images.gatewayPrompt({ kind: 'item', name: '握力器', desc: '金属握把磨得发亮', style, bibleTitle: '全球最后一个男人' });
  assert.equal(item, '握力器：金属握把磨得发亮。游戏道具图标：只画这一件物品，居中特写，完整可辨认，'
    + '近未来末世废土的器物，灰褐纯色背景，画面干净。厚涂插画风格。');
  const npc = images.gatewayPrompt({
    kind: 'npc', name: '老刀', role: '避难所守卫队长', desc: '说话直来直去，对新人强硬但护短',
    look: '四十多岁的光头汉子，左脸一道刀疤，旧迷彩外套', style, bibleTitle: '末日新手村',
  });
  assert.ok(npc.startsWith('一个人物的半身肖像：避难所守卫队长，四十多岁的光头汉子，左脸一道刀疤，旧迷彩外套。'), npc);
  assert.doesNotMatch(npc, /老刀|说话直来直去|末日新手村/, '有身份和外貌时不写名字、性格、世界标题');
  assert.match(npc, /穿着近未来末世废土的服饰，衣着完整，面部清晰，只画这一个人，灰褐纯色背景，画面干净。厚涂插画风格。$/);
  // 没有 look 时退回人物简介，并留着名字（「温姐」里的称呼是唯一的性别线索）
  const noLook = images.gatewayPrompt({ kind: 'npc', name: '温姐', role: '公寓管理员', desc: '五十来岁，串钥匙走一路响一路。', style });
  assert.ok(noLook.startsWith('一个人物的半身肖像：温姐，公寓管理员，五十来岁，串钥匙走一路响一路。穿着'), noLook);
  assert.ok(images.gatewayPrompt({ kind: 'npc', name: '老刀', role: '', desc: '', style }).startsWith('一个人物的半身肖像：老刀。'));
  const hero = images.gatewayPrompt({ kind: 'hero', name: '叶峰', role: '主角', desc: '帅气冷酷', look: '二十出头的男子，短发，黑色立领外套', style });
  assert.ok(hero.startsWith('一个人物的半身肖像：二十出头的男子，短发，黑色立领外套。'));
  for (const p of [item, npc, noLook, hero]) assert.doesNotMatch(p, /不要|无文字|无印章|世界背景|。。/);

  const scene = images.scenePromptZh({
    desc: '锈铁营地板房，你贴在墙角，老赵弯腰看地', style,
    cast: [{ name: '你', look: '二十出头的男子，短发' }, { name: '老赵', look: '五十多岁，络腮胡' }, { name: '路人', look: '' }],
    bibleTitle: '末日游戏',
  });
  assert.ok(scene.startsWith('锈铁营地板房，主角贴在墙角，老赵弯腰看地。画面里的人：主角是二十出头的男子，短发；老赵是五十多岁，络腮胡。'), scene);
  assert.match(scene, /游戏场景插画，电影感横幅构图，近未来末世废土的环境和服饰，人物衣着完整，灰褐纯色色调，画面干净。厚涂插画风格。$/);
  assert.doesNotMatch(scene, /你|不要|无文字|末日游戏|路人/, '「你」写成主角；没有外貌的人不进人物表');
});

test('负面提示词：通用项 + 安全项 + 本世界禁用词；和要画的东西撞字的禁用词去掉', () => {
  const style = { avoidZh: '古装，刀剑，马车，霓虹灯' };
  assert.equal(images.negativePromptZh({ kind: 'item', name: '压缩饼干', style }),
    '文字，印章，书法，落款，水印，签名，边框，模糊，畸形，裸露，色情，古装，刀剑，马车，霓虹灯');
  const knife = images.negativePromptZh({ kind: 'item', name: '新手短刀', style });
  assert.doesNotMatch(knife, /刀剑/, '画的就是刀，禁用词里的「刀剑」要去掉');
  assert.match(knife, /古装，马车，霓虹灯$/);
  const scene = images.negativePromptZh({ kind: 'scene', name: '夜市', desc: '霓虹灯下的夜市，两人对坐', style });
  assert.doesNotMatch(scene, /霓虹灯/);
  assert.equal(images.negativePromptZh({ kind: 'npc', name: '守夜人', style: {} }),
    '文字，印章，书法，落款，水印，签名，边框，模糊，畸形，裸露，色情');
});

test('硅基流动：负面提示词走 negative_prompt 参数，正向提示词里没有「不要」', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  const inst = createT(baseCfg({ IMAGE_PROVIDER: 'siliconflow', SILICONFLOW_API_KEY: 'sf-k' }), { fetchImpl: freeFetch(calls) });
  const st = makeState({
    id: 'wfid7', character: { items: ['新手短刀'] }, npcAttitude: {},
    bible: { title: '末日游戏', tone: '', art: ART, npcs: [] },
    itemInfo: { '新手短刀': { desc: '系统发放的制式武器' } },
  });
  inst.ensureImages(dataDir, st, images.listForState(st).filter((x) => x.kind === 'item'));
  await inst.waitIdle();
  const body = calls.find((c) => c.url === images.SILICONFLOW_URL).body;
  assert.match(body.prompt, /^新手短刀：系统发放的制式武器。/);
  assert.doesNotMatch(body.prompt, /不要|末日游戏/);
  assert.equal(body.negative_prompt, '文字，印章，书法，落款，水印，签名，边框，模糊，畸形，裸露，色情，古装，马车，霓虹灯');
});

// ---- 4. 人物外貌 ----

test('listForState：NPC 带设定里的 look；中途出场的人物用档案里写到的身份和外貌；主角带 look', () => {
  const st = makeState({
    id: 'wfid8',
    character: { name: '叶峰', appearance: '帅气冷酷', look: '二十出头的男子，短发，黑色立领外套', items: [] },
    npcAttitude: { '沈九娘': 0, '老郑': 0, '路人甲': 0 },
    bible: {
      title: '测试', tone: '',
      npcs: [{ name: '沈九娘', role: '米行当家', desc: '说话不紧不慢，算账一眼准', look: '四十上下的妇人，银簪挽发，青布围裙' }],
    },
    npcProfiles: {
      n1: {
        id: 'n1', name: '老郑', role: '营地门卫', description: '话少',
        traits: { appearance: { 年纪: '四十多岁', 特征: '左眉有疤', 衣着: '旧迷彩外套' }, identity: {} },
      },
      n2: { id: 'n2', name: '沈九娘', role: '别的身份', traits: { appearance: { 衣着: '换了件灰袍' } } },
    },
  });
  const list = images.listForState(st);
  assert.deepEqual(list[0], { kind: 'hero', name: '叶峰', role: '主角', desc: '帅气冷酷', look: '二十出头的男子，短发，黑色立领外套' });
  const by = (n) => list.find((x) => x.kind === 'npc' && x.name === n);
  assert.deepEqual(by('沈九娘'), {
    kind: 'npc', name: '沈九娘', role: '米行当家', desc: '说话不紧不慢，算账一眼准', look: '四十上下的妇人，银簪挽发，青布围裙',
  }, '设定里有 look 就用设定的');
  assert.deepEqual(by('老郑'), {
    kind: 'npc', name: '老郑', role: '营地门卫', desc: '话少', look: '四十多岁，左眉有疤，旧迷彩外套',
  }, '不在设定里的人物：身份、简介、外貌都取自人物档案');
  assert.deepEqual(by('路人甲'), { kind: 'npc', name: '路人甲', role: '', desc: '', look: '' });
});

test('英文翻译的 subject：有 look 用「外貌」，没有才用「描述」；主角优先用 look', async (t) => {
  const dataDir = tmpDir(t);
  const subjects = {};
  const translate = async (job, messages) => { subjects[job.kind + ':' + job.name] = messages[1].content; return 'a person standing in plain clothes'; };
  const inst = createT(CF_CFG({ IMAGE_PROVIDER: 'cloudflare' }), { fetchImpl: cfFetch([]), translate });
  const st = makeState({
    id: 'wfid9',
    character: { name: '叶峰', appearance: '帅气冷酷', look: '二十出头的男子，短发', items: [] },
    npcAttitude: { '沈九娘': 0, '老周': 0 },
    bible: {
      title: '测试', tone: '', art: ART,
      npcs: [
        { name: '沈九娘', role: '米行当家', desc: '算账一眼准', look: '四十上下的妇人，银簪挽发' },
        { name: '老周', role: '面馆老板', desc: '五十多岁的胖男人' },
      ],
    },
  });
  inst.ensureImages(dataDir, st, images.listForState(st));
  await inst.waitIdle();
  assert.match(subjects['npc:沈九娘'], /身份：米行当家；外貌：四十上下的妇人，银簪挽发；/);
  assert.doesNotMatch(subjects['npc:沈九娘'], /算账一眼准/);
  assert.match(subjects['npc:老周'], /身份：面馆老板；描述：五十多岁的胖男人；/);
  assert.match(subjects['hero:叶峰'], /^主角：二十出头的男子，短发；/);
});

test('建世界 / 重生 / 公开状态：主角 look 进 character，重生时清掉；npcs[].look 是公开字段', () => {
  const bible = {
    title: '测试', tone: '', rules: [], places: [{ name: '甲地', desc: '' }], factions: [],
    npcs: [{ name: '沈九娘', role: '米行当家', desc: '算账一眼准', look: '银簪挽发的妇人', want: '守住米行', voice: '慢' }],
    start: { place: '甲地', situation: '', items: ['旧铜灯'] }, eventThemes: [],
  };
  const world = engine.createWorld(
    { id: 'wfid10', seed: 's', name: '叶峰', appearance: '帅气冷酷', look: ' 二十出头的男子，短发 ', bible, apex: { title: 'x', hint: 'y', condition: { attrs: {} } } },
    { rng: () => 0.5, now: 1 },
  );
  assert.equal(world.character.look, '二十出头的男子，短发');
  const noLook = engine.createWorld(
    { id: 'wfid11', seed: 's', name: '叶峰', appearance: '青衣', bible, apex: { title: 'x', hint: 'y', condition: { attrs: {} } } },
    { rng: () => 0.5, now: 1 },
  );
  assert.equal(Object.prototype.hasOwnProperty.call(noLook.character, 'look'), false, '没有 look 就不带这个字段');
  const pub = npcs.publicBibleNpcs(world);
  assert.equal(pub[0].look, '银簪挽发的妇人');
  assert.equal(pub[0].want, undefined, '隐藏动机照旧不公开');

  const dead = Object.assign({}, world, { character: Object.assign({}, world.character, { alive: false }) });
  const reborn = engine.rebirth(dead, { name: '新名', appearance: '白衣' });
  assert.ok(!reborn.error, '重生应成功');
  assert.equal(Object.prototype.hasOwnProperty.call(reborn.state.character, 'look'), false, '重生后按新形象画');
});

// ---- 5. 场景参考图 ----

test('itemInScene：整名、去掉数量词的名字、名字最后两个字出现在画面描述里才算', () => {
  assert.equal(images.itemInScene('旧铜灯', '守夜人提着旧铜灯在右侧'), true);
  assert.equal(images.itemInScene('一根旧竹篙', '阿橹撑着竹篙立在船头'), true);
  assert.equal(images.itemInScene('碎屏旧手机', '你蹲在空调外机旁握着手机'), true);
  assert.equal(images.itemInScene('一根旧竹篙', '你俯身辨册，阿橹蹲在右侧按布角，日光斜落瓦脊'), false);
  assert.equal(images.itemInScene('旧铜灯', '守夜人提灯走过长街'), false, '只对上一个字不算');
  assert.equal(images.itemInScene('', '任何描述'), false);
});

test('shortNoun：取英文描述的第一小段、去冠词、最多 6 个词，不截成半句', () => {
  assert.equal(images.shortNoun('A confident woman in her forties wearing a practical jacket, standing with hands on hips', 'x'), 'confident woman');
  assert.equal(images.shortNoun('A weathered bamboo punting pole, worn glossy at the tip, as used in canal towns', 'x'), 'weathered bamboo punting pole');
  assert.equal(images.shortNoun('A cracked-screen old smartphone, still usable, holding contact numbers', 'x'), 'cracked-screen old smartphone');
  assert.equal(images.shortNoun('A narrow twice-folded slip of paper with handwritten words, tucked in a door gap', 'x'), 'narrow twice-folded slip of paper');
  assert.equal(images.shortNoun('', 'item'), 'item');
});

test('场景多参考图：画面里没用到的物品不当参考图；说明是短名词', async (t) => {
  const dataDir = tmpDir(t);
  const WORLD = 'wfid12';
  const imgDir = path.join(dataDir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const idx = {};
  const put = (kind, key, extra) => {
    const file = `${kind}-${key}.jpg`;
    fs.writeFileSync(path.join(imgDir, file), JPEG);
    idx[`${kind}-${key}`] = Object.assign({
      kind, style: STYLE_ZH, worldId: WORLD, file, status: 'ready', ts: 1, provider: 'cloudflare', prompt: '',
    }, extra);
  };
  put('hero', images.imageKey('hero', '叶峰|青衣', STYLE_ZH, WORLD), { name: '叶峰', enPrompt: 'a young man' });
  put('npc', images.imageKey('npc', '阿橹', STYLE_ZH, WORLD), {
    name: '阿橹', enPrompt: 'A barefoot young boatman in his early twenties, holding a punting pole, grinning',
  });
  put('item', images.imageKey('item', '一根旧竹篙', STYLE_ZH, WORLD, '撑船用的旧竹篙'), {
    name: '一根旧竹篙', enPrompt: 'A weathered bamboo punting pole, worn glossy at the tip, as used in canal towns',
  });
  fs.writeFileSync(path.join(imgDir, 'index.json'), JSON.stringify(idx));

  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: opts && opts.body });
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ success: true, result: { image: JPEG.toString('base64') } }),
    };
  };
  const inst = createT(CF_CFG({ IMAGE_PROVIDER: 'cloudflare', IMAGE_SCENE_REF_MODEL: undefined }), {
    fetchImpl, translate: async () => 'two figures on a tiled rooftop in slanting sunlight',
  });
  const st = makeState({
    id: WORLD, life: 1,
    character: { name: '叶峰', appearance: '青衣', items: ['一根旧竹篙'] },
    npcAttitude: { '阿橹': 0 },
    bible: { title: '潮尸水乡', tone: '', art: ART, npcs: [{ name: '阿橹', role: '船帮后生', desc: '爱逞能' }] },
    itemInfo: { '一根旧竹篙': { desc: '撑船用的旧竹篙' } },
  });
  // 记账模型把背包里的竹篙也填进了 items，但这一幕没用到它
  inst.ensureScene(dataDir, st, {
    turn: 8, desc: '排屋屋脊，你俯身辨册，阿橹蹲在右侧按布角', place: '排屋屋脊',
    cast: ['你', '阿橹'], items: ['一根旧竹篙'], action: '你俯身辨册，阿橹蹲在右侧按布角，日光斜落瓦脊',
  });
  await inst.waitIdle();
  let form = calls.find((c) => c.url.includes('flux-2-klein-4b')).body;
  assert.ok(form.get('input_image_0') && form.get('input_image_1'));
  assert.equal(form.get('input_image_2'), null, '没用到的竹篙不当参考图');
  let p = String(form.get('prompt'));
  assert.match(p, /In the scene: the person from image 0 \(the main character\); the person from image 1 \(barefoot young boatman\)\. Keep each person's face/);
  assert.doesNotMatch(p, /punting pole/);

  // 画面里真的用到竹篙：带上物品参考图，说明是短名词
  inst.ensureScene(dataDir, st, {
    turn: 9, desc: '水下街，阿橹撑着竹篙立在船头', place: '水下街',
    cast: ['你', '阿橹'], items: ['一根旧竹篙'], action: '阿橹撑着竹篙立在船头，你在水里',
  });
  await inst.waitIdle();
  form = calls.filter((c) => c.url.includes('flux-2-klein-4b'))[1].body;
  assert.ok(form.get('input_image_2'), '用到的物品带参考图（按带介绍的 key 找到）');
  p = String(form.get('prompt'));
  assert.match(p, /the weathered bamboo punting pole from image 2\. Keep each person's face, hair and clothing exactly as in their reference image and the item exactly/);
});

// ---- 6. 第二步：记账模型直接写英文画面，人和参考图一一对应 ----

test('normalizeScene：place_en / light_en / people 收成 en；带汉字、过长、不在 cast 里的整项丢掉；没有就不带 en', () => {
  const sc = engine.normalizeScene({
    draw: true, place: '排屋屋脊', cast: ['你', '阿橹'], items: [], action: '你俯身辨册，阿橹蹲在右侧按布角',
    place_en: ' "a tiled roof ridge above a water town". ', light_en: 'slanting sunlight',
    people: [
      { who: '你', en: 'a young traveler bending down to read a register', pos: 'Center' },
      { who: '阿橹', en: 'a barefoot young boatman crouching, pressing down a cloth corner.', pos: 'right' },
      { who: '路人', en: 'a passer-by', pos: 'left' },
      { who: '阿橹', en: 'duplicate', pos: 'left' },
    ],
  });
  assert.deepEqual(sc.en, {
    place: 'a tiled roof ridge above a water town', light: 'slanting sunlight',
    people: [
      { who: '你', en: 'a young traveler bending down to read a register', pos: 'center' },
      { who: '阿橹', en: 'a barefoot young boatman crouching, pressing down a cloth corner', pos: 'right' },
    ],
  });
  const bad = engine.normalizeScene({
    draw: true, place: '屋脊', cast: ['你'], action: '你俯身',
    place_en: '水下街 flooded street', light_en: 'x'.repeat(200), people: [{ who: '你', en: '俯身', pos: 'up' }, 'x', null],
  });
  assert.equal(Object.prototype.hasOwnProperty.call(bad, 'en'), false, '没有可用的英文画面就不带 en（走老的翻译链路）');
  const old = engine.normalizeScene({ draw: true, place: '屋脊', cast: ['你'], action: '你俯身' });
  assert.deepEqual(old, { draw: true, desc: '屋脊，你俯身', place: '屋脊', cast: ['你'], items: [], action: '你俯身' });
  const posless = engine.normalizeScene({ draw: true, place: '屋脊', cast: ['你'], action: '你俯身', people: [{ who: '你', en: 'a man standing', pos: 'up' }] });
  assert.deepEqual(posless.en, { place: '', light: '', people: [{ who: '你', en: 'a man standing', pos: '' }] });
});

test('sceneBoundText / sceneEnglish：有参考图的人写明是哪张图，没有的人只写外貌和动作；没有结构化画面返回空串', () => {
  const en = {
    place: 'a narrow flooded street between empty wooden houses', light: 'overcast dusk',
    people: [
      { who: '你', en: 'a young traveler sunk waist-deep in mud clutching a register book', pos: 'center' },
      { who: '阿橹', en: 'a barefoot young boatman reaching out from a boat', pos: 'right' },
      { who: '沈九娘', en: 'a middle-aged woman watching from a doorway', pos: 'background' },
    ],
  };
  const refs = [
    { type: 'person', who: '你', label: 'the main character' },
    { type: 'person', who: '阿橹', label: 'barefoot young boatman' },
    { type: 'item', label: 'weathered bamboo punting pole' },
  ];
  assert.equal(images.sceneBoundText({ en, refs }),
    'A narrow flooded street between empty wooden houses, overcast dusk. '
    + 'The person from image 0 (the main character), a young traveler sunk waist-deep in mud clutching a register book, in the center. '
    + 'The person from image 1, a barefoot young boatman reaching out from a boat, on the right. '
    + 'Also in the scene: a middle-aged woman watching from a doorway, in the background. '
    + 'The weathered bamboo punting pole from image 2 is in the scene.');
  // 参考图里有、画面描述里没写到的人：照样带上
  assert.match(images.sceneBoundText({ en: { place: 'a street', light: '', people: [] }, refs: refs.slice(0, 2) }),
    /^A street\. The person from image 0 \(the main character\) is also present\. The person from image 1 \(barefoot young boatman\) is also present\.$/);
  assert.equal(images.sceneEnglish({ en }),
    'a narrow flooded street between empty wooden houses, overcast dusk. '
    + 'a young traveler sunk waist-deep in mud clutching a register book, in the center; '
    + 'a barefoot young boatman reaching out from a boat, on the right; '
    + 'a middle-aged woman watching from a doorway, in the background');
  assert.equal(images.sceneBoundText({ en: null, refs }), '');
  assert.equal(images.sceneBoundText({ en: { place: '', people: [] }, refs }), '');
  assert.equal(images.sceneEnglish({}), '');
});

test('场景出图：有英文画面就不再调翻译，多参考图提示词里人和图一一对应；主角名统一成「你」；没有参考图走文生图也用它', async (t) => {
  const dataDir = tmpDir(t);
  const WORLD = 'wfid13';
  const imgDir = path.join(dataDir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const idx = {};
  const put = (kind, key, extra) => {
    const file = `${kind}-${key}.jpg`;
    fs.writeFileSync(path.join(imgDir, file), JPEG);
    idx[`${kind}-${key}`] = Object.assign({ kind, style: STYLE_ZH, worldId: WORLD, file, status: 'ready', ts: 1, prompt: '' }, extra);
  };
  put('hero', images.imageKey('hero', '叶峰|青衣', STYLE_ZH, WORLD), { name: '叶峰', provider: 'cloudflare', enPrompt: 'a young man' });
  // 硅基流动画的头像（带水印、没有英文描述）现在也当参考图
  put('npc', images.imageKey('npc', '秦霜', STYLE_ZH, WORLD), { name: '秦霜', provider: 'siliconflow', enPrompt: '' });
  fs.writeFileSync(path.join(imgDir, 'index.json'), JSON.stringify(idx));

  const calls = [];
  let translated = 0;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: opts && opts.body });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true, result: { image: JPEG.toString('base64') } }) };
  };
  const inst = createT(CF_CFG({ IMAGE_PROVIDER: 'cloudflare', IMAGE_SCENE_REF_MODEL: undefined }), {
    fetchImpl, translate: async () => { translated += 1; return 'should not be used'; },
  });
  const st = makeState({
    id: WORLD, life: 1, character: { name: '叶峰', appearance: '青衣', items: [] }, npcAttitude: { '秦霜': 0, '温姐': 0 },
    bible: { title: '测试', tone: '', art: ART, npcs: [{ name: '秦霜', role: '邻居', desc: '短发' }] },
  });
  const en = {
    place: 'inside a high-rise apartment by the front door', light: 'harsh searchlight at dusk',
    people: [
      { who: '秦霜', en: 'a short-haired woman gripping the door handle', pos: 'right' },
      { who: '叶峰', en: 'a young man looking back over his shoulder', pos: 'left' },
    ],
  };
  inst.ensureScene(dataDir, st, {
    turn: 1, desc: '白鹭公寓1607，秦霜立在门边捏着门把手，叶峰侧身回头', place: '白鹭公寓1607',
    cast: ['叶峰', '秦霜'], items: [], action: '秦霜立在门边捏着门把手，叶峰侧身回头', en,
  });
  await inst.waitIdle();
  assert.equal(translated, 0, '不再调翻译');
  const form = calls.find((c) => c.url.includes('flux-2-klein-4b')).body;
  assert.ok(form.get('input_image_0') && form.get('input_image_1'), '主角 + 硅基画的秦霜头像都当参考图');
  const p = String(form.get('prompt'));
  assert.ok(p.includes('Inside a high-rise apartment by the front door, harsh searchlight at dusk. '
    + 'The person from image 1, a short-haired woman gripping the door handle, on the right. '
    + 'The person from image 0 (the main character), a young man looking back over his shoulder, on the left. '
    + "Keep each person's face, hair and clothing exactly as in their reference image. "
    + 'Period-accurate setting, fully clothed characters, clean image, unsigned.'), p);
  assert.ok(p.startsWith('painterly illustration. Wide cinematic 16:9 scene, near-future wasteland style. '));

  // 没有任何参考图（人物都还没头像）：文生图也直接用英文画面
  inst.ensureScene(dataDir, st, {
    turn: 2, desc: '走廊，温姐提着一串钥匙走来', place: '走廊', cast: ['温姐'], items: [], action: '温姐提着一串钥匙走来',
    en: { place: 'a dim apartment corridor', light: '', people: [{ who: '温姐', en: 'a woman in her fifties carrying a ring of keys', pos: 'center' }] },
  });
  await inst.waitIdle();
  assert.equal(translated, 0);
  const t2i = calls.filter((c) => c.url.includes('flux-1-schnell')).pop();
  assert.ok(t2i, '没有参考图走文生图');
  assert.match(JSON.parse(t2i.body).prompt, /^painterly illustration\. a dim apartment corridor\. a woman in her fifties carrying a ring of keys, in the center, near-future wasteland style, /);

  // 老格式（没有 en）：照旧翻译
  inst.ensureScene(dataDir, st, { turn: 3, desc: '走廊尽头，叶峰停下脚步', place: '走廊尽头', cast: ['叶峰'], items: [], action: '叶峰停下脚步' });
  await inst.waitIdle();
  assert.equal(translated, 1, '没有英文画面时照旧走翻译');
});

test('记账说明：出图回合要给 place_en / light_en / people，且每个人的动作分开写', () => {
  const prompts = require('../src/prompts.js');
  const st = makeState({ id: 'wfid14', character: { name: '叶峰', items: [], attrs: {}, marks: [] }, npcAttitude: {} });
  const sys = prompts.buildLedgerMessages(st, { action: '看看', prose: '正文', plan: {} })[0].content;
  assert.match(sys, /"place_en"/);
  assert.match(sys, /"light_en"/);
  assert.match(sys, /"people"/);
  assert.match(sys, /不要把两个人的动作写到一个人身上/);
});
