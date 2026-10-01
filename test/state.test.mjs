/**
 * 会话图谱 · 持久化状态与存储域测试
 *
 * 覆盖两件事：
 *   1. src/core/state.js —— 两侧形态转换、规整、增量合并、未知版本处理
 *   2. src/host/store.js —— 领域 spec、手写 schema、读写与只读降级
 *
 * 运行：node test/state.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_VERSION, LIMITS, emptyState, idToRef, refToId,
  sanitizeState, mergePatch, stateToClient, clientPatchToState, sessionsInState
} from '../src/core/state.js';
import {
  DOMAIN_SPEC, DOMAIN_NAME, TABLE_NAME, familyRecordSchema, createStore, openStore
} from '../src/host/store.js';

/* ------------------------------------------------------------ id ↔ Ref */

test('块 / 会话头 / 空节点 三种 id 都能与 Ref 互转', () => {
  assert.equal(refToId({ sessionId: 's1', turn: 3 }), 's1:3');
  assert.equal(refToId({ sessionId: 's1' }), 'header:s1');
  assert.deepEqual(idToRef('s1:3'), { sessionId: 's1', turn: 3 });
  assert.deepEqual(idToRef('header:s1'), { sessionId: 's1' });
  /* 空子会话节点在持久层就是一个会话引用 */
  assert.deepEqual(idToRef('s1:empty'), { sessionId: 's1' });
});

test('认不出来的 id 一律返回 null，不猜', () => {
  for (const bad of ['', 's1', ':3', 's1:', 's1:0', 's1:-1', 's1:abc', null, undefined]) {
    assert.equal(idToRef(bad), null, `idToRef(${JSON.stringify(bad)})`);
  }
  assert.equal(refToId(null), '');
  assert.equal(refToId({}), '');
  assert.equal(refToId({ sessionId: 's', turn: 0 }), '');
});

/* ------------------------------------------------------------- 规整 */

test('空状态是干净的，且版本正确', () => {
  const s = emptyState(7);
  assert.equal(s.version, STATE_VERSION);
  assert.deepEqual(s.links, []);
  assert.deepEqual(s.positions, {});
  assert.deepEqual(s.alias, {});
  assert.equal(s.updatedAt, 7);
});

test('未知版本拒绝应用 —— 不猜测性解析（§5.3）', () => {
  assert.equal(sanitizeState({ version: 99 }), null);
  assert.equal(sanitizeState({ version: 0 }), null);
  assert.equal(sanitizeState({}), null);
  assert.equal(sanitizeState(null), null);
  assert.notEqual(sanitizeState({ version: STATE_VERSION }), null);
});

test('规整会剔掉畸形条目，而不是整体拒绝', () => {
  const s = sanitizeState({
    version: 1,
    links: [
      { from: 's1:1', to: 's1:2' },
      { from: 's1:1', to: 'garbage' },          /* 端点认不出 -> 丢 */
      null,
      { from: 's1:3', to: 's1:4', label: 'x'.repeat(500) }
    ],
    positions: { 's1:1': { x: 10.4, y: 20.6 }, 's1:2': { x: 'no' }, 's1:3': null },
    alias: { 's1:1': '  别名  ', 's1:2': '   ' },
    hiddenBlocks: ['s1:1', 's1:1', '', null],
    viewport: { zoom: 99, panX: 5, panY: 6 }
  });
  assert.equal(s.links.length, 2, '畸形连线被丢掉');
  assert.equal(s.links[1].label.length, LIMITS.labelLength, '标签限长');
  assert.deepEqual(s.positions, { 's1:1': { x: 10, y: 21 } }, '坐标取整，非法项丢弃');
  assert.deepEqual(s.alias, { 's1:1': '别名' }, '空别名等于没写');
  assert.deepEqual(s.hiddenBlocks, ['s1:1'], '去重去空');
  assert.equal(s.viewport.zoom, 2, '缩放被夹到上限');
});

