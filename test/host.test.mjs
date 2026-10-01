/**
 * 会话图谱 · Host 侧测试
 *
 * 覆盖事件折叠、分叉源推导，以及 Fetch 路由的请求处理。
 * 这些都不需要真实宿主：用假的 ctx 提供 sessions / sessionQuery 即可。
 *
 * 运行：node test/host.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { foldTurns, isHumanTurn, textOf, forkTurnFromChild, linkForks } from '../src/host/fold.js';
import { apply, buildPayload, readSessions, skeletonize, skeletonizeTurns, SKELETON_PREVIEW } from '../index.js';

/* --------------------------------------------------------------- 夹具 */

const ev = (type, seq, data) => ({ type, seq, data: data || {} });

/* 事件载荷照 `@deepseek-ai/dsh-session-turn-outline` 的权威判定来构造，
   不是照"看起来合理"来构造 —— 之前正是因为夹具用了 `source: 'user'` 字符串，
   而真实数据是 `source: { kind: 'user' }` 对象，才让"提问全空"这个 bug 溜过了测试。 */
const user = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const assistant = (text) => ({ message: { content: [{ type: 'text', text }] } });

/** 3 轮，第 3 轮在 seq 12 结束 → 从它分叉出来的子会话继承 13 条事件 */
const ROOT_EVENTS = [
  ev('turn/start', 0, { turn: 1 }),
  ev('user/message', 1, user('Q1')),
  ev('assistant/message', 2, assistant('A1')),
  ev('turn/end', 3),
  ev('turn/start', 4, { turn: 2 }),
  ev('user/message', 5, user('Q2')),
  ev('tool/call', 6, { name: 'web_search' }),
  ev('assistant/message', 7, assistant('A2')),
  ev('turn/end', 8),
  ev('turn/start', 9, { turn: 3 }),
  ev('user/message', 10, user('Q3')),
  ev('assistant/message', 11, assistant('A3')),
  ev('turn/end', 12)
];

const CHILD_EVENTS = [
  ev('turn/start', 0, { turn: 1 }),
  ev('user/message', 1, user('子会话提问')),
  ev('assistant/message', 2, assistant('子会话回答')),
  ev('turn/end', 3)
];

/* 观察句柄是异步的、且需要释放 —— 与产品自身的会话日志导出一致 */
let observedHandles = 0;
let disposedHandles = 0;
const fakeObserve = (id) => {
  observedHandles += 1;
  return Promise.resolve({
    events: id === 'root' ? ROOT_EVENTS : id === 'child' ? CHILD_EVENTS : [],
    [Symbol.dispose]() { disposedHandles += 1; }
  });
};

const fakeCtx = (extra = {}) => ({
  sessions: {
    list: () => [
      { header: { id: 'root', title: '根会话', parentSession: null, inheritedEventCount: 0 } },
      { header: { id: 'child', title: '子会话', parentSession: 'root', inheritedEventCount: 13 } }
    ]
  },
  sessionQuery: { observeSession: fakeObserve },
  ...extra
});

const params = (o) => new URLSearchParams(o);

/* ----------------------------------------------------------- 事件折叠 */

test('foldTurns 按 turn/start 与 turn/end 切分轮次', () => {
  const turns = foldTurns(ROOT_EVENTS);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((t) => t.turn), [1, 2, 3]);
  assert.deepEqual(turns.map((t) => t.endSeq), [3, 8, 12]);
  assert.equal(turns[0].prompt, 'Q1');
  assert.equal(turns[2].response, 'A3');
  assert.ok(turns.every((t) => t.status === 'done'));
});

test('foldTurns 统计工具调用次数', () => {
  assert.equal(foldTurns(ROOT_EVENTS)[1].toolCalls, 1);
  assert.equal(foldTurns(ROOT_EVENTS)[0].toolCalls, 0);
});

