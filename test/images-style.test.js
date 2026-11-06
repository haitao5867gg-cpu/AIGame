'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const images = require('../src/images.js');
const store = require('../src/store.js');
const { JPEG, tmpDir, withArt, configureT, createT, baseCfg, makeState, okFetch, stubWarn, freeFetch, oneItemState, msFetch, cfFetch, XIANXIA_ART, xianxiaState } = require('./helpers/images-helpers.js');

// ---- 每个世界的画风设定 + 锁时代的提示词 ----

test('画风设定：LLM 生成一次写入 styles.json，提示词带画风 / 世界背景 / 时代，负面词带 avoid；之后复用缓存', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  let directed = 0;
  let seenBrief = '';
  const director = async (state, messages) => { directed += 1; seenBrief = messages[1].content; return XIANXIA_ART; };
  images.configure(baseCfg({ IMAGE_PROVIDER: 'siliconflow', SILICONFLOW_API_KEY: 'sf-k' }),
    { fetchImpl: freeFetch(calls), artDirector: director });
  const st = xianxiaState('wart');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.equal(directed, 1);
  assert.match(seenBrief, /杂役百年/);
  assert.match(seenBrief, /外门/);
  const styles = JSON.parse(fs.readFileSync(path.join(dataDir, 'images', 'styles.json'), 'utf8'));
  assert.equal(styles.wart.zh, XIANXIA_ART.zh);
  assert.equal(styles.wart.v, 2);
  const body = calls[0].body;
  assert.match(body.prompt, /^中国古风水墨仙侠插画。世界背景：杂役百年，中国古代修仙宗门。游戏道具图标：旧铜灯，该时代的器物/);
  assert.match(body.prompt, /米白宣纸色背景，无文字，无印章，无书法字，无水印，不要出现裸露，色情，现代物品，霓虹，赛博朋克$/);
  assert.match(body.negative_prompt, /^文字，印章，书法，落款，/);
  assert.match(body.negative_prompt, /现代物品，霓虹，赛博朋克$/);
  const e = Object.values(images.readIndex(dataDir))[0];
  assert.equal(e.style, '中国古风水墨仙侠插画｜中国古代修仙宗门｜米白宣纸色背景');
  assert.equal(e.status, 'ready');

  // 新实例（模拟重启）：直接读缓存，不再调 LLM，也不重画。
  const calls2 = [];
  images.configure(baseCfg({ IMAGE_PROVIDER: 'siliconflow', SILICONFLOW_API_KEY: 'sf-k' }),
    { fetchImpl: freeFetch(calls2), artDirector: director });
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.equal(directed, 1);
  assert.equal(calls2.length, 0);
});

