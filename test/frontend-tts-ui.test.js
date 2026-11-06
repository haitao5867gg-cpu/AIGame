'use strict';

// 朗读设置两处界面的静态检查：只读源文件文本，不执行 DOM / 不请求网络。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

const ttsJs = read('js/tts.js');
const imagesJs = read('js/images.js');

test('音色 option 显示名：中文友好名 +（性别·年龄），不再拼接 voice id', () => {
  assert.ok(/el\('option',\s*null,\s*voiceLabel\(v\)\)/.test(ttsJs), 'option 文案走 voiceLabel');
  assert.ok(!ttsJs.includes("' · ' + v.id"), '不再拼接 (name) · (id)');
  assert.ok(/o\.value\s*=\s*v\.id/.test(ttsJs), 'option 的 value 仍是 voice id');
  // 性别 / 年龄映射与全角括号
  assert.ok(/m:\s*'男'/.test(ttsJs) && /f:\s*'女'/.test(ttsJs), 'm/f → 男/女');
  assert.ok(/child:\s*'童声'/.test(ttsJs) && /young:\s*'青年'/.test(ttsJs), 'child/young → 童声/青年');
  assert.ok(/adult:\s*'成年'/.test(ttsJs) && /old:\s*'老年'/.test(ttsJs), 'adult/old → 成年/老年');
  assert.ok(ttsJs.includes('（'), '使用全角括号（');
  assert.ok(/\.join\('·'\)/.test(ttsJs), '性别与年龄用 · 连接');
});

test('renderNpcList：追加喇叭按钮、写 npcVoices、调用 /api/prefs', () => {
  const start = imagesJs.indexOf('function renderNpcList');
  const end = imagesJs.indexOf('function renderHero');
  assert.ok(start >= 0 && end > start, '能定位 renderNpcList');
  const body = imagesJs.slice(start, end);
  assert.ok(body.includes('🔊'), '每行有小喇叭按钮');
  assert.ok(/自动（按名字分配）/.test(body), '下拉首项为「自动（按名字分配）」');
  assert.ok(body.includes('voiceLabel'), '复用第 1 条的显示名');
  assert.ok(/npcVoices/.test(body), '写入 myPrefs.tts.npcVoices');
  assert.ok(/\/api\/prefs/.test(body), 'POST /api/prefs 保存');
  assert.ok(/previewVoice/.test(body), '选中后立即试读');
  // 现有结构与类名保持不变
  assert.ok(/el\('div',\s*'npc-row'\)/.test(body), '保留 .npc-row');
  assert.ok(/el\('span',\s*'npc-name'/.test(body), '保留 .npc-name');
  assert.ok(/el\('span',\s*'npc-attitude'/.test(body), '保留 .npc-attitude');
});

test('public/js 无新增 innerHTML', () => {
  const files = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    assert.ok(!/\.innerHTML/.test(read('js/' + f)), f + ' 不得出现 .innerHTML');
  }
});