/* --------------------------------------------------------- 增量合并 */

test('mergePatch 只动 patch 里出现的键', () => {
  const base = mergePatch(emptyState(0), {
    hiddenBlocks: ['s1:1'],
    alias: { 's1:2': '二' },
    viewport: { zoom: 1.5, panX: 1, panY: 2 }
  }, 10);
  const next = mergePatch(base, { alias: { 's1:3': '三' } }, 20);
  assert.deepEqual(next.hiddenBlocks, ['s1:1'], '没提 hiddenBlocks 就不动');
  assert.deepEqual(next.alias, { 's1:3': '三' }, 'alias 是整体覆盖');
  assert.deepEqual(next.viewport, base.viewport, '没提 viewport 就不动');
  assert.equal(next.updatedAt, 20);
  assert.equal(base.updatedAt, 10, '原对象不被改动');
});

test('mergePatch 的连线按 id 覆盖式合并，不丢其它连线', () => {
  const a = { id: 'L1', from: 's1:1', to: 's1:2', kind: 'link', createdAt: 5 };
  const b = { id: 'L2', from: 's1:2', to: 's1:3', kind: 'link' };
  const first = mergePatch(emptyState(0), { links: [a, b] }, 10);
  assert.equal(first.links.length, 2);

  /* 只重发 L1（改标签），L2 必须留着 */
  const second = mergePatch(first, { links: [{ id: 'L1', from: 's1:1', to: 's1:2', label: '因为' }] }, 20);
  assert.equal(second.links.length, 2, 'L2 没被冲掉');
  const l1 = second.links.find((l) => l.id === 'L1');
  assert.equal(l1.label, '因为');
  assert.equal(l1.createdAt, 5, '创建时间保留');
  assert.equal(l1.updatedAt, 20);
});

test('mergePatch 能按 id 删连线', () => {
  const s = mergePatch(emptyState(0), {
    links: [{ id: 'L1', from: 's1:1', to: 's1:2' }, { id: 'L2', from: 's1:2', to: 's1:3' }]
  }, 0);
  const after = mergePatch(s, { removeLinkIds: ['L1'] }, 1);
  assert.deepEqual(after.links.map((l) => l.id), ['L2']);
});

test('超限时截断，不给界面塞进无穷数据（NFR-1）', () => {
  const many = {};
  for (let i = 0; i < LIMITS.positions + 50; i += 1) many[`s1:${i + 1}`] = { x: i, y: i };
  const s = mergePatch(emptyState(0), { positions: many }, 0);
  assert.equal(Object.keys(s.positions).length, LIMITS.positions);
});

/* ------------------------------------------------- 两侧形态的转换 */

test('stateToClient 把 Ref 换成客户端 id，clientPatchToState 换回去', () => {
  const host = mergePatch(emptyState(0), {
    hiddenBlocks: ['s1:2'],
    alias: { 's1:1': '别名' },
    links: [{ id: 'L1', kind: 'reference', from: 's1:1', to: 'header:s2', label: '见' }]
  }, 3);

  const client = stateToClient(host);
  assert.deepEqual(client.hidden, { 's1:2': true });
  assert.deepEqual(client.alias, { 's1:1': '别名' });
  assert.deepEqual(client.links[0].from, 's1:1');
  assert.deepEqual(client.links[0].to, 'header:s2');
  assert.equal(client.links[0].kind, 'reference');

  const back = clientPatchToState({ hidden: client.hidden, links: client.links });
  assert.deepEqual(back.hiddenBlocks, ['s1:2']);
  assert.deepEqual(back.links[0].from, { sessionId: 's1', turn: 1 });
  assert.deepEqual(back.links[0].to, { sessionId: 's2' });
});