test('foldTurns 只取首条人类提问，注入的上下文不进入', () => {
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    /* 注入的上下文与工具结果：source.kind 不是 user */
    ev('user/message', 1, { source: { kind: 'injected' }, content: [{ type: 'text', text: '系统注入的上下文' }] }),
    ev('user/message', 2, user('真正的问题')),
    ev('user/message', 3, user('追问（steering）')),
    ev('assistant/message', 4, assistant('A')),
    ev('turn/end', 5)
  ];
  const t = foldTurns(events)[0];
  assert.equal(t.prompt, '真正的问题', '注入的被跳过，首个人类消息胜出');
});

test('user/message 的 source 是对象时也认得出人类（真实形状）', () => {
  /* 回归：早先对 {kind:'user'} 做 String() 得到 "[object Object]"，提问一律为空 */
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: '你叫什么' }] }),
    ev('assistant/message', 2, assistant('我是助手')),
    ev('turn/end', 3)
  ];
  const t = foldTurns(events)[0];
  assert.equal(t.prompt, '你叫什么');
  assert.equal(t.response, '我是助手');
});

test('内容块里只取文本块，图片块不带文字也不占位', () => {
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, {
      source: { kind: 'user' },
      content: [{ type: 'image', url: 'x.png' }, { type: 'text', text: '看这张图' }]
    }),
    ev('assistant/message', 2, { message: { content: [{ type: 'thinking', text: '内心独白' }, { type: 'text', text: '收到' }] } }),
    ev('turn/end', 3)
  ];
  const t = foldTurns(events)[0];
  assert.equal(t.prompt, '看这张图', '图片块被跳过');
  assert.equal(t.response, '收到', 'thinking 块不算回答');
});

test('正文里的尖括号是内容，不能被当标记语言剥掉', () => {
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, user('把 <div class="a"> 改成 <span>')),
    ev('assistant/message', 2, assistant('模板里用 v-if 而不是 <template>')),
    ev('turn/end', 3)
  ];
  const t = foldTurns(events)[0];
  assert.equal(t.prompt, '把 <div class="a"> 改成 <span>');
  assert.equal(t.response, '模板里用 v-if 而不是 <template>');
});

test('foldTurns 保留最后一条带文本的助手消息', () => {
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('assistant/message', 1, { text: '草稿一' }),
    ev('assistant/message', 2, { text: '草稿二' }),
    ev('assistant/message', 3, { text: '' }),
    ev('turn/end', 4)
  ];
  assert.equal(foldTurns(events)[0].response, '草稿二');
});

test('foldTurns 对没有 turn/end 的轮次保持 open 且 endSeq 为 null', () => {
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, { source: 'user', text: 'Q' }),
    ev('assistant/message', 2, { text: 'A' })
  ];
  const t = foldTurns(events)[0];
  assert.equal(t.status, 'open');
  assert.equal(t.endSeq, null, '不能拿最后一个事件序号充数');
});

test('foldTurns 对空输入与垃圾输入不抛错', () => {
  assert.deepEqual(foldTurns(null), []);
  assert.deepEqual(foldTurns([]), []);
  assert.equal(foldTurns([null, 1, 'x', {}]).length, 0);
});

test('foldTurns 在上一轮缺 turn/end 时也能收尾', () => {
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, { source: 'user', text: 'Q1' }),
    ev('turn/start', 5, { turn: 2 }),
    ev('user/message', 6, { source: 'user', text: 'Q2' }),
    ev('turn/end', 9)
  ];
  const turns = foldTurns(events);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].status, 'open', '第一轮没有被伪造出结束边界');
  assert.equal(turns[1].endSeq, 9);
});

test('isHumanTurn 容忍缺字段，但拒绝显式的非人类来源', () => {
  assert.equal(isHumanTurn({}), true);
  assert.equal(isHumanTurn({ source: 'user' }), true);
  assert.equal(isHumanTurn({ role: 'human' }), true);
  assert.equal(isHumanTurn({ source: 'injected' }), false);
  assert.equal(isHumanTurn({ origin: 'tool' }), false);
});

