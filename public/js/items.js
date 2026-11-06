'use strict';

// 随身物品介绍卡片：点击物品卡片弹出大图 + 名字 / 类型 / 介绍。
// 只用 el()/textContent 构建 DOM，绝不拼接原始 HTML 字符串。
// 介绍优先取 currentState.itemInfo；缺介绍时后台请求一次 GET /items 补齐并刷新卡片。

var itemInfoFetchedWorld = null; // 同一世界只补请求一次，失败也静默不重试

function itemInfoOf(name) {
  var info = (currentState && currentState.itemInfo) || {};
  var meta = info[name];
  if (meta && typeof meta === 'object' && typeof meta.desc === 'string' && meta.desc) return meta;
  return null;
}

// 后台批量取全部物品介绍，合并进 currentState.itemInfo；同一世界只请求一次，失败静默。
function fetchItemInfoOnce(worldId, onDone) {
  if (!worldId || itemInfoFetchedWorld === worldId) return;
  itemInfoFetchedWorld = worldId;
  api('/api/worlds/' + encodeURIComponent(worldId) + '/items').then(function (data) {
    if (!data || !Array.isArray(data.items)) return;
    var map = {};
    data.items.forEach(function (it) {
      if (it && typeof it.name === 'string') {
        map[it.name] = {
          desc: typeof it.desc === 'string' ? it.desc : '',
          type: typeof it.type === 'string' ? it.type : '',
        };
      }
    });
    if (currentState) currentState.itemInfo = Object.assign({}, currentState.itemInfo || {}, map);
    if (typeof onDone === 'function') onDone();
  }).catch(function () { /* 失败静默，卡片保留「介绍生成中…」 */ });
}

// 大图：有 ready 图就显示 imageState.items[name].url（点击看原图），否则首字色块。
function buildItemCardHero(name) {
  var info = imageState.items[name];
  if (info && info.status === 'ready' && info.url) {
    var img = el('img', 'item-card-hero');
    img.src = info.url;
    img.alt = name;
    img.addEventListener('click', function () { openImageViewer(info.url); });
    return img;
  }
  var fallback = el('div', 'item-card-hero item-card-hero-fallback');
  fallback.textContent = String(name == null ? '' : name).charAt(0) || '?';
  return fallback;
}

function showItemCard(name) {
  var old = document.getElementById('item-card-modal');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  var mask = el('div', 'item-card-mask');
  mask.id = 'item-card-modal';
  var card = el('div', 'item-card-modal-card');

  card.appendChild(buildItemCardHero(name));
  card.appendChild(el('h2', 'item-card-title', name));

  var meta = itemInfoOf(name);
  var tagWrap = el('div', 'item-card-tags');
  function fillMeta(m) {
    tagWrap.textContent = '';
    if (m && m.type) tagWrap.appendChild(el('span', 'item-card-type', m.type));
  }
  fillMeta(meta);
  card.appendChild(tagWrap);

  var descEl = el('p', 'item-card-desc');
  if (meta) {
    descEl.textContent = meta.desc;
  } else {
    descEl.textContent = '介绍生成中…';
    fetchItemInfoOnce(currentWorldId, function () {
      // 仅当这张卡片仍开着时才刷新（同名物品 / 重新打开会换新的 mask）。
      if (document.getElementById('item-card-modal') !== mask) return;
      var m2 = itemInfoOf(name);
      if (m2) {
        descEl.textContent = m2.desc;
        fillMeta(m2);
      } else {
        descEl.textContent = '（暂无介绍）';
      }
    });
  }
  card.appendChild(descEl);

  function close() {
    if (mask.parentNode) mask.parentNode.removeChild(mask);
  }
  var btn = el('button', 'btn item-card-close', '关闭');
  btn.addEventListener('click', close);
  card.appendChild(btn);

  mask.addEventListener('click', function (e) {
    if (e.target === mask) close();
  });

  mask.appendChild(card);
  document.body.appendChild(mask);
  return mask;
}