test('画风设定：bible.art 优先，不调 LLM；画风变了缓存 key 变，旧图自动重画', async (t) => {
  const dataDir = tmpDir(t);
  let directed = 0;
  const director = async () => { directed += 1; return null; };
  // 先用关键词规则兜底出一张
  images.configure(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k' }), { fetchImpl: freeFetch(null), artDirector: director });
  const st = xianxiaState('wbible');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.equal(directed, 1);
  const before = Object.values(images.readIndex(dataDir));
  assert.equal(before.length, 1);
  assert.equal(before[0].style, '水墨淡彩插画｜中国古代仙侠｜米白宣纸色背景'); // 关键词兜底也带时代和背景

  // bible 里写了画风 → 优先用它，key 变化 → 重新出图
  const st2 = Object.assign({}, st, { bible: Object.assign({}, st.bible, { art: XIANXIA_ART }) });
  const calls = [];
  images.configure(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k' }), { fetchImpl: freeFetch(calls), artDirector: director });
  images.ensureImages(dataDir, st2, images.listForState(st2));
  await images.waitIdle();
  assert.equal(directed, 1, 'bible.art 存在时不调 LLM');
  assert.equal(calls.filter((c) => c.url === images.ZHIPU_URL).length, 1, '画风变了应重画');
  const after = Object.values(images.readIndex(dataDir)).filter((e) => e.style === '中国古风水墨仙侠插画｜中国古代修仙宗门｜米白宣纸色背景');
  assert.equal(after.length, 1);
  assert.equal(after[0].status, 'ready');
});

test('画风设定：cloudflare 英文提示词以画风 + 时代开头，翻译请求带时代背景与锁时代要求', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  let tMessages = null;
  images.configure(baseCfg({ IMAGE_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' }), {
    fetchImpl: cfFetch(calls),
    artDirector: async () => XIANXIA_ART,
    translate: async (job, messages) => { tMessages = messages; return 'a tarnished bronze oil lamp'; },
  });
  const st = xianxiaState('wcfart');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.match(tMessages[0].content, /MUST fit the world's era/);
  assert.match(tMessages[1].content, /时代背景：中国古代修仙宗门/);
  assert.equal(calls[0].body.prompt,
    'ancient xianxia ink and watercolor illustration. a tarnished bronze oil lamp, ancient China, cultivation sect style, '
    + 'period-accurate object, single object centered, game item icon, plain off-white light beige background, '
    + 'clean empty background, unsigned');
});

test('画风设定：LLM 返回字段不全 → 关键词规则兜底，且不写 styles.json', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  images.configure(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k' }),
    { fetchImpl: freeFetch(null), artDirector: async () => ({ zh: '只有一个字段' }) });
  const st = xianxiaState('wbad');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.ok(!fs.existsSync(path.join(dataDir, 'images', 'styles.json')));
  assert.equal(Object.values(images.readIndex(dataDir))[0].style, '水墨淡彩插画｜中国古代仙侠｜米白宣纸色背景');
});

test('画风设定：styles.json 里旧条目（无 v）照用，缓存 key 保持「画风｜时代」，不调 LLM；背景按规则补', async (t) => {
  const dataDir = tmpDir(t);
  fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'images', 'styles.json'), JSON.stringify({
    wold: { zh: '水墨淡彩写实修仙', en: 'ink-wash xianxia', eraZh: '中国古代修仙宗门底层', eraEn: 'ancient China', avoidZh: '现代物品' },
  }));
  let directed = 0;
  const calls = [];
  images.configure(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k' }),
    { fetchImpl: freeFetch(calls), artDirector: async () => { directed += 1; return XIANXIA_ART; } });
  const st = xianxiaState('wold');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.equal(directed, 0);
  const e = Object.values(images.readIndex(dataDir))[0];
  assert.equal(e.style, '水墨淡彩写实修仙｜中国古代修仙宗门底层');
  assert.match(calls[0].body.prompt, /米白宣纸色背景，无文字，无印章/);
});

test('画风设定：已有旧图（无画风设定、key 只有画风词）的老世界沿用旧 key，不生成设定、不重画', async (t) => {
  const dataDir = tmpDir(t);
  const st = xianxiaState('wlegacy');
  const k = 'item-' + images.imageKey('item', '旧铜灯', '水墨手绘插画', 'wlegacy');
  fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'images', k + '.jpg'), JPEG);
  fs.writeFileSync(path.join(dataDir, 'images', 'index.json'), JSON.stringify({
    [k]: { kind: 'item', name: '旧铜灯', style: '水墨手绘插画', worldId: 'wlegacy', file: k + '.jpg', status: 'ready', ts: 1 },
  }));
  let directed = 0;
  const calls = [];
  images.configure(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k' }),
    { fetchImpl: freeFetch(calls), artDirector: async () => { directed += 1; return XIANXIA_ART; } });
  const list = images.imageList(dataDir, st);
  await images.waitIdle();
  assert.equal(directed, 0);
  assert.equal(calls.length, 0);
  assert.equal(list.items['旧铜灯'].status, 'ready');
});

test('画风设定：英文画风里的国画暗示词（Chinese ink-wash / Chinese painting / guohua）被替换，避免题字印章', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  images.configure(baseCfg({ IMAGE_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' }), {
    fetchImpl: cfFetch(calls),
    artDirector: async (state, messages) => {
      assert.match(messages[0].content, /不要出现 Chinese painting、Chinese ink-wash、guohua/);
      return Object.assign({}, XIANXIA_ART, { en: 'traditional Chinese ink-wash painting, guohua style' });
    },
    translate: async () => 'a bronze lamp',
  });
  const st = xianxiaState('wguohua');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  const prompt = calls[0].body.prompt;
  assert.ok(!/chinese ink|chinese painting|guohua|calligraphy|seal|rice paper/i.test(prompt), prompt);
  assert.match(prompt, /^ink and watercolor, illustration style\. a bronze lamp, ancient China, cultivation sect style,/);
});
