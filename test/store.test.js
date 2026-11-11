'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/store.js');

function tmpData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-store-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('atomicWriteJson: 自动建目录、写合法 JSON、覆盖不损坏、无残留 tmp', () => {
  const dir = tmpData();
  try {
    const file = path.join(dir, 'worlds', 'w1', 'state.json');
    store.atomicWriteJson(file, { a: 1, turn: 0 });
    assert.equal(fs.existsSync(file), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, turn: 0 });

    store.atomicWriteJson(file, { a: 2, turn: 9, nested: { x: [1, 2] } });
    const again = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(again.turn, 9);
    assert.deepEqual(again.nested, { x: [1, 2] });

    const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    cleanup(dir);
  }
});

test('atomicWriteJson: 序列化失败时不留下 tmp 文件', () => {
  const dir = tmpData();
  try {
    const circular = {};
    circular.self = circular;
    assert.throws(() => store.atomicWriteJson(path.join(dir, 'x.json'), circular));
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  } finally {
    cleanup(dir);
  }
});

test('atomicWriteText: 原样写入文本', () => {
  const dir = tmpData();
  try {
    const file = path.join(dir, 'a', 'b.txt');
    store.atomicWriteText(file, '你好\nworld');
    assert.equal(fs.readFileSync(file, 'utf8'), '你好\nworld');
  } finally {
    cleanup(dir);
  }
});

test('appendJsonl / readJsonl: 逐行追加、只增不删、中文与转义、CRLF', () => {
  const dir = tmpData();
  try {
    const file = path.join(dir, 'events.jsonl');
    store.appendJsonl(file, { turn: 1, action: 'a' });
    store.appendJsonl(file, { turn: 2, action: 'b' });
    store.appendJsonl(file, { turn: 3, narration: '中文\n带换行' });
    const rows = store.readJsonl(file);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].turn, 1);
    assert.equal(rows[1].action, 'b');
    assert.equal(rows[2].narration, '中文\n带换行');
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);

    const crlf = path.join(dir, 'crlf.jsonl');
    fs.writeFileSync(crlf, '{"a":1}\r\n{"a":2}\r\n', 'utf8');
    assert.equal(store.readJsonl(crlf).length, 2);
    assert.deepEqual(store.readJsonl(path.join(dir, 'nope.jsonl')), []);
  } finally {
    cleanup(dir);
  }
});

test('withWorldLock: 同一世界严格串行（FIFO）', async () => {
  const order = [];
  let entered;
  const enteredP = new Promise((r) => {
    entered = r;
  });
  let release;
  const gate = new Promise((r) => {
    release = r;
  });

  const p1 = store.withWorldLock('fifo', async () => {
    entered();
    await gate;
    order.push('1-end');
  });
  const p2 = store.withWorldLock('fifo', async () => {
    order.push('2-start');
  });

  await enteredP;
  assert.deepEqual(order, []); // 第二个必须还在排队
  release();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['1-end', '2-start']);
  assert.equal(store.getLockedKeys().includes('fifo'), false);
});

test('withWorldLock: 返回值透传、并发自增不丢更新', async () => {
  let counter = 0;
  const tasks = [];
  for (let i = 0; i < 20; i++) {
    tasks.push(
      store.withWorldLock('counter', async () => {
        const v = counter;
        await Promise.resolve();
        counter = v + 1;
      }),
    );
  }
  const results = await Promise.all(tasks);
  assert.equal(counter, 20);
  assert.equal(results.length, 20);
  assert.equal(await store.withWorldLock('single', () => 42), 42);
});

test('withWorldLock: 不同世界互不阻塞', async () => {
  let releaseA;
  const gateA = new Promise((r) => {
    releaseA = r;
  });
  let aDone = false;
  let bDone = false;
  const pA = store.withWorldLock('A', () => gateA.then(() => {
    aDone = true;
  }));
  const pB = store.withWorldLock('B', async () => {
    bDone = true;
  });
  await pB;
  assert.equal(bDone, true);
  assert.equal(aDone, false);
  releaseA();
  await pA;
  assert.equal(aDone, true);
});