test('clientPatchToState 落盘前先规整，畸形数据写不进去', () => {
  const p = clientPatchToState({
    hidden: { 's1:1': true, 's1:2': false, '': true },
    links: [{ from: 's1:1', to: 'garbage', kind: 'link' }, { from: 's1:1', to: 's1:2' }]
  });
  assert.deepEqual(p.hiddenBlocks, ['s1:1']);
  assert.equal(p.links.length, 1, '端点认不出的连线在提交前就被丢掉');
});

test('sessionsInState 汇总状态里引用到的会话', () => {
  const s = mergePatch(emptyState(0), {
    hiddenBlocks: ['s1:1'],
    alias: { 's2:1': 'x' },
    collapsedSessions: ['s3'],
    links: [{ from: 's4:1', to: 'header:s5' }]
  }, 0);
  assert.deepEqual(sessionsInState(s).sort(), ['s1', 's2', 's3', 's4', 's5']);
});

/* --------------------------------------------------------- 领域 spec */

test('领域 spec 形状正确，且不需要 defineDomain 也合法', () => {
  assert.equal(DOMAIN_SPEC.name, DOMAIN_NAME);
  assert.equal(DOMAIN_SPEC.version, STATE_VERSION);
  assert.equal(DOMAIN_SPEC.layout, 'per-record', '一族一条记录，而不是一条巨型记录');
  assert.deepEqual(Object.keys(DOMAIN_SPEC.tables), [TABLE_NAME]);
  assert.equal(DOMAIN_SPEC.tables[TABLE_NAME].valueSchema, familyRecordSchema);
  /* open() 按结构读取，不做品牌校验 —— 所以字面 spec 直接用 */
  assert.equal(typeof DOMAIN_SPEC.tables[TABLE_NAME].valueSchema.parse, 'function');
  assert.equal(typeof DOMAIN_SPEC.tables[TABLE_NAME].valueSchema.safeParse, 'function');
});

/* 回归：域名里带连字符时，宿主的后端会在 kv.open 里拒收（malformed-medium），
   而 open() 不跑 defineDomain、名字错误无处报错 —— 结果是"永远只读"。
   这条断言把宿主的命名规则搬进测试，让同类错误在测试阶段就炸，而不是上线后靠猜。 */
test('领域名与表名符合宿主后端的命名规则（连字符会让存储永远打不开）', () => {
  const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;   /* @deepseek-ai/dsh-storage */
  assert.ok(UNIT_NAME_RE.test(DOMAIN_NAME), `领域名 ${DOMAIN_NAME} 必须匹配 ${UNIT_NAME_RE}`);
  assert.ok(UNIT_NAME_RE.test(TABLE_NAME), `表名 ${TABLE_NAME} 必须匹配 ${UNIT_NAME_RE}`);
  assert.ok(!DOMAIN_NAME.includes('-'), '连字符正是当初让持久化从未生效的原因');
});

test('名字不合法时，像宿主那样校验的后端会拒绝本 spec（同一回归的另一面）', async () => {
  const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
  const strictBackend = {
    open: async (spec) => {
      if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`invalid unit name '${spec.name}'`);
      return fakeDomain();
    }
  };
  assert.notEqual(await openStore(strictBackend), null, '本插件声明的领域必须能被真后端接受');
});