test('textOf 支持字符串、text 字段与内容块数组', () => {
  assert.equal(textOf('  直接文本 '), '直接文本');
  assert.equal(textOf({ text: '甲' }), '甲');
  /* 文本块之间留空行：它们本是不同段落，压成一行会毁掉 Markdown 结构 */
  assert.equal(textOf({ content: [{ text: '甲' }, { text: '乙' }] }), '甲\n\n乙');
  assert.equal(textOf({ message: { content: [{ text: '嵌套' }] } }), '嵌套');
  assert.equal(textOf({ content: { nothing: 1 } }), '');
  assert.equal(textOf(null), '');
});

test('textOf 保留正文换行（Markdown 的表格与代码块全靠它）', () => {
  const md = '结论：\n\n| 层 | 依赖 |\n|---|---|\n| L1 | 视图位 |\n\n```js\nconst x = 1;\n```';
  assert.equal(textOf({ content: [{ type: 'text', text: md }] }), md);
  assert.equal(textOf(md), md);
});

/* ------------------------------------------------------- 分叉源推导 */

test('forkTurnFromChild 用继承事件数反推分叉源轮次', () => {
  const parentTurns = foldTurns(ROOT_EVENTS);
  assert.equal(forkTurnFromChild(parentTurns, 13), 3, '边界 12 落在第 3 轮的结尾');
  assert.equal(forkTurnFromChild(parentTurns, 4), 1, '边界 3 落在第 1 轮的结尾');
  assert.equal(forkTurnFromChild(parentTurns, 9), 2);
});

test('forkTurnFromChild 对不上时返回 null，不猜', () => {
  const parentTurns = foldTurns(ROOT_EVENTS);
  assert.equal(forkTurnFromChild(parentTurns, 999), null);
  assert.equal(forkTurnFromChild(parentTurns, 0), null);
  assert.equal(forkTurnFromChild(parentTurns, null), null);
  assert.equal(forkTurnFromChild([], 12), null);
});

test('linkForks 给子会话补上 forkAtTurn，已有值时不动', () => {
  const turns = { root: foldTurns(ROOT_EVENTS), child: foldTurns(CHILD_EVENTS) };
  const linked = linkForks([
    { id: 'root', parentId: null, inheritedEventCount: 0 },
    { id: 'child', parentId: 'root', inheritedEventCount: 13 },
    { id: 'kept', parentId: 'root', forkAtTurn: 7, inheritedEventCount: 13 }
  ], turns);
  assert.equal(linked[0].forkAtTurn, undefined);
  assert.equal(linked[1].forkAtTurn, 3);
  assert.equal(linked[2].forkAtTurn, 7, '显式值优先');
});

/* --------------------------------------------------------- 请求处理 */

test('buildPayload(format=json) 返回家族数据且不触发下载', async () => {
  const ctx = fakeCtx();
  const out = await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), {});
  assert.equal(out.download, false);
  const data = JSON.parse(out.body);
  assert.equal(data.currentId, 'root');
  assert.equal(data.rootId, 'root');
  assert.equal(data.stats.sessions, 2);
  assert.equal(data.stats.blocks, 4, '3 + 1');
  assert.equal(data.edges.length, 1);
  assert.equal(data.edges[0].from, 'root:3', '派生边落在第 3 轮上');
  assert.equal(data.edges[0].to, 'child:1');
});

test('异步观察句柄被 await，并且用完即释放', async () => {
  const before = disposedHandles;
  const beforeOpen = observedHandles;
  const out = await buildPayload(fakeCtx(), params({ sessionId: 'root', format: 'json' }), {});
  const data = JSON.parse(out.body);
  assert.equal(data.turns.root.length, 3, '若把 Promise 当同步对象，这里会是 0 —— 正是线上"路由 200 但没内容"的成因');
  assert.equal(observedHandles - beforeOpen, 2);
  assert.equal(disposedHandles - before, 2, '每个打开过的观察句柄都释放了');
});

