'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// 从标记之间抽出纯分段函数（不依赖 DOM），在 Node 里直接验证分段行为。
function narrationHelpers() {
  const start = '/* NARRATION_HELPERS_START */';
  const end = '/* NARRATION_HELPERS_END */';
  const i = html.indexOf(start);
  const j = html.indexOf(end);
  assert.ok(i >= 0 && j > i, '应存在 NARRATION_HELPERS 标记');
  const src = html.slice(i + start.length, j);
  return new Function(src + '\nreturn { splitNarration, splitByBlankLines };')();
}

// 抽出属性说明卡的纯开关逻辑（不依赖 DOM），在 Node 里直接验证弹卡/关闭行为。
function attrTipHelpers() {
  const start = '/* ATTR_TIP_HELPERS_START */';
  const end = '/* ATTR_TIP_HELPERS_END */';
  const i = html.indexOf(start);
  const j = html.indexOf(end);
  assert.ok(i >= 0 && j > i, '应存在 ATTR_TIP_HELPERS 标记');
  const src = html.slice(i + start.length, j);
  return new Function(src + '\nreturn { attrTipAction };')();
}

// 抽出撤回二次确认的纯状态机（不依赖 DOM）。
function undoHelpers() {
  const start = '/* UNDO_HELPERS_START */';
  const end = '/* UNDO_HELPERS_END */';
  const i = html.indexOf(start);
  const j = html.indexOf(end);
  assert.ok(i >= 0 && j > i, '应存在 UNDO_HELPERS 标记');
  const src = html.slice(i + start.length, j);
  return new Function(src + '\nreturn { undoClickAction };')();
}

test('前端：内联脚本语法合法（仅编译，不执行 DOM）', () => {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, '应存在内联 <script>');
  assert.doesNotThrow(() => new vm.Script(m[1]));
});

