'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
const jsFiles = fs.readdirSync(path.join(root, 'js'))
  .filter((f) => f.endsWith('.js'))
  .sort();
// 拼接后的整页文本（含 index.html / app.css / 所有 public/js），与 frontend.test.js 同法。
const html = [
  fs.readFileSync(path.join(root, 'index.html'), 'utf8'),
  '<style>\n' + fs.readFileSync(path.join(root, 'app.css'), 'utf8') + '\n</style>',
  ...jsFiles.map((f) => '<script>\n' + fs.readFileSync(path.join(root, 'js', f), 'utf8') + '\n</script>'),
].join('\n');
// 仅 public/js，用于检查是否新增 innerHTML。
const js = jsFiles.map((f) => fs.readFileSync(path.join(root, 'js', f), 'utf8')).join('\n');

test('场景插图：样式含 .scene-frame / .scene-img 且 aspect-ratio:16/9', () => {
  assert.ok(/\.scene-frame\{/.test(html), '应有 .scene-frame 样式');
  assert.ok(/\.scene-img\{/.test(html), '应有 .scene-img 样式');
  assert.ok(/aspect-ratio:16\/9/.test(html), '应为 16:9 宽高比');
  assert.ok(/\.scene-img\.loaded\{opacity:1\}/.test(html), 'load 后淡入到 opacity:1');
  assert.ok(/transition:opacity \.6s/.test(html), '淡入过渡 0.6s');
  assert.ok(/object-fit:cover/.test(html), '图片裁切填充不撑破框');
});

test('场景插图：appendNarration 支持 sceneId，renderResult / appendLogRecord 按 scene 决定 sceneId', () => {
  // appendNarration 第三参数 sceneId：有则在叙事块最上面建 .scene-frame（data-scene + 闪烁占位），无则不建框
  assert.ok(/function appendNarration\(text, badges, sceneId\)/.test(html), 'appendNarration 应支持 sceneId');
  assert.ok(/if \(sceneId\)/.test(html), '无 sceneId 不显示任何框');
  assert.ok(/scene-frame img-pending/.test(html), '初始复用 img-pending 闪烁占位');
  assert.ok(/setAttribute\('data-scene', sceneId\)/.test(html), '框应带 data-scene');
  // renderResult：res.scene.draw && res.sceneKey 时才用 res.state.life-turn 拼 sceneId 并传入
  assert.ok(/res\.scene && res\.scene\.draw && res\.sceneKey/.test(html), 'renderResult 用 scene.draw 与 sceneKey 判定');
  assert.ok(/res\.state\.life \+ '-' \+ res\.state\.turn/.test(html), 'sceneId 由 life-turn 拼出');
  assert.ok(/appendNarration\(res\.narration, badgesFromApplied\(res\.applied\), sceneId\)/.test(html),
    'renderResult 把 sceneId 传给 appendNarration');
  // appendLogRecord：rec.scene.draw 时用 rec.life-rec.turn
  assert.ok(/rec\.scene && rec\.scene\.draw/.test(html), 'appendLogRecord 用 rec.scene');
  assert.ok(/rec\.life \+ '-' \+ rec\.turn/.test(html), '回放 sceneId 由 rec.life-rec.turn 拼出');
});

test('场景插图：renderScenes 存在并被 renderImages 调用；hasPendingImage 考虑 scenes；轮询上限 150000', () => {
  assert.ok(/function renderScenes/.test(html), '应有 renderScenes');
  assert.ok(/function renderImages\(\)[\s\S]*?renderScenes\(\)/.test(html), 'renderImages 末尾调用 renderScenes');
  assert.ok(/data\.scenes \|\| \{\}/.test(html), 'fetchImages 存 data.scenes');
  assert.ok(/scenes: \{\}/.test(html), 'imageState 含 scenes');
  // renderScenes：按 data-scene 查表，ready 填图 / pending 占位 / failed、none 隐藏 / 不重建同 url
  assert.ok(/getAttribute\('data-scene'\)/.test(html), '按 data-scene 查 scenes');
  assert.ok(/!info \|\| info\.status === 'pending'/.test(html), 'pending 保持占位');
  assert.ok(/info\.status !== 'ready' \|\| !info\.url/.test(html), 'failed/none 隐藏');
  assert.ok(/frame\.hidden = true/.test(html), '整框 hidden 不占位');
  assert.ok(/if \(existing && existing\.getAttribute\('data-scene-url'\) === info\.url\) return/.test(html),
    '已放过同一 url 不重复创建');
  assert.ok(/el\('img', 'scene-img'\)/.test(html), 'ready 放 img.scene-img');
  assert.ok(/img\.classList\.add\('loaded'\)/.test(html), 'load 后加 class 淡入');
  assert.ok(/openImageViewer\(info\.url\)/.test(html), '点击看大图');
  // hasPendingImage 计入 scenes.pending 及页面尚无对应项的 .scene-frame
  const i = html.indexOf('function hasPendingImage');
  const j = html.indexOf('async function fetchImages');
  assert.ok(i >= 0 && j > i, '应能定位 hasPendingImage');
  const hp = html.slice(i, j);
  assert.ok(/st\.scenes \|\| \{\}/.test(hp), 'hasPendingImage 应读 st.scenes');
  assert.ok(/querySelectorAll\('\.scene-frame'\)/.test(hp), '页面上尚无对应项也按 pending');
  // 轮询上限从 90 秒放宽到 150000ms
  assert.ok(/Date\.now\(\) - imagePollStart >= 150000/.test(html), '轮询上限 150000ms');
});

test('场景插图：用量面板含「场景插图」开关并 POST /api/prefs', () => {
  assert.ok(/场景插图/.test(html), '面板应有「场景插图」标题');
  assert.ok(/关键回合配插图/.test(html), '应有 checkbox 说明文字');
  assert.ok(/sceneCb\.type = 'checkbox'/.test(html), '应有 checkbox');
  assert.ok(/sceneCb\.checked = !!myPrefs\.scenes/.test(html), '初始值来自 myPrefs');
  assert.ok(/api\('\/api\/prefs'[\s\S]*?method: 'POST'/.test(html), 'POST /api/prefs');
  assert.ok(/JSON\.stringify\(\{ scenes: wanted \}\)/.test(html), 'POST 体含 scenes');
  assert.ok(/myPrefs\.scenes = on/.test(html), '成功后更新 myPrefs');
  assert.ok(/toast\(on \? '已开启场景插图' : '已关闭场景插图'\)/.test(html), '成功 toast 开关文案');
  assert.ok(/sceneCb\.checked = !wanted/.test(html), '失败还原 checkbox');
  assert.ok(/me\.prefs\.scenes/.test(html), 'renderPlayerInfo 存 /api/me 的 prefs.scenes');
  assert.ok(/var myPrefs = \{ scenes: true \}/.test(html), 'core 共享变量 myPrefs');
});

test('场景插图：public/js 未新增 innerHTML', () => {
  assert.equal(/\.innerHTML/.test(js), false, 'public/js 不得出现 .innerHTML 拼接');
  assert.ok(/\.textContent\s*=/.test(js), '应使用 textContent 渲染内容');
});