test('buildPayload 缺 sessionId 返回 400', async () => {
  await assert.rejects(() => buildPayload(fakeCtx(), params({}), {}), (e) => e.status === 400);
});

test('buildPayload 非法 format 返回 400', async () => {
  await assert.rejects(
    () => buildPayload(fakeCtx(), params({ sessionId: 'root', format: 'pdf' }), {}),
    (e) => e.status === 400 && /format/.test(e.message)
  );
});

test('buildPayload sessionId 不可读返回 404', async () => {
  await assert.rejects(
    () => buildPayload(fakeCtx(), params({ sessionId: 'nope' }), {}),
    (e) => e.status === 404
  );
});

test('buildPayload 非法 hidden/alias 返回 400', async () => {
  await assert.rejects(
    () => buildPayload(fakeCtx(), params({ sessionId: 'root', hidden: '{oops' }), {}),
    (e) => e.status === 400
  );
});

test('buildPayload 超上限不再报 413，改为降级返回骨架块（FR-4）', async () => {
  const ctx = fakeCtx();
  const out = await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), { maxBlocks: 3 });
  assert.equal(out.download, false);
  const data = JSON.parse(out.body);
  assert.equal(data.stats.skeleton, 1, '4 块里降 1 块');
  assert.equal(data.blocks.length, 4, '块没有丢，只是有的成了骨架');
  assert.equal(data.blocks.filter((b) => b.skeleton).length, 1);
});

test('buildPayload(format=mm) 产出可下载的 .mm，且每个块区分问答', async () => {
  const out = await buildPayload(fakeCtx(), params({ sessionId: 'root', format: 'mm' }), {});
  assert.equal(out.download, true);
  assert.match(out.filename, /\.mm$/);
  assert.match(out.contentType, /xml/);
  assert.match(out.body, /^<map version="1.0.1">/);
  assert.equal((out.body.match(/<b>问<\/b>/g) || []).length, 4, '4 个块各一段「问」');
  assert.equal((out.body.match(/<b>答<\/b>/g) || []).length, 4);
  const open = (out.body.match(/<node [^>]*[^/]>/g) || []).length;
  const close = (out.body.match(/<\/node>/g) || []).length;
  assert.equal(open, close, '标签平衡');
});