test('withWorldLock: 任务抛错不卡死队列，且锁最终被清理', async () => {
  await assert.rejects(
    store.withWorldLock('errWorld', () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await store.withWorldLock('errWorld', () => 42), 42);
  assert.equal(store.getLockedKeys().includes('errWorld'), false);
});

test('saveWorld / loadWorld / listWorlds / appendUsage', () => {
  const dir = tmpData();
  try {
    assert.equal(store.loadWorld(dir, 'nope'), null);
    assert.equal(store.worldExists(dir, 'nope'), false);

    store.saveWorld(dir, {
      id: 'w1', turn: 7, life: 2, bible: { title: '甲' },
      character: { alive: true, name: '  令狐冲  ' },
      genre: '仙侠', location: '  长安城  ',
      clock: { day: 3, period: '黄昏日落西山后' }, awaitingRebirth: true,
      recent: [{ narration: '第一回合' }, { narration: '**旅人**踏上了旅程' }],
    });
    store.saveWorld(dir, {
      id: 'w2', turn: 1, life: 1, bible: { title: '乙' }, character: { alive: false },
    });
    // 用 mtime 拉开两个世界的 updatedAt，验证排序（w2 更新 → 排最前）。
    fs.utimesSync(store.statePath(dir, 'w1'), 1000000000, 1000000000);
    fs.utimesSync(store.statePath(dir, 'w2'), 1600000000, 1600000000);

    assert.equal(store.loadWorld(dir, 'w1').turn, 7);
    assert.equal(store.worldExists(dir, 'w1'), true);

    const list = store.listWorlds(dir);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'w2', 'updatedAt 新的排前面');
    assert.equal(list[1].id, 'w1');
    const a = list.find((x) => x.id === 'w1');
    assert.equal(a.title, '甲');
    assert.equal(a.turn, 7);
    assert.equal(a.life, 2);
    assert.equal(a.alive, true);
    assert.equal(typeof a.updatedAt, 'number');
    // 首页新增摘要字段
    assert.equal(a.genre, '仙侠');
    assert.equal(a.charName, '令狐冲');
    assert.equal(a.place, '长安城');
    assert.equal(a.day, 3);
    assert.equal(a.period, '黄昏日落西山'); // 截到 6 字
    assert.equal(a.awaitingRebirth, true);
    assert.equal(a.excerpt, '旅人踏上了旅程'); // 去掉 ** 后的最后一段
    const b = list.find((x) => x.id === 'w2');
    assert.equal(b.alive, false);
    // 缺字段时的默认值
    assert.equal(b.genre, null);
    assert.equal(b.charName, '');
    assert.equal(b.place, '');
    assert.equal(b.day, null);
    assert.equal(b.period, '');
    assert.equal(b.awaitingRebirth, false);
    assert.equal(b.excerpt, '');

    store.appendUsage(dir, { ts: 1, model: 'm', ok: true });
    store.appendUsage(dir, { ts: 2, model: 'm', ok: false });
    assert.equal(store.readJsonl(store.usagePath(dir)).length, 2);
    assert.deepEqual(store.listWorlds(path.join(dir, 'missing-sub')), []);
  } finally {
    cleanup(dir);
  }
});

