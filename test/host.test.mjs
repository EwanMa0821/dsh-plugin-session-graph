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
import { apply, buildPayload, readSessions } from '../index.js';

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
  assert.equal(textOf({ content: [{ text: '甲' }, { text: '乙' }] }), '甲 乙');
  assert.equal(textOf({ message: { content: [{ text: '嵌套' }] } }), '嵌套');
  assert.equal(textOf({ content: { nothing: 1 } }), '');
  assert.equal(textOf(null), '');
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

test('buildPayload 超过块数上限返回 413', async () => {
  await assert.rejects(
    () => buildPayload(fakeCtx(), params({ sessionId: 'root', format: 'json' }), { maxBlocks: 2 }),
    (e) => e.status === 413
  );
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
  assert.match(out.body, /- \*\*问\*\*：/);
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

test('apply 注册 GET/HEAD 路由，路径与预检方法正确', () => {
  const route = captureRoute();
  assert.equal(route.path, '/api/session.graph-export');
  assert.deepEqual(route.methods, ['GET', 'HEAD']);
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