test('buildPayload(format=md) 产出 Markdown 大纲', async () => {
  const out = await buildPayload(fakeCtx(), params({ sessionId: 'root', format: 'md' }), {});
  assert.match(out.filename, /\.md$/);
  assert.match(out.body, /^# 会话图谱/);
  assert.match(out.body, /- \*\*问\*\*/);
  assert.match(out.body, /- \*\*答\*\*/);
  /* 正文以缩进块跟在标签后面，而不是拼在同一行 */
  assert.ok(/ {2}- \*\*问\*\*\n\n {4}Q1/m.test(out.body), '「问」下面跟的是缩进正文块');
});

test('buildPayload 尊重 includeHidden', async () => {
  const hidden = JSON.stringify({ 'root:1': true });
  const off = JSON.parse((await buildPayload(fakeCtx(),
    params({ sessionId: 'root', format: 'json', hidden }), {})).body);
  assert.equal(off.stats.blocks, 3);
  assert.equal(off.stats.hiddenSkipped, 1);

  const on = JSON.parse((await buildPayload(fakeCtx(),
    params({ sessionId: 'root', format: 'json', hidden, includeHidden: 'true' }), {})).body);
  assert.equal(on.stats.blocks, 4);
});

/* ------------------------------------------------------------- 路由 */

function captureRoute(over = {}) {
  const registered = [];
  const ctx = fakeCtx({
    connection: { fetch: { register: (opts) => { registered.push(opts); return () => {}; } } },
    ...over
  });
  apply(ctx, { maxBlocks: 3000 });
  return registered[0];
}

test('apply 注册路由，路径与请求体处理方式正确', () => {
  const route = captureRoute();
  assert.equal(route.path, '/api/session.graph-export');
  assert.equal(route.requestBody, 'buffered');
  assert.equal(typeof route.fetch, 'function');
});

test('apply 在没有连接服务时保持静默，不抛错', () => {
  assert.doesNotThrow(() => apply(fakeCtx(), {}));
  assert.doesNotThrow(() => apply({}, {}));
});

test('连接服务缺席时走 ctx.inject 等它，插件本体不卡在 pending', () => {
  /* 关键回归：若把 connection 写进插件级 inject，服务一旦不出现插件永不加载，
     浏览器侧只能看到 404 而无从判断。这里断言走的是 inject 回调这条路。 */
  const registered = [];
  let injected = null;
  const ctx = {
    inject(deps, cb) { injected = { deps, cb }; },
    connection: { fetch: { register: (o) => { registered.push(o); return () => {}; } } }
  };
  apply(ctx, {});
  assert.deepEqual(injected && injected.deps, ['connection'], '用 ctx.inject 等待服务');
  assert.equal(registered.length, 0, '回调尚未触发前不注册');
  injected.cb({ get: (k) => (k === 'connection' ? ctx.connection : undefined) });
  assert.equal(registered.length, 1, '服务到位后注册路由');
  assert.equal(registered[0].path, '/api/session.graph-export');
});

test('宿主没有 ctx.inject 时退回同步注册', () => {
  const registered = [];
  apply({
    connection: { fetch: { register: (o) => { registered.push(o); return () => {}; } } }
  }, {});
  assert.equal(registered.length, 1);
});

test('GET 返回文件内容，并带 RFC 5987 文件名', async () => {
  const route = captureRoute();
  const res = await route.fetch(new Request(
    'http://x/api/session.graph-export?sessionId=root&format=mm', { method: 'GET' }));
  assert.equal(res.status, 200);
  const cd = res.headers.get('content-disposition');
  assert.ok(cd.startsWith('attachment;'), '触发浏览器下载');
  assert.ok(cd.includes("filename*=UTF-8''"), '中文文件名走 filename*');
  const body = await res.text();
  assert.match(body, /^<map/);
});

test('HEAD 只回状态与响应头，没有响应体', async () => {
  const route = captureRoute();
  const res = await route.fetch(new Request(
    'http://x/api/session.graph-export?sessionId=root&format=mm', { method: 'HEAD' }));
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type'));
  const body = await res.text();
  assert.equal(body, '');
});

test('参数错误时返回 4xx 文本，而不是抛到宿主', async () => {
  const route = captureRoute();
  const res = await route.fetch(new Request('http://x/api/session.graph-export'));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /sessionId/);
});

test('json 格式不带 content-disposition，避免误触发下载', async () => {
  const route = captureRoute();
  const res = await route.fetch(new Request(
    'http://x/api/session.graph-export?sessionId=root&format=json'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), null);
});

/* ----------------------------------------------------------- 持久化 */

const settle = () => new Promise((r) => setTimeout(r, 0));

/** 假的存储域设施；`fail` 为真时 open 直接抛（模拟 backend-not-found） */
function fakeStorageDomain(records = new Map(), fail = false) {
  return {
    records,
    open: async () => {
      if (fail) throw new Error('backend-not-found');
      return {
        table: () => ({
          get: (k) => records.get(k),
          put: async (k, v) => { records.set(k, v); },
          delete: async (k) => records.delete(k)
        }),
        close: async () => {}
      };
    }
  };
}

const postBody = (payload) => new Request('http://x/api/session.graph-export', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload)
});

test('路由同时声明 GET / HEAD / POST，且请求体是缓冲型的', () => {
  const route = captureRoute();
  assert.deepEqual(route.methods, ['GET', 'HEAD', 'POST']);
  assert.equal(route.requestBody, 'buffered');
});