test('worldExcerpt：来源优先级、多段/加粗/超长截断、异常输入不抛错', () => {
  // 非对象输入一律 ''
  for (const bad of [null, undefined, 42, 'abc', [], () => {}]) {
    assert.equal(store.worldExcerpt(bad), '');
  }
  assert.equal(store.worldExcerpt({}), '');

  // 成人内容直接 ''（即使有正文）
  assert.equal(store.worldExcerpt({ adult: true, recent: [{ narration: '不该露出' }] }), '');

  // recent：从后往前取第一条非空 narration
  assert.equal(store.worldExcerpt({ recent: [{ narration: 'A' }, { narration: 'B' }] }), 'B');
  assert.equal(
    store.worldExcerpt({ recent: [{ narration: '前一条有效' }, { narration: '' }] }),
    '前一条有效',
    '最后一条 narration 为空时取前一条',
  );
  assert.equal(store.worldExcerpt({ recent: [{ narration: '前一条' }, {}] }), '前一条');
  assert.equal(
    store.worldExcerpt({ recent: [{ narration: '前一条' }, { narration: '   ' }] }),
    '前一条',
    '空白 narration 也视为空',
  );
  assert.equal(
    store.worldExcerpt({ recent: [{ narration: 123 }], bible: { prologue: { now: '回退' } } }),
    '回退',
    '非字符串 narration 跳过并回退',
  );

  // 无 recent / recent 全空 → prologue.now
  assert.equal(store.worldExcerpt({ bible: { prologue: { now: '序章此刻' } } }), '序章此刻');
  assert.equal(
    store.worldExcerpt({ recent: [], bible: { prologue: { now: '序章' }, start: { situation: '开局' } } }),
    '序章',
  );
  // 再退到 start.situation
  assert.equal(store.worldExcerpt({ bible: { start: { situation: '开局处境' } } }), '开局处境');
  assert.equal(
    store.worldExcerpt({ bible: { prologue: { now: '' }, start: { situation: '退到开局' } } }),
    '退到开局',
  );

  // 多段取最后一段（跳过空白段）
  assert.equal(store.worldExcerpt({ recent: [{ narration: '第一段\n\n第二段\n  \n' }] }), '第二段');
  // 去掉 Markdown 加粗符号
  assert.equal(store.worldExcerpt({ recent: [{ narration: '这是**加粗**文字' }] }), '这是加粗文字');
  // ≤ 70 字直接返回
  assert.equal(store.worldExcerpt({ recent: [{ narration: '甲'.repeat(70) }] }), '甲'.repeat(70));

  // 超过 70 字：以 … 开头、总长 ≤ 71、且从句末标点之后开始
  const long = '甲'.repeat(30) + '。' + '乙'.repeat(69);
  const ex = store.worldExcerpt({ recent: [{ narration: long }] });
  assert.equal(ex, '…' + '乙'.repeat(69), '从第一个句末标点之后开始截');
  assert.ok(Array.from(ex).length <= 71);
  // 前 35 字里没有句末标点时，保留完整最后 70 字
  const ex2 = store.worldExcerpt({ recent: [{ narration: '甲'.repeat(100) }] });
  assert.equal(ex2, '…' + '甲'.repeat(70));
  assert.equal(Array.from(ex2).length, 71);

  // 绝不抛错：带抛错 getter 的对象
  const evil = {};
  Object.defineProperty(evil, 'adult', { get() { throw new Error('boom'); } });
  assert.equal(store.worldExcerpt(evil), '');
});

test('appendEvent / readEvents: 每回合一行完整记录，永不删除', () => {
  const dir = tmpData();
  try {
    for (let i = 1; i <= 5; i++) {
      store.appendEvent(dir, 'w1', { turn: i, action: `动作${i}` });
    }
    const rows = store.readEvents(dir, 'w1');
    assert.equal(rows.length, 5);
    assert.equal(rows[4].action, '动作5');
    assert.equal(fs.readFileSync(store.eventsPath(dir, 'w1'), 'utf8').trim().split('\n').length, 5);
  } finally {
    cleanup(dir);
  }
});

test('撤回备份：回合前复制 state.json→state.prev.json，恢复后删除 .prev（只能一步）', () => {
  const dir = tmpData();
  try {
    const id = 'w1';
    const prevPath = path.join(dir, 'worlds', id, 'state.prev.json');
    assert.equal(store.hasUndoBackup(dir, id), false);
    assert.equal(store.readUndoBackup(dir, id), null);

    // 回合前状态（turn=2）
    store.saveWorld(dir, { id, turn: 2, life: 1, character: { alive: true } });
    store.backupForUndo(dir, id);
    assert.equal(store.hasUndoBackup(dir, id), true);
    assert.ok(fs.existsSync(prevPath), '应生成 state.prev.json');
    assert.equal(store.readUndoBackup(dir, id).turn, 2, '快照应为回合前状态');

    // 本回合写入新状态（turn=3）
    store.saveWorld(dir, { id, turn: 3, life: 1, character: { alive: true } });
    assert.equal(store.loadWorld(dir, id).turn, 3);

    // 撤回：恢复 turn=2、删除 .prev
    store.restoreUndoBackup(dir, id);
    assert.equal(store.loadWorld(dir, id).turn, 2, 'state.json 应恢复为快照');
    assert.equal(store.hasUndoBackup(dir, id), false, '.prev 应被删除，只能撤回一步');
    assert.equal(fs.existsSync(prevPath), false);
    assert.equal(store.readUndoBackup(dir, id), null);
  } finally {
    cleanup(dir);
  }
});