test('记录 schema 只做结构校验，由 sanitizeState 管版本', () => {
  const ok = { version: 1, links: [], positions: {}, alias: {}, hiddenBlocks: [] };
  assert.equal(familyRecordSchema.safeParse(ok).success, true);

  for (const bad of [null, 'x', [], {}, { version: 'no' }, { version: 1, links: {} },
    { version: 1, positions: [] }, { version: 1, viewport: 5 }]) {
    assert.equal(familyRecordSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  /* 未来版本在结构上仍然合法 —— 交给上层报"不兼容"，而不是让 open 失败把记录挪走 */
  assert.equal(familyRecordSchema.safeParse({ version: 7 }).success, true);
});

/* ------------------------------------------------------------ 存储 */

function fakeDomain(initial = {}) {
  const records = new Map(Object.entries(initial));
  let closed = false;
  return {
    records,
    isClosed: () => closed,
    table(name) {
      assert.equal(name, TABLE_NAME, '只该访问这一个表');
      return {
        get: (k) => records.get(k),
        put: async (k, v) => { records.set(k, v); },
        delete: async (k) => records.delete(k)
      };
    },
    async close() { closed = true; }
  };
}

test('读不存在的家族返回空状态且可写', async () => {
  const store = createStore(fakeDomain(), () => 100);
  const got = await store.read('fam-1');
  assert.deepEqual(got, { state: null, incompatible: false, writable: true });
});

test('写入是持久的，并且能被再读出来', async () => {
  const domain = fakeDomain();
  const store = createStore(domain, () => 100);
  await store.write('fam-1', { hiddenBlocks: ['s1:1'], alias: { 's1:2': '二' } });
  const reread = await store.read('fam-1');
  assert.deepEqual(reread.state.hiddenBlocks, ['s1:1']);
  assert.deepEqual(reread.state.alias, { 's1:2': '二' });
  assert.equal(reread.state.updatedAt, 100);
  assert.equal(reread.writable, true);
});

test('两次写入是累加的，不是覆盖', async () => {
  const store = createStore(fakeDomain(), () => 1);
  await store.write('fam', { hiddenBlocks: ['s1:1'] });
  await store.write('fam', { alias: { 's1:2': '二' } });
  const got = await store.read('fam');
  assert.deepEqual(got.state.hiddenBlocks, ['s1:1'], '第一次写的还在');
  assert.deepEqual(got.state.alias, { 's1:2': '二' });
});

test('记录版本不认识时：报不兼容、只读、且**绝不覆盖**', async () => {
  const future = { version: 99, links: [], note: '未来版本写的' };
  const domain = fakeDomain({ fam: future });
  const store = createStore(domain, () => 1);

  const got = await store.read('fam');
  assert.equal(got.incompatible, true);
  assert.equal(got.writable, false);
  assert.equal(got.state, null);

  await assert.rejects(() => store.write('fam', { hiddenBlocks: ['s1:1'] }),
    (e) => e.code === 'incompatible-version');
  assert.deepEqual(domain.records.get('fam'), future, '原记录一字未动');
});

test('缺家族 id 不写；remove 对不存在的键返回 false', async () => {
  const store = createStore(fakeDomain(), () => 1);
  await assert.rejects(() => store.write('', {}), /家族根会话 id/);
  assert.equal(await store.remove(''), false);
  assert.equal(await store.remove('nope'), false);
  await store.write('fam', { hiddenBlocks: ['s1:1'] });
  assert.equal(await store.remove('fam'), true);
});

test('领域设施不可用时 openStore 返回 null，绝不抛（§5.3 只读降级）', async () => {
  assert.equal(await openStore(null), null);
  assert.equal(await openStore({}), null);
  assert.equal(await openStore({ open: async () => { throw new Error('backend-not-found'); } }), null);
});

test('openStore 把失败原因交给调用方，但仍然只返回 null', async () => {
  const seen = [];
  const boom = Object.assign(new Error("invalid unit name 'session-graph'"), { code: 'malformed-medium' });
  const store = await openStore({ open: async () => { throw boom; } }, undefined, (e) => seen.push(e));
  assert.equal(store, null, '降级行为不变');
  assert.deepEqual(seen, [boom], '失败原因不能跟着一起消失 —— 只读的成因必须看得见');

  /* 上报口自己抛错也不能把降级路径带崩 */
  const again = await openStore({ open: async () => { throw boom; } }, undefined, () => { throw new Error('logger down'); });
  assert.equal(again, null);
});

test('openStore 把领域打开成 store，并使用同一个 spec', async () => {
  let got = null;
  const store = await openStore({ open: async (spec) => { got = spec; return fakeDomain(); } });
  assert.notEqual(store, null);
  assert.equal(got, DOMAIN_SPEC, '传下去的就是本插件声明的那个领域');
});