test('POST 把增量写进存储域，并回传合并后的状态', async () => {
  const domain = fakeStorageDomain();
  const route = captureRoute({ storageDomain: domain });
  await settle();

  const res = await route.fetch(postBody({
    familyRootId: 'root',
    patch: { hiddenBlocks: ['root:1'], alias: { 'root:2': '别名' } }
  }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.writable, true);
  assert.deepEqual(data.state.hiddenBlocks, ['root:1']);
  assert.deepEqual(data.state.alias, { 'root:2': '别名' });
  assert.equal(domain.records.size, 1, '按家族根分片，只写了一条记录');
});

test('两次 POST 是累加的：清空别名不会带走隐藏标记', async () => {
  const domain = fakeStorageDomain();
  const route = captureRoute({ storageDomain: domain });
  await settle();

  await route.fetch(postBody({ familyRootId: 'root', patch: { hiddenBlocks: ['root:1'] } }));
  const res = await route.fetch(postBody({ familyRootId: 'root', patch: { alias: {} } }));
  const data = await res.json();
  assert.deepEqual(data.state.hiddenBlocks, ['root:1'], '第一次写的还在');
});

test('存档里的隐藏标记真的参与建图 —— 刷新后界面与存档一致', async () => {
  const domain = fakeStorageDomain(new Map([
    ['root', { version: 1, links: [], positions: {}, alias: {}, collapsedSessions: [], hiddenBlocks: ['root:1'] }]
  ]));
  const route = captureRoute({ storageDomain: domain });
  await settle();

  const res = await route.fetch(new Request(
    'http://x/api/session.graph-export?sessionId=root&format=json'));
  const data = await res.json();
  assert.equal(data.stats.hiddenSkipped, 1, '存档里藏了一块');
  assert.equal(data.stats.blocks, 3, '建图时就没把它算进去');
  assert.equal(data.state.hidden['root:1'], true, '状态以客户端形态回传');
  assert.equal(data.writable, true);
});

test('存储域不可用时降级为只读：GET 照常，POST 明确拒绝（§5.3）', async () => {
  const route = captureRoute({ storageDomain: fakeStorageDomain(new Map(), true) });
  await settle();

  const read = await route.fetch(new Request(
    'http://x/api/session.graph-export?sessionId=root&format=json'));
  assert.equal(read.status, 200, '只读模式下读取不受影响');
  assert.equal((await read.json()).writable, false);

  const write = await route.fetch(postBody({ familyRootId: 'root', patch: { hiddenBlocks: ['root:1'] } }));
  assert.equal(write.status, 503);
  assert.equal((await write.json()).writable, false);
});

test('压根没有存储域时同样是只读，而不是报错', async () => {
  const route = captureRoute();
  await settle();
  const res = await route.fetch(new Request(
    'http://x/api/session.graph-export?sessionId=root&format=json'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).writable, false);
});

test('存储域句柄随插件卸载归还：重载后不会以 already-open 卡成永久只读', async () => {
  /* 回归：句柄的生命周期归调用方。不关的话域一直开着、名字一直占着，
     插件重载时 open() 抛 already-open，又被 openStore 吞掉 —— 永久只读。 */
  const records = new Map();
  let openedCount = 0;
  let closedCount = 0;
  const disposers = [];
  const facility = {
    open: async () => {
      openedCount += 1;
      /* 真实设施对同一域名只留一个活句柄：上一个没关就抛 already-open */
      if (closedCount < openedCount - 1) {
        throw Object.assign(new Error("domain 'session_graph' is already open"), { code: 'already-open' });
      }
      return {
        table: () => ({
          get: (k) => records.get(k),
          put: async (k, v) => { records.set(k, v); },
          delete: async (k) => records.delete(k)
        }),
        close: async () => { closedCount += 1; }
      };
    }
  };
  const mount = () => {
    const registered = [];
    apply(fakeCtx({
      connection: { fetch: { register: (o) => { registered.push(o); return () => {}; } } },
      storageDomain: facility,
      effect(cb) { disposers.push(cb()); }
    }), {});
    return registered[0];
  };

  const first = mount();
  await settle();
  const write1 = await first.fetch(postBody({ familyRootId: 'root', patch: { hiddenBlocks: ['root:1'] } }));
  assert.equal(write1.status, 200, '第一次挂载即可写');

  /* 宿主卸载插件时会跑 effect 返回的 disposer */
  disposers.splice(0).forEach((dispose) => dispose());
  assert.equal(closedCount, 1, '域句柄在卸载时被关闭');

  const second = mount();
  await settle();
  const write2 = await second.fetch(postBody({ familyRootId: 'root', patch: { alias: { 'root:2': '二' } } }));
  assert.equal(write2.status, 200, '重载后仍然可写（而不是 already-open 后静默只读）');
  assert.deepEqual(records.get('root').hiddenBlocks, ['root:1'], '上次写的数据还在');
  assert.deepEqual(records.get('root').alias, { 'root:2': '二' });
});

test('未来版本的记录：报不兼容且拒绝覆盖', async () => {
  const future = { version: 99, links: [], positions: {}, alias: {}, hiddenBlocks: [] };
  const domain = fakeStorageDomain(new Map([['root', future]]));
  const route = captureRoute({ storageDomain: domain });
  await settle();

  const read = await route.fetch(new Request(
    'http://x/api/session.graph-export?sessionId=root&format=json'));
  const data = await read.json();
  assert.equal(data.incompatible, true);
  assert.equal(data.writable, false);
  assert.equal(data.state, null);

  const write = await route.fetch(postBody({ familyRootId: 'root', patch: { hiddenBlocks: ['root:1'] } }));
  assert.equal(write.status, 409, '用 409 表示版本冲突，而不是服务不可用');
  assert.deepEqual(domain.records.get('root'), future, '原记录一字未动');
});

test('POST 的坏输入各有明确答复', async () => {
  const route = captureRoute({ storageDomain: fakeStorageDomain() });
  await settle();

  const noJson = await route.fetch(new Request('http://x/api/session.graph-export', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json'
  }));
  assert.equal(noJson.status, 400);

  const noFamily = await route.fetch(postBody({ patch: {} }));
  assert.equal(noFamily.status, 400);
  assert.match(String((await noFamily.json()).reason), /familyRootId/);
});