test('撤回备份只针对 state.json：events.jsonl / usage.jsonl 不产生 .prev（只追加日志）', () => {
  const dir = tmpData();
  try {
    const id = 'w1';
    store.saveWorld(dir, { id, turn: 1 });
    store.appendEvent(dir, id, { turn: 1, action: 'x' });
    store.appendUsage(dir, { ts: 1 });
    store.backupForUndo(dir, id);
    const prevNames = fs.readdirSync(path.join(dir, 'worlds', id))
      .filter((n) => n.endsWith('.prev.json'));
    assert.deepEqual(prevNames, ['state.prev.json'], '只备份可变文件 state.json');
    assert.equal(fs.existsSync(path.join(dir, 'usage.prev.json')), false,
      '全局 usage.jsonl 只追加，不备份');
  } finally {
    cleanup(dir);
  }
});

test('deleteWorld: 移到 _trash，原目录消失，内容完整保留', () => {
  const dir = tmpData();
  try {
    store.saveWorld(dir, { id: 'w1', turn: 3, bible: { title: '测试世界' } });
    store.appendEvent(dir, 'w1', { turn: 1 });
    const dest = store.deleteWorld(dir, 'w1');

    assert.equal(dest.startsWith(store.trashDir(dir)), true);
    assert.equal(store.worldExists(dir, 'w1'), false);
    assert.equal(fs.existsSync(dest), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'state.json'), 'utf8')).bible.title, '测试世界');
    assert.equal(
      fs.readFileSync(path.join(dest, 'events.jsonl'), 'utf8').trim().split('\n').length,
      1,
    );
    assert.equal(store.listWorlds(dir).length, 0);
  } finally {
    cleanup(dir);
  }
});

test('deleteWorld: 同名重复删除不覆盖旧回收内容；不存在的世界返回 null', () => {
  const dir = tmpData();
  try {
    store.saveWorld(dir, { id: 'dup', turn: 1 });
    const d1 = store.deleteWorld(dir, 'dup');
    store.saveWorld(dir, { id: 'dup', turn: 2 });
    const d2 = store.deleteWorld(dir, 'dup');
    assert.notEqual(d1, d2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(d1, 'state.json'), 'utf8')).turn, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(d2, 'state.json'), 'utf8')).turn, 2);
    assert.equal(store.deleteWorld(dir, 'never-existed'), null);
  } finally {
    cleanup(dir);
  }
});

test('assertWorldId: 拒绝路径穿越与非法 ID', () => {
  for (const bad of ['../etc', '..', 'a/b', 'a\\b', '', 'x y', 'w.']) {
    assert.throws(() => store.assertWorldId(bad), `应拒绝 ${JSON.stringify(bad)}`);
  }
  assert.equal(store.assertWorldId('world_1-A'), 'world_1-A');
  assert.throws(() => store.deleteWorld(os.tmpdir(), '../escape'));
  assert.throws(() => store.saveWorld(os.tmpdir(), { id: '../evil', turn: 1 }));
});

test('路径全部由 path.join 生成（Windows 兼容）', () => {
  const dir = path.join('data', 'root');
  assert.equal(store.worldDir(dir, 'w1'), path.join('data', 'root', 'worlds', 'w1'));
  assert.equal(store.statePath(dir, 'w1'), path.join('data', 'root', 'worlds', 'w1', 'state.json'));
  assert.equal(store.eventsPath(dir, 'w1'), path.join('data', 'root', 'worlds', 'w1', 'events.jsonl'));
  assert.equal(store.trashDir(dir), path.join('data', 'root', '_trash'));
  assert.equal(store.usagePath(dir), path.join('data', 'root', 'usage.jsonl'));
});