test('前端：无外部 http(s) 脚本/样式引用（单文件、无 CDN）', () => {
  assert.equal(/<script[^>]*\bsrc\s*=\s*["']\s*https?:\/\//i.test(html), false, '不应引用外部脚本');
  assert.equal(/<link[^>]*\bhref\s*=\s*["']\s*https?:\/\//i.test(html), false, '不应引用外部样式');
  assert.equal(/@import[^;]*https?:\/\//i.test(html), false, '不应 @import 外部样式');
  assert.equal(/url\(\s*["']?\s*https?:\/\//i.test(html), false, 'CSS 不应引用外部 URL');
  // 兜底：任何 src/href 属性都不得指向外部地址
  const refs = html.match(/\b(?:src|href)\s*=\s*["'][^"']*["']/gi) || [];
  for (const ref of refs) {
    assert.equal(/https?:\/\//i.test(ref), false, `引用不得为外部地址：${ref}`);
  }
  // 内联 <script>/<style> 都在，只调用自家 /api/*
  assert.ok(/<script>/.test(html));
  assert.ok(/<style>/.test(html));
  assert.ok(/\/api\/worlds/.test(html));
});

test('前端：不用 innerHTML 拼接用户内容（仅允许静态模板）', () => {
  // 找出所有 .innerHTML = ... 赋值：静态字符串模板允许，
  // 但凡出现 + 拼接或 ${} 模板插值（会混入用户内容）一律判失败。
  const assigns = html.match(/\.innerHTML\s*=\s*[^;]+/g) || [];
  for (const a of assigns) {
    assert.equal(/\+/.test(a), false, `innerHTML 不得用 + 拼接：${a.slice(0, 70)}`);
    assert.equal(/\$\{/.test(a), false, `innerHTML 不得用模板插值：${a.slice(0, 70)}`);
  }
  // 防御注入：用户内容一律走 textContent
  assert.equal(/\.textContent\s*=/.test(html), true, '应使用 textContent 渲染用户内容');
  assert.ok(/createElement\(/.test(html));
});

test('前端：包含三个视图与 /rebirth 调用', () => {
  assert.equal(/id=["']view-home["']/.test(html), true, '应有首页视图');
  assert.equal(/id=["']view-new["']/.test(html), true, '应有新世界视图');
  assert.equal(/id=["']view-game["']/.test(html), true, '应有游戏页视图');
  // hash 路由三个入口
  assert.ok(/#\/new/.test(html));
  assert.ok(/#\/w\//.test(html));
  assert.ok(/#\//.test(html));
  // 进入游戏页恢复叙事：GET log
  assert.ok(/\/log\?limit=50/.test(html), '应请求 /log 恢复叙事');
  // 重生接口调用
  assert.ok(/\/rebirth/.test(html), '应调用 /rebirth');
  // 只调用自家 /api/*，不得出现 Key 字样
  assert.equal(/LLM_API_KEY|API_KEY/.test(html), false, '前端不得出现 Key');
});

test('前端：风声渐紧预兆标签', () => {
  assert.ok(/id=["']g-omen["']/.test(html), '应有预兆标签元素');
  assert.ok(/风声渐紧/.test(html), '应显示「风声渐紧」文案');
  assert.ok(/omen-tag/.test(html), '应有预兆标签样式');
});

test('前端：坊间传闻区（最新在上）', () => {
  assert.ok(/坊间传闻/.test(html), '应有坊间传闻区');
  assert.ok(/rumor-item/.test(html), '应有传闻条目样式');
  assert.ok(/rumors\.slice\(\)\.reverse\(\)/.test(html), '传闻应最新在上');
});

test('前端：顶部显示「地点 · 第N日 时段」', () => {
  assert.ok(/id=["']g-place["']/.test(html), '应有一处显示地点与时间');
  assert.ok(/· 第/.test(html), '应拼出「地点 · 第N日 时段」');
  assert.ok(/s\.clock/.test(html), '应读取 clock 渲染');
});

test('前端：重生「新一世开场」在 doRebirth 与 log 回放时都按开场样式显示', () => {
  assert.ok(/s\.rebirthOpening/.test(html), '重生响应应带 rebirthOpening');
  assert.ok(/rec\.rebirthOpening/.test(html), 'log 回放应识别 rebirthOpening 标记');
  assert.ok(/appendOpening\(rec\.narration\)/.test(html), '回放时按开场样式渲染');
  assert.ok(/appendOpening\(s\.rebirthOpening/.test(html), '重生后立即显示开场');
});

test('前端：濒死可感知（顶部「伤势沉重」、体魄条变红闪烁、死亡遮罩写明死因）', () => {
  assert.ok(/id=["']g-danger["']/.test(html), '应有伤势沉重标签元素');
  assert.ok(/伤势沉重/.test(html));
  assert.ok(/danger-tag/.test(html));
  assert.ok(/s\.danger/.test(html), 'renderHeader 应读取 danger');
  assert.ok(/isDanger\(/.test(html), '应有濒死判定');
  assert.ok(/\.attr-fill\.danger\{/.test(html), '体魄条变红样式');
  assert.ok(/@keyframes dangerFlash/.test(html), '应闪烁');
  assert.ok(/attr-fill danger/.test(html), '体魄 fill 应用 danger 类');
  assert.ok(/top-chip danger-chip/.test(html));
  assert.ok(/death-cause/.test(html), '死亡遮罩应有死因样式');
  assert.ok(/死因 · /.test(html));
  assert.ok(/death\.reason/.test(html), '应从回合结果取死因');
});

test('前端：死亡遮罩显示墓志铭、侧面板「前世」区', () => {
  assert.ok(/前世/.test(html), '侧面板应有前世区');
  assert.ok(/pastLives/.test(html), '应读取 pastLives');
  assert.ok(/last\.epitaph/.test(html), '死亡遮罩应显示墓志铭');
  assert.ok(/past-life-item/.test(html), '应有前世条目样式');
});

test('前端：侧面板「身上的印记」「未解之谜」「已知的事」三区', () => {
  assert.ok(/身上的印记/.test(html), '应有印记区');
  assert.ok(/未解之谜/.test(html), '应有未解之谜区');
  assert.ok(/已知的事/.test(html), '应有已知的事区');
  assert.ok(/character && s\.character\.marks/.test(html), '应读取 character.marks');
  assert.ok(/s\.threads/.test(html), '应读取 threads');
  assert.ok(/s\.facts/.test(html), '应读取 facts');
  assert.ok(/mark-chip/.test(html), '应有印记条目样式');
  assert.ok(/thread-item/.test(html), '应有线索条目样式');
  assert.ok(/fact-item/.test(html), '应有事实条目样式');
  assert.ok(/collapsible\('已知的事'/.test(html), '「已知的事」应为默认折叠的 details');
});

test('前端：等待回应时显示已等待秒数', () => {
  assert.ok(/id=["']pending-secs["']/.test(html), '应有秒数占位元素');
  assert.ok(/世界在回应…/.test(html));
  assert.ok(/已等待/.test(html));
  assert.ok(/Date\.now\(\) - pendingStart/.test(html), '应按起始时间计算秒数');
  assert.ok(/setInterval\(updatePendingSecs, 1000\)/.test(html), '应每秒刷新');
  assert.ok(/clearInterval\(pendingTimer\)/.test(html), '结束时应清理计时器');
});

test('前端：首页玩法简介（无世界醒目 / 有世界在列表下方小字）', () => {
  assert.ok(/id=["']home-intro["']/.test(html), '应有玩法简介元素');
  // 简介文案覆盖玩法要点
  assert.ok(/一句话/.test(html), '一句话开世界');
  assert.ok(/自由输入/.test(html), '自由输入行动');
  assert.ok(/没有任务/.test(html) && /没有结局/.test(html), '没有任务没有结局');
  assert.ok(/死亡只是一世/.test(html), '死亡只是一世结束');
  assert.ok(/记得你/.test(html), '世界会记得你');
  // 未在列表下方用小字，无世界时用大字
  assert.ok(/HOME_INTRO/.test(html));
  assert.ok(/home-intro small/.test(html) && /home-intro big/.test(html));
  assert.ok(/\.home-intro\.small\{[^}]*font-size:12px/.test(html), '有世界时用小字');
  assert.ok(/intro\.className = list\.length \? 'home-intro small' : 'home-intro big'/.test(html),
    '按是否有世界切换小字/大字');
  // 简介元素位于 world-list 之后（列表下方）
  assert.ok(html.indexOf('id="home-intro"') > html.indexOf('id="world-list"'));
});

test('前端：行动改走 fetch 流式读取并自解析 SSE，失败自动回退普通 /turn', () => {
  // 流式回合：POST /turn/stream，用 fetch 而非 EventSource（POST 不支持 EventSource）
  assert.ok(/\/turn\/stream/.test(html), '应请求 /turn/stream');
  assert.ok(/fetch\('\/api\/worlds\/'/.test(html), '应用 fetch 发起流式请求');
  assert.ok(/method: 'POST'/.test(html), '应为 POST');
  assert.equal(/new EventSource\(/.test(html), false, 'POST 不能用 EventSource');
  // 手动解析 SSE：按字节读、UTF-8 流式解码、识别 event/data 行
  assert.ok(/res\.body\.getReader\(\)/.test(html), '应用 getReader 读取流');
  assert.ok(/new TextDecoder\('utf-8'\)/.test(html), '应用 UTF-8 解码器');
  assert.ok(/stream: true/.test(html), '解码需 stream 模式以处理多字节中文');
  assert.ok(/field === 'event'/.test(html) && /field === 'data'/.test(html), '应解析 SSE 的 event/data 字段');
  // 三类事件：delta 边到边追加、result 结尾渲染、error 触发回退
  assert.ok(/event === 'delta'/.test(html), '应处理 delta');
  assert.ok(/event === 'result'/.test(html), '应处理 result');
  assert.ok(/event === 'error'/.test(html), '应处理 error');
  assert.ok(/appendStreamDelta\(/.test(html), 'delta 应边到边显示叙事');
  assert.ok(/renderResult\(res\)/.test(html), 'result 应统一渲染徽章/建议/事件/结算');
  // 去掉打字机效果
  assert.equal(/typewrite|\btyper\b/.test(html), false, '流式显示不应再依赖打字机');
  // 流式失败自动回退普通 /turn
  assert.ok(/\/turn', \{/.test(html), '应保留普通 /turn 回退');
  assert.ok(/renderResult\(fb\)/.test(html), '回退结果同样走统一渲染');
});

test('前端：世界卡片与游戏页都有「导出」按钮，走 /export 附件下载', () => {
  assert.ok(/id="btn-export"/.test(html), '游戏页应有导出按钮');
  assert.ok(/function exportWorld\(/.test(html), '应有 exportWorld 下载函数');
  assert.ok(/\/export'/.test(html), '应请求 /export 接口');
  assert.ok(/a\.download =/.test(html), '应用 <a download> 触发下载');
  assert.ok(/exportWorld\(w\.id\)/.test(html), '世界卡片应能导出');
  assert.ok(/exportWorld\(currentWorldId\)/.test(html), '游戏页应能导出当前世界');
});

test('前端叙事分段：按 \\n\\n 分成多段、旧长段落按句末标点每约 80 字自动切段', () => {
  const h = narrationHelpers();
  // 新叙事：多段（含对话单独成段），空行两端空白被清理
  assert.deepEqual(h.splitNarration('甲段落。\n\n  乙段落。 \n\n「丙对白」'),
    ['甲段落。', '乙段落。', '「丙对白」']);
  // 短文本 / 空文本不强行切段
  assert.deepEqual(h.splitNarration('一句话的短叙事。'), ['一句话的短叙事。']);
  assert.deepEqual(h.splitNarration(''), []);
  // 旧存档：无分段的一整段长文本，按句末标点每约 80 字切成多段
  const long = '你走进雾里，钟声更近了。守夜人抬眼看了你一眼，没有说话。'.repeat(4);
  const parts = h.splitNarration(long);
  assert.ok(parts.length >= 2, '长单段应自动切成多段');
  parts.forEach((p) => assert.ok(p.length <= 90, `每段不应过长：${p.length}`));
  assert.equal(parts.join(''), long, '切段不应丢字或改字');
  // 无标点超长单段也要按约 80 字硬切
  const noPunct = '啊'.repeat(200);
  const hard = h.splitNarration(noPunct);
  assert.ok(hard.length >= 2 && hard.join('') === noPunct, '无标点长段也要硬切');
});

test('前端叙事分段：流式按空行实时拆分（含 \\n\\n 跨 delta 到达）', () => {
  const h = narrationHelpers();
  assert.deepEqual(h.splitByBlankLines('甲\n\n乙\n\n丙'), ['甲', '乙', '丙']);
  assert.deepEqual(h.splitByBlankLines('甲\n'), ['甲'], '单个换行不分段');
  assert.deepEqual(h.splitByBlankLines('甲\n\n'), ['甲'], '结尾空行不产生空段');
  assert.deepEqual(h.splitByBlankLines(''), []);
});

test('前端叙事分段：渲染按段落生成多个 <p>、段间距加大、行高 1.9、流式实时分段', () => {
  // appendNarration 用 splitNarration 循环创建多个 <p class="narration">
  assert.ok(/splitNarration\(text\)\.forEach/.test(html), '完整叙事应按段落循环渲染');
  assert.ok(/wrap\.appendChild\(el\('p', 'narration', para\)\)/.test(html), '每段生成独立 <p>');
  // 流式：delta 累积后按空行实时重排多个 <p>
  assert.ok(/block\.text \+= text/.test(html), '流式应累积叙事文本');
  assert.ok(/splitByBlankLines\(block\.text\)/.test(html), '流式应按空行实时分段');
  assert.ok(/renderParagraphs\(block\.wrap/.test(html), '流式应实时重排 <p>');
  assert.ok(/function renderParagraphs/.test(html));
  // CSS：行高 1.9、段间距加大
  assert.ok(/\.narration\{[^}]*line-height:1\.9/.test(html), '行高应为 1.9');
  assert.ok(/\.narration\{[^}]*margin:0 0/.test(html), '段间距应加大');
});

test('前端属性说明卡：六项属性说明与「属性上限 40，越高越难提升」齐全', () => {
  assert.ok(/id=["']attr-tip["']/.test(html), '应有说明卡容器');
  assert.ok(/ATTR_INFO/.test(html), '应有属性说明映射');
  const pairs = [
    ['体魄', '身体与伤势，归零即本世终结'],
    ['心智', '洞察、学识、识破谎言'],
    ['魅力', '说服、结交、让人信任'],
    ['气运', '巧合与机缘，影响事件结算的运气'],
    ['声望', '世人眼中的你，影响 NPC 态度和隐藏机会'],
    ['资源', '钱财物资与人脉可调动的东西'],
  ];
  pairs.forEach(([k, v]) => {
    const re = new RegExp("'" + k + "'\\s*:\\s*'" + v + "'");
    assert.ok(re.test(html), `应有 ${k}＝${v} 的精确文案`);
  });
  assert.ok(/属性上限 40，越高越难提升/.test(html), '应说明属性上限 40');
  assert.ok(/ATTR_TIP_FOOTER/.test(html) && /attr-tip-foot/.test(html), '页脚文案与样式应齐全');
});

test('前端属性说明卡：再点同一项/点空白关闭、点不同项切换（纯逻辑）', () => {
  const h = attrTipHelpers();
  // 未打开时点任一属性 → 显示
  assert.equal(h.attrTipAction(null, '心智'), 'show');
  assert.equal(h.attrTipAction(undefined, '体魄'), 'show');
  // 再点同一属性 → 关闭
  assert.equal(h.attrTipAction('心智', '心智'), 'hide');
  // 点另一属性 → 切换显示
  assert.equal(h.attrTipAction('心智', '魅力'), 'show');
  // 点空白（无属性名）：已打开→关闭；未打开→不变
  assert.equal(h.attrTipAction('心智', null), 'hide');
  assert.equal(h.attrTipAction('心智', ''), 'hide');
  assert.equal(h.attrTipAction(null, null), null);
});

test('前端属性说明卡：顶部属性条与侧面板都标注 data-attr，全局点击处理弹卡/点空白关闭', () => {
  // 两处渲染都设置 data-attr（顶部属性条 + 侧面板属性行）
  assert.ok(/chip\.setAttribute\('data-attr', a\)/.test(html), '顶部属性条应设 data-attr');
  assert.ok(/row\.setAttribute\('data-attr', a\)/.test(html), '侧面板属性行应设 data-attr');
  assert.ok(/\.top-chip\[data-attr\],\.attr-row\[data-attr\]\{cursor:pointer\}/.test(html),
    '可点区域应有 pointer 光标');
  // 全局 click 监听（手机轻点也触发 click，故一并覆盖 tap）
  assert.ok(/document\.addEventListener\('click', onDocumentClick\)/.test(html), '应有全局点击监听');
  assert.ok(/function onDocumentClick/.test(html));
  assert.ok(/closestAttr\(e\.target\)/.test(html), '应由点击目标向上找 data-attr');
  assert.ok(/tip\.contains\(e\.target\)/.test(html), '点卡片内部应保持打开');
  assert.ok(/attrTipAction\(attrTipOpen, null\)/.test(html), '点空白走关闭判定');
  // 说明卡显示/隐藏与文案渲染、切换视图时收起
  assert.ok(/function showAttrTip/.test(html) && /function hideAttrTip/.test(html));
  assert.ok(/attr-tip-name/.test(html) && /attr-tip-desc/.test(html) && /attr-tip-foot/.test(html));
  assert.ok(/function hideAllViews\(\)[\s\S]*?hideAttrTip\(\)/.test(html), '切换视图应收起说明卡');
});

test('前端撤回：二次确认状态机（第一次进入确认、第二次才发起 /undo）', () => {
  const h = undoHelpers();
  assert.deepEqual(h.undoClickAction(false), { nextArmed: true, fire: false });
  assert.deepEqual(h.undoClickAction(true), { nextArmed: false, fire: true });
});

test('前端撤回：最后一段叙事下方有「↶ 撤回这一步」，二次确认后调用 /undo、重载世界、行动回填', () => {
  assert.ok(/id=["']btn-undo["']/.test(html), '应有撤回按钮');
  assert.ok(/↶ 撤回这一步/.test(html));
  // 位置：stream（叙事）之后、composer 之前，即最后一段叙事下方
  assert.ok(html.indexOf('id="btn-undo"') > html.indexOf('id="stream"'));
  assert.ok(html.indexOf('id="btn-undo"') < html.indexOf('class="composer"'));
  // 二次确认
  assert.ok(/undoArmed/.test(html), '应有 armed 确认态');
  assert.ok(/确认撤回这一步？/.test(html), '第一次点击应进入确认态');
  assert.ok(/setTimeout\(resetUndoText, 4000\)/.test(html), '确认态应超时自动复原');
  assert.ok(/\$\('btn-undo'\)\.addEventListener\('click', onUndoClick\)/.test(html), '应绑定点击');
  // 调用 /undo（POST），成功后重载该世界叙事与状态、把被撤回行动放回输入框
  assert.ok(/\/undo'\s*,\s*\{/.test(html), '应调用 /undo');
  assert.ok(/await showGame\(currentWorldId\)/.test(html), '成功后应重新加载该世界叙事与状态');
  assert.ok(/\$\('action-input'\)\.value = res\.undoneAction \|\| ''/.test(html),
    '应把被撤回的行动文字放回输入框');
  assert.ok(/setUndoVisible\(!!(?:state|res\.state)\.undoAvailable\)/.test(html),
    '应按后端 undoAvailable 显隐按钮');
});

test('前端：随身物品卡片网格与 NPC 头像（图片 / 占位 / 首字 / 点击大图）', () => {
  // 物品卡片：64px 方图（圆角、object-fit:cover）在上，名字在下
  assert.ok(/item-grid/.test(html), '应有物品卡片网格容器');
  assert.ok(/item-card/.test(html), '应有物品卡片');
  assert.ok(/\.item-thumb\{[^}]*width:64px/.test(html), '物品图宽 64px');
  assert.ok(/\.item-thumb\{[^}]*height:64px/.test(html), '物品图高 64px');
  assert.ok(/\.item-thumb\{[^}]*object-fit:cover/.test(html), '物品图 object-fit:cover');
  assert.ok(/\.item-thumb\{[^}]*border-radius:10px/.test(html), '物品图圆角');
  // NPC：每行前 40px 圆形头像
  assert.ok(/npc-avatar/.test(html), '应有 NPC 头像');
  assert.ok(/\.npc-avatar\{[^}]*width:40px/.test(html), 'NPC 头像宽 40px');
  assert.ok(/\.npc-avatar\{[^}]*border-radius:50%/.test(html), 'NPC 头像圆形');
  // pending 柔和闪烁占位；failed / 无图 → 首字圆角色块
  assert.ok(/img-pending/.test(html), 'pending 应有占位');
  assert.ok(/@keyframes imgShimmer/.test(html), 'pending 应闪烁');
  assert.ok(/img-fallback/.test(html), 'failed / 无图应有首字色块');
  assert.ok(/firstChar\(/.test(html), '应有取首字逻辑');
  // 点击图片/头像弹出大图，再点关闭
  assert.ok(/id=["']image-viewer["']/.test(html), '应有大图查看器元素');
  assert.ok(/openImageViewer\(/.test(html), '点击应打开大图');
  assert.ok(/closeImageViewer/.test(html), '再点应关闭大图');
  // 渲染函数
  assert.ok(/function makeImageVisual/.test(html), '应有图位渲染函数');
  assert.ok(/function renderItemGrid/.test(html), '应有物品卡片渲染');
  assert.ok(/function renderNpcList/.test(html), '应有 NPC 头像渲染');
  assert.ok(/function renderImages/.test(html), '应有统一重渲染');
  // 375px 不横向溢出：自适应网格 + 长名换行 + 大图限宽
  assert.ok(/minmax\(72px,1fr\)/.test(html), '卡片网格自适应不溢出');
  assert.ok(/word-break:break-all/.test(html), '长名字不撑破布局');
  assert.ok(/max-width:90vw/.test(html), '大图不超出手机宽度');
});

test('前端：进入世界/回合结果后请求 /images，pending 每 4 秒轮询最多 90 秒', () => {
  assert.ok(/\/images'/.test(html), '应请求 /images 接口');
  assert.ok(/function requestImages/.test(html), '应有请求入口');
  assert.ok(/}, 4000\)/.test(html), 'pending 时每 4 秒轮询');
  assert.ok(/90000/.test(html), '轮询最多 90 秒');
  assert.ok(/hasPendingImage/.test(html), '按 pending 判定');
  assert.ok(/async function showGame[\s\S]*?requestImages\(\)/.test(html), '进入世界应请求一次');
  assert.ok(/function renderResult[\s\S]*?requestImages\(\)/.test(html), '回合结果后应请求一次');
  assert.ok(/stopImagePoll\(\)/.test(html), '全部就绪 / 离开世界应停止轮询');
});

test('前端：用量面板主人专属区（朋友访问 / 复制 / 隧道 / 今日各玩家 / 全局 token）', () => {
  // 按 host 专属字段判定主人，来客分支不渲染这些内容
  assert.ok(/var isHost = !!d\.access/.test(html), '用 access 字段区分主人');
  assert.ok(/朋友访问/.test(html), '应有朋友访问区');
  assert.ok(/访问密码/.test(html), '应显示访问密码（等宽）');
  assert.ok(/隧道未启动/.test(html), 'tunnel.url 为空时显示隧道未启动');
  assert.ok(/d\.tunnel && d\.tunnel\.url/.test(html), '有值时显示朋友链接');
  assert.ok(/navigator\.clipboard\.writeText/.test(html), '复制用 clipboard.writeText');
  assert.ok(/selectUsageText\(/.test(html), '复制失败时选中文本');
  assert.ok(/今日各玩家/.test(html), '应有今日各玩家区');
  assert.ok(/d\.players/.test(html) && /fmtWan\(p\.total\)/.test(html), '各玩家用量用 fmtWan');
  assert.ok(/全局 token/.test(html) && /d\.global/.test(html), '应有全局 token 行');
  // 等宽文本可换行，375px 不横向溢出
  assert.ok(/\.usage-mono\{[^}]*word-break:break-all/.test(html), '等宽文本应换行');
  assert.ok(/\.usage-friend-row\{[^}]*flex-wrap:wrap/.test(html), '朋友访问行应换行');
});