test('导出文件会带上存档里的手动连线（FR-15）', async () => {
  const domain = fakeStorageDomain(new Map([
    ['root', {
      version: 1,
      positions: {},
      alias: {},
      collapsedSessions: [],
      hiddenBlocks: [],
      links: [{
        id: 'L1', kind: 'link',
        from: { sessionId: 'root', turn: 1 }, to: { sessionId: 'child', turn: 1 },
        label: '因为'
      }]
    }]
  ]));
  const route = captureRoute({ storageDomain: domain });
  await settle();

  const res = await route.fetch(new Request(
    'http://x/api/session.graph-export?sessionId=root&format=mm'));
  const body = await res.text();
  assert.match(body, /<arrowlink DESTINATION="ID_\d+"/, '手动连线导出成箭头链接');
  assert.match(body, /因为/, '连线标签进了根备注');
});

/* ------------------------------------------ 超规模降级（FR-4） */

test('skeletonize 优先保留当前会话，其余降级为骨架块', () => {
  const mk = (sid, turn) => ({
    id: sid + ':' + turn, sessionId: sid, turn,
    prompt: 'P'.repeat(200), response: 'R'.repeat(2000)
  });
  const blocks = [
    ...Array.from({ length: 5 }, (_, i) => mk('root', i + 1)),
    ...Array.from({ length: 5 }, (_, i) => mk('other', i + 1))
  ];
  const r = skeletonize(blocks, 6, { currentId: 'root' });
  assert.deepEqual(r.blocks.filter((b) => !b.skeleton).map((b) => b.id),
    ['root:1', 'root:2', 'root:3', 'root:4', 'root:5', 'other:1'],
    '当前会话全保，再按顺序补');
  assert.equal(r.skeleton, 4);
  /* 骨架块要留轮次号与提问预览 —— 需求明确要求这两样 */
  const sk = r.blocks.find((b) => b.id === 'other:5');
  assert.equal(sk.skeleton, true);
  assert.equal(sk.turn, 5, '轮次号还在');
  assert.equal(sk.prompt.length, SKELETON_PREVIEW + 1, 'clip 会补一个省略号');
  assert.equal(sk.response, '', '回答正文被丢掉 —— 它才是体积大头');
});

