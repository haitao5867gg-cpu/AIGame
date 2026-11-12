'use strict';

// 游戏页「场景舞台」：静态检查 public/app.css 文本，不执行 DOM / 不请求网络。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(root, 'app.css'), 'utf8');
// 去掉注释，避免注释里的花括号干扰规则抽取
const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');

// 抽出所有「选择器 { 声明 }」规则（兼容 @media / @keyframes 内的内嵌规则块）。
function rules(text) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}
const allRules = rules(plain);

// 抽出指定 @media 块的规则体（大括号配对，兼容内嵌规则块）。
function mediaBodies(re) {
  const bodies = [];
  let m;
  while ((m = re.exec(plain)) !== null) {
    const start = re.lastIndex;
    let depth = 1, i = start;
    while (i < plain.length && depth > 0) {
      if (plain[i] === '{') depth++;
      else if (plain[i] === '}') depth--;
      i++;
    }
    bodies.push(plain.slice(start, i - 1));
  }
  return bodies.join('\n');
}
const m600 = mediaBodies(/@media\s*\(\s*max-width:\s*600px\s*\)\s*\{/g);

function brightness(rule) {
  const m = rule.body.match(/brightness\(\s*([\d.]+)\s*\)/);
  assert.ok(m, '规则应含 brightness(...)');
  return parseFloat(m[1]);
}

test('六个题材各有 body[data-genre="…"] 规则并定义四个题材色变量', () => {
  const genres = ['xuanhuan', 'urban', 'game', 'horror', 'cozy', 'general'];
  const vars = ['--g-tint', '--g-accent', '--g-accent-rgb', '--g-accent-deep'];
  for (const g of genres) {
    const sel = `body[data-genre="${g}"]`;
    const r = allRules.find((x) => x.selector === sel);
    assert.ok(r, `应有 ${sel} 规则`);
    for (const v of vars) {
      assert.match(r.body, new RegExp(`${v}\\s*:\\s*[^;]+`), `${sel} 应定义 ${v}`);
    }
  }
});

test('纸页作用域 .stage 规则；行动气泡 / 谁 / 朗读按钮三个结构规则', () => {
  assert.match(plain, /body\[data-genre\]\[data-read="paper"\] \.stage\s*[,{]/,
    '应有 body[data-genre][data-read="paper"] .stage 规则');
  assert.match(plain, /\.action-bubble\s*\{/, '应有 .action-bubble 规则');
  assert.match(plain, /\.action-who\s*\{/, '应有 .action-who 规则');
  assert.match(plain, /\.action-line \.tts-turn-head\s*\{/, '应有 .action-line .tts-turn-head 规则');
});

test('底图 brightness 数值比较：夜色 ≥ 0.55，默认 ≥ 0.9', () => {
  const def = allRules.find((r) => r.selector === '.world-backdrop' && /brightness\(/.test(r.body));
  assert.ok(def, '应找到默认 .world-backdrop 的 brightness 规则');
  assert.ok(brightness(def) >= 0.9, `默认 brightness ${brightness(def)} 应 ≥ 0.9`);

  // 桌面默认 + 手机时辰两条 night 规则都要 ≥ 0.55
  const night = allRules.filter((r) =>
    r.selector.split(',').some((s) => s.trim().endsWith('.world-backdrop[data-period="night"]')) &&
    /brightness\(/.test(r.body));
  assert.ok(night.length > 0, '应找到 .world-backdrop[data-period="night"] 规则');
  for (const r of night) {
    assert.ok(brightness(r) >= 0.55, `夜色 brightness ${brightness(r)} 应 ≥ 0.55`);
  }
});

test('写死黑底的旧 atmosphere-background 规则已删除', () => {
  assert.equal(css.includes('atmosphere-background .stage{background:rgba(20,19,15'), false,
    '不再有 atmosphere-background .stage{background:rgba(20,19,15 旧规则');
  assert.equal(css.includes('atmosphere-background .g-subtitle{background:rgba(20,19,15'), false,
    '手机端旧黑底 subtitle 规则已删');
  assert.equal(css.includes('atmosphere-background .panel{background:var(--panel)}'), false,
    '手机端旧面板规则已删');
  assert.equal(css.includes('brightness(.28)'), false, '旧夜色 filter 已删');
  assert.equal(css.includes('linear-gradient(180deg,rgba(9,14,17,.08)'), false, '旧底图渐变已删');
});

test('手机媒体查询里 body[data-genre] .stage 不使用 backdrop-filter（值为 none）', () => {
  assert.ok(m600.length > 0, '应能抽出 ≤600px 规则体');
  const stageRules = rules(m600).filter((r) => r.selector.includes('body[data-genre] .stage'));
  assert.ok(stageRules.length > 0, '手机段应有 body[data-genre] .stage 规则');
  for (const r of stageRules) {
    assert.match(r.body, /backdrop-filter:\s*none/, 'backdrop-filter 应为 none');
    assert.doesNotMatch(r.body, /backdrop-filter:\s*blur/, '不应使用 blur 的 backdrop-filter');
  }
});

test('HANDOFF 第 6 节不倒退：手机整页滚动 / 16px 输入 / 朗读按钮 40px / 顶栏单行；电脑插图在右栏顶部', () => {
  assert.match(m600, /\.stream\s*\{[^}]*max-height\s*:\s*none/, '.stream 仍整页滚动（max-height:none）');
  assert.match(m600, /\.stream\s*\{[^}]*overflow\s*:\s*visible/, '.stream 仍 overflow:visible');
  assert.match(m600, /#action-input[^{]*\{[^}]*font-size\s*:\s*16px/, '#action-input 仍 16px');
  assert.match(m600, /\.tts-read-btn[^{]*\{[^}]*min-height\s*:\s*40px/, '朗读按钮仍 ≥40px');
  assert.match(m600, /\.game-head\s*\{[^}]*position\s*:\s*sticky/, '顶栏仍 sticky');
  assert.match(m600, /\.game-head\s*\{[^}]*flex-wrap\s*:\s*nowrap/, '顶栏仍单行');
  assert.doesNotMatch(css, /#scene-rail\{[^}]*position:sticky/, '电脑当前插图不再 sticky，跟随右面板滚动');
});

test('新段落并入文件末尾，且保留 ::after 结构、纸页漏网覆盖只作用于纸页', () => {
  assert.match(css, /\/\* ===== 游戏页「场景舞台」：题材色调 \+ 世界底图 \+ 玻璃阅读面 ===== \*\//,
    '段首注释正确');
  assert.ok(css.indexOf('/* ===== 游戏页「场景舞台」') > css.indexOf('.timeskip-buttons .btn'),
    '新段落在文件末尾（旧规则之后）');
  assert.match(css, /\.world-backdrop::after\{content:'';position:absolute;inset:0\}/,
    '保留 ::after 的 content/position/inset 结构');
  assert.match(css, /body\[data-genre\]\[data-read="paper"\] \.img-fallback\{[^}]*color:#5b4326/,
    '纸页漏网覆盖：.img-fallback 改浅底深字');
  assert.equal(/body\[data-genre\] \.img-fallback\{[^}]*color:#5b4326/.test(css), false,
    '夜色模式的 .img-fallback 仍是浅字深底，未被改动');
});