test('skeletonize 不超限时一个都不动', () => {
  const blocks = [{ id: 'a:1', sessionId: 'a', turn: 1, prompt: 'p', response: 'r' }];
  const r = skeletonize(blocks, 100, { currentId: 'a' });
  assert.equal(r.skeleton, 0);
  assert.deepEqual(r.blocks, blocks);
  assert.equal(skeletonize(blocks, 0, {}).skeleton, 0, '预算为 0 表示不限制');
});

test('skeletonize 认调用方点名的轮次，好让点击骨架块能把它换回来', () => {
  const mk = (sid, turn) => ({ id: sid + ':' + turn, sessionId: sid, turn, prompt: 'p', response: 'r' });
  const blocks = [
    ...Array.from({ length: 3 }, (_, i) => mk('root', i + 1)),
    ...Array.from({ length: 3 }, (_, i) => mk('other', i + 1))
  ];
  const r = skeletonize(blocks, 4, { currentId: 'root', full: new Set(['other:3']) });
  const kept = r.blocks.filter((b) => !b.skeleton).map((b) => b.id);
  assert.deepEqual(kept, ['root:1', 'root:2', 'root:3', 'other:3'], '点名的排在其余之前');
});

test('轮次明细要跟着一起降级 —— 否则客户端一重建就把正文拉回来了', () => {
  const turns = {
    root: [{ turn: 1, prompt: 'P'.repeat(200), response: 'R'.repeat(2000) }],
    other: [{ turn: 1, prompt: 'Q'.repeat(200), response: 'S'.repeat(2000) }]
  };
  const out = skeletonizeTurns(turns, new Set(['root:1']));
  assert.equal(out.root[0].response, 'R'.repeat(2000), '保留集里的原样不动');
  assert.equal(out.other[0].response, '', '没保留的被清空');
  assert.equal(out.other[0].prompt.length, SKELETON_PREVIEW + 1);
});

test('超上限不再抛 413，而是降级返回并报出骨架块数', async () => {
  const ctx = fakeCtx();
  const out = await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), { maxBlocks: 2 });
  const data = JSON.parse(out.body);
  assert.equal(data.stats.skeleton, 2, '4 块里降了 2 块');
  assert.equal(data.blocks.length, 4, '块一个都没少，只是有的成了骨架');
  assert.equal(data.blocks.filter((b) => b.skeleton).length, 2);
  assert.equal(data.stats.blocks, 4);
});

test('点名 full 参数能把指定的轮次换回完整块', async () => {
  const ctx = fakeCtx();
  const first = JSON.parse((await buildPayload(
    ctx, params({ sessionId: 'root', format: 'json' }), { maxBlocks: 3 })).body);
  const thin = first.blocks.find((b) => b.skeleton);
  assert.ok(thin, '有被降级的块');

  const again = JSON.parse((await buildPayload(
    ctx, params({ sessionId: 'root', format: 'json', full: thin.id }), { maxBlocks: 3 })).body);
  const now = again.blocks.find((b) => b.id === thin.id);
  assert.notEqual(now.skeleton, true, '点名的这一轮拿回了完整数据');
  assert.ok(now.response !== '' || now.prompt !== '', '正文回来了');
});

test('json 之外仍按 413 语义不可达：格式化导出不受预算影响', async () => {
  const ctx = fakeCtx();
  const out = await buildPayload(ctx, params({ sessionId: 'root', format: 'mm' }), { maxBlocks: 2 });
  assert.equal(out.download, true, '导出走原路径，不受块预算影响');
  assert.ok(out.body.includes('<map'), '还是完整的 FreeMind');
});
