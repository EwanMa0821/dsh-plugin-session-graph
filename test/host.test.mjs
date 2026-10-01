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

import { foldTurns, isHumanTurn, textOf, forkTurnFromChild, linkForks, seedBoundaryOf } from '../src/host/fold.js';
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

/* 子会话 = 从 root 第 3 轮分叉出来的：日志开头是父会话前 13 条事件（seq 0..12）的
   **继承前缀**，自有内容从 seq 13 起，轮次号也接着父会话往下排 —— 所以它自有的
   第一轮是第 2 轮，而第 1 轮（继承来的那份）在图谱上不画：源会话里已经有一份块（FR-8）。
   早先这里把自有轮次写成 seq 0..3，等于"子会话的自有内容落在继承前缀里"，
   与 `inheritedEventCount: 13` 自相矛盾 —— 夹具失真，正是这次修复才照出来的。 */
const CHILD_EVENTS = [
  ev('turn/start', 13, { turn: 2 }),
  ev('user/message', 14, user('子会话提问')),
  ev('assistant/message', 15, assistant('子会话回答')),
  ev('turn/end', 16)
];

/* 带**继承前缀原文**的子会话日志：seq 0..3 是继承来的第 1 轮，seq 4 是
   `session/end-seed`（继承部分到此为止），seq 5 起才是它自己问的第 2 轮。
   形状照真实日志（`session/end-seed` 只带 seq，data 是空对象）。 */
const SEEDED_CHILD_EVENTS = [
  ev('turn/start', 0, { turn: 1 }),
  ev('user/message', 1, user('继承来的提问')),
  ev('assistant/message', 2, assistant('继承来的回答')),
  ev('turn/end', 3),
  ev('session/end-seed', 4),
  ev('turn/start', 5, { turn: 2 }),
  ev('user/message', 6, user('子会话新问的')),
  ev('assistant/message', 7, assistant('子会话新答的')),
  ev('turn/end', 8)
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
      { header: { id: 'child', title: '子会话', parentSession: 'root', inheritedEventCount: 13, isSeeded: true } }
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

test('foldTurns 统计交付物：一轮里两条 deliverables/presented 记 2 个', () => {
  /* 载荷照 `@deepseek-ai/dsh-client-ui-deliverables` 的 isPresentedData 构造：
     `{ turn, callId, files }` —— 里面**没有**标量计数字段。 */
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, user('Q')),
    ev('deliverables/presented', 2, { turn: 1, callId: 'c1', files: [{ path: 'a.txt' }] }),
    ev('deliverables/presented', 3, { turn: 1, callId: 'c2', files: [{ path: 'b.txt' }] }),
    ev('turn/end', 4),
    ev('turn/start', 5, { turn: 2 }),
    ev('turn/end', 6)
  ];
  const turns = foldTurns(events);
  assert.equal(turns[0].deliverables, 2);
  assert.equal(turns[1].deliverables, 0, '没有交付物的轮次仍然是 0');
  /* 回归：以前 deliverables 只在轮次初始化时写 0、从不累加，徽标与详情因此恒为空 */
  assert.ok(foldTurns(ROOT_EVENTS).every((t) => t.deliverables === 0));
});

test('交付物计数一路传到块上：界面的 ⧉ 徽标读的就是 b.deliverables', async () => {
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, user('Q')),
    ev('deliverables/presented', 2, { turn: 1, callId: 'c1', files: [] }),
    ev('turn/end', 3)
  ];
  const ctx = fakeCtx({
    sessionQuery: {
      observeSession: () => Promise.resolve({ events, [Symbol.dispose]() {} })
    }
  });
  const data = JSON.parse((await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), {})).body);
  assert.equal(data.blocks.find((b) => b.id === 'root:1').deliverables, 1);
  assert.equal(data.turns.root[0].deliverables, 1);
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

/* --------------------------------------------------- 继承前缀（FR-8） */

test('继承边界：只看被播种出来的会话；日志里的 session/end-seed 优先，其次才是 header 的继承事件数', () => {
  const seeded = { isSeeded: true };
  assert.equal(seedBoundaryOf(SEEDED_CHILD_EVENTS, seeded), 4, 'seed 那条事件的序号就是边界');
  /* 没有 seed 事件时退回"条数 − 1"，与 forkTurnFromChild 同一口径 */
  assert.equal(seedBoundaryOf(CHILD_EVENTS, { isSeeded: true, inheritedEventCount: 13 }), 12);
  /* 两条线索都没有：判不出来就返回 null，绝不能凭空把轮次当成继承的 */
  assert.equal(seedBoundaryOf(CHILD_EVENTS, { isSeeded: true, inheritedEventCount: 0 }), null);
  assert.equal(seedBoundaryOf(CHILD_EVENTS, { isSeeded: true, inheritedEventCount: null }), null);
  assert.equal(seedBoundaryOf(null, seeded), null);
  assert.equal(seedBoundaryOf([null, 'x', {}], seeded), null, '垃圾输入不抛错');
  /* **没被播种出来的会话一律不判**：源会话日志里也有 session/end-seed（它被分叉的切点），
     拿它当继承边界就会把源会话自己的轮次判成继承的、整轮从图上消失 */
  assert.equal(seedBoundaryOf(SEEDED_CHILD_EVENTS, { isSeeded: false, inheritedEventCount: 13 }), null);
  assert.equal(seedBoundaryOf(SEEDED_CHILD_EVENTS, { inheritedEventCount: 13 }), null, '状态未知同样不判');
});

test('foldTurns 按 session/end-seed 标出继承前缀：继承的 true、自有的 false', () => {
  const turns = foldTurns(SEEDED_CHILD_EVENTS, { isSeeded: true });
  assert.equal(turns.length, 2);
  assert.equal(turns[0].turn, 1);
  assert.equal(turns[0].inherited, true, 'seed 之前的第 1 轮是继承来的');
  assert.equal(turns[0].prompt, '继承来的提问', '标了继承也照样折出内容');
  assert.equal(turns[1].inherited, false,
    'seed 之后的第 2 轮必须是显式 false —— 下游才分得清"自有"与"没判过"');
});

test('源会话日志里的 session/end-seed 不代表它自己继承了内容（回归：整轮对话从图上消失）', () => {
  /* 从某个会话分叉出去时，DSH 会在**源会话**的日志里也打一条 session/end-seed 标出切点。
     源会话自己没有被播种（isSeeded 为假），把那条当继承边界，它的轮次就会被当继承内容
     藏起来 —— 现象是"我那一轮对话丢了"，而那个会话在界面上长得跟空会话一模一样。 */
  const sourceEvents = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, user('我自己的提问')),
    ev('assistant/message', 2, assistant('我自己的回答')),
    ev('turn/end', 3),
    ev('session/end-seed', 4)                    /* 被分叉出去时留下的切点 */
  ];
  const turns = foldTurns(sourceEvents, { isSeeded: false, inheritedEventCount: 22 });
  assert.equal(turns.length, 1);
  assert.equal('inherited' in turns[0], false, '源会话自己的轮次不是继承来的');
  assert.equal(turns[0].prompt, '我自己的提问');
});

test('没有 seed 事件时按继承事件数标继承前缀', () => {
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, user('继承来的提问')),
    ev('turn/end', 3),
    ev('turn/start', 13, { turn: 2 }),
    ev('user/message', 14, user('新问的')),
    ev('turn/end', 16)
  ];
  const turns = foldTurns(events, { isSeeded: true, inheritedEventCount: 13 });
  assert.equal(turns[0].inherited, true);
  assert.equal(turns[1].inherited, false);
  /* 边界判不出来时**一个标记都不写**：不能假称自己判过（否则下游会把它当自有的权威结论） */
  assert.equal('inherited' in foldTurns(events)[0], false);
  assert.equal('inherited' in foldTurns(events, { isSeeded: true })[0], false, '有 isSeeded 但没有条数/seed');
});

test('带继承前缀的子会话：第 1 轮不画，块与派生边都落在自有轮次上', async () => {
  const ctx = fakeCtx({
    sessionQuery: {
      observeSession: (id) => Promise.resolve({
        events: id === 'root' ? ROOT_EVENTS : id === 'child' ? SEEDED_CHILD_EVENTS : [],
        [Symbol.dispose]() {}
      })
    }
  });
  const links = JSON.stringify([{ id: 'Lx', kind: 'link', from: 'root:1', to: 'child:1' }]);
  const data = JSON.parse((await buildPayload(ctx, params({ sessionId: 'root', format: 'json', links }), {})).body);

  assert.deepEqual(data.blocks.map((b) => b.id), ['root:1', 'root:2', 'root:3', 'child:2'],
    '子会话继承来的第 1 轮不在图里');
  assert.equal(data.blocks.find((b) => b.id === 'child:2').index, 1, '会话内序号从 1 起');
  assert.equal(data.blocks.find((b) => b.id === 'child:2').turn, 2, '真实轮次号不变');
  assert.equal(data.stats.inheritedSkipped, 1);
  assert.equal(data.stats.inheritedEdges, 1, '指向继承块的连线不画，但要报出来');
  assert.equal(data.edges.some((e) => e.id === 'Lx'), false);
  const branch = data.edges.find((e) => e.kind === 'branch');
  assert.equal(branch.from, 'root:3', '分叉源仍是源会话第 3 轮');
  assert.equal(branch.to, 'child:2', '终点是子会话首个自有轮次');
  /* 轮次明细里仍然带着标记：客户端首屏用本地时间线建图时要靠它 */
  assert.equal(data.turns.child[0].inherited, true);
});

test('端到端：源会话日志里有分叉切点，它自己的块照画（回归：父会话整轮不见）', async () => {
  const sourceEvents = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, user('我自己的提问')),
    ev('assistant/message', 2, assistant('我自己的回答')),
    ev('turn/end', 3),
    ev('session/end-seed', 4)                 /* 它被分叉出去时留下的切点 */
  ];
  const ctx = fakeCtx({
    sessionQuery: {
      observeSession: (id) => Promise.resolve({
        events: id === 'root' ? sourceEvents : [],
        [Symbol.dispose]() {}
      })
    }
  });
  const data = JSON.parse((await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), {})).body);
  assert.ok(data.blocks.some((b) => b.id === 'root:1'), '源会话自己的那一轮照画');
  assert.equal(data.stats.inheritedSkipped, 0, '它不是被播种出来的，没有"继承内容"这回事');
});

/* ------------------------------------------- 读不到 ≠ 没有轮次（FR-13） */
test('轮次读不到的会话要单独回传，还带上原因，不能与"空会话"混成一个样', async () => {
  const ctx = fakeCtx({
    sessionQuery: {
      observeSession: (id) => (id === 'child'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ events: ROOT_EVENTS, [Symbol.dispose]() {} }))
    }
  });
  const data = JSON.parse((await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), {})).body);
  assert.deepEqual(data.unread.map((u) => u.id), ['child'], '读不到的会话被点名');
  assert.match(data.unread[0].reason, /boom/, '原因一起带上 —— 否则下次还得再猜一轮');
  assert.deepEqual(data.turns.child, [], '它就是空数组 —— 但另外登记了，界面才分得开');
  assert.equal(data.turns.root.length, 3, '读得出来的会话不受影响');
});

test('句柄形状不对（没有 events）同样算没读到，不当成"这个会话没有轮次"', async () => {
  const ctx = fakeCtx({ sessionQuery: { observeSession: () => Promise.resolve({ nope: true }) } });
  const data = JSON.parse((await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), {})).body);
  assert.deepEqual(data.unread.map((u) => u.id).sort(), ['child', 'root']);
  assert.match(data.unread[0].reason, /events/);
});

test('全都读到时不发 unread 字段：不给载荷添噪音', async () => {
  const ctx = fakeCtx();
  const data = JSON.parse((await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), {})).body);
  assert.equal('unread' in data, false);
});

test('全都读到时不发 unread 字段：不给载荷添噪音', async () => {
  const ctx = fakeCtx();
  const data = JSON.parse((await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), {})).body);
  assert.equal('unread' in data, false);
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
  assert.equal(data.edges[0].to, 'child:2');
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

test('导出与画布同一口径：archived= 里点名的会话不进导出文件', async () => {
  const ctx = fakeCtx();
  const withGone = await buildPayload(ctx, params({
    sessionId: 'root', format: 'mm', archived: JSON.stringify(['child'])
  }), {});
  assert.ok(withGone.body.includes('根会话'), '没归档的照常导出');
  assert.ok(!withGone.body.includes('子会话'), '归档的会话不该出现在文件里');
  assert.ok(!withGone.body.includes('子会话提问'), '它的块也不该出现');

  /* 不带这个参数时行为不变（老客户端 / 别的调用方） */
  const plain = await buildPayload(ctx, params({ sessionId: 'root', format: 'mm' }), {});
  assert.ok(plain.body.includes('子会话'), '不传 archived 就照旧全都导出');
});

test('archived= 不是 JSON 数组时返回 400', async () => {
  for (const bad of ['{oops', '{"a":1}']) {
    await assert.rejects(
      () => buildPayload(fakeCtx(), params({ sessionId: 'root', format: 'mm', archived: bad }), {}),
      (e) => e.status === 400,
      `archived=${bad} 应当判参数非法`
    );
  }
});

/* ------------------------------------------------------------------ 标题 */

test('会话标题走 sessionQuery.readTitle：header 里根本没有 title 字段', async () => {
  /* 宿主事实（dsh-session-query 的 readTitle）：标题是 `session/title` 日志事件折出来的，
     会话 header 里**没有** title。以前读 header.title，于是导出里的会话名与文件名恒为原始 id。 */
  const ctx = fakeCtx({
    sessions: { list: () => [{ header: { id: 'root', parentSession: null, inheritedEventCount: 0 } }] },
    sessionQuery: {
      observeSession: fakeObserve,
      readTitle: (id) => Promise.resolve(id === 'root' ? '真标题' : undefined)
    }
  });
  const data = JSON.parse((await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), {})).body);
  assert.equal(data.sessions.find((s) => s.id === 'root').title, '真标题');
  assert.equal(data.blocks[0].sessionTitle, '真标题', '块的会话名跟着一起走');

  const mm = await buildPayload(ctx, params({ sessionId: 'root', format: 'mm' }), {});
  assert.match(mm.filename, /真标题/, '导出文件名也用标题，而不是原始 id');
});

test('readTitle 返回空时标题回落会话 id', async () => {
  /* readTitle 的语义就是"日志里没有标题事件时返回 undefined"，这不是异常 */
  const ctx = fakeCtx({
    sessionQuery: { observeSession: fakeObserve, readTitle: () => Promise.resolve(undefined) }
  });
  const data = JSON.parse((await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), {})).body);
  assert.equal(data.sessions.find((s) => s.id === 'root').title, 'root');
});

test('readTitle 若返回快照对象（api-catalog 的签名）也能取到标题', async () => {
  /* 本版实现返回的是标题字符串，api-catalog 却写着返回 SessionTitleSnapshot ——
     两种都认，绝不能把 "[object Object]" 当成标题写进导出文件。 */
  const ctx = fakeCtx({
    sessionQuery: {
      observeSession: fakeObserve,
      readTitle: () => Promise.resolve({ session: { id: 'root' }, title: '快照标题' })
    }
  });
  const data = JSON.parse((await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), {})).body);
  assert.equal(data.sessions.find((s) => s.id === 'root').title, '快照标题');
});

test('readTitle 抛错时标题回落会话 id，其余字段不受影响', async () => {
  /* 回归：读标题要走日志折叠，会话不存在/日志读不动都会抛 —— 只降级，不让整次取数失败。
     这里夹具的 header 里**有**标题，正是为了钉住"读不到就回落 id"：宿主 header 上没有标题，
     所以回落 id 才是与真实宿主一致的行为。 */
  const ctx = fakeCtx({
    sessionQuery: { observeSession: fakeObserve, readTitle: () => { throw new Error('日志读不动'); } }
  });
  const data = JSON.parse((await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), {})).body);
  assert.equal(data.sessions.find((s) => s.id === 'root').title, 'root');
  assert.equal(data.sessions.find((s) => s.id === 'child').title, 'child');
  assert.equal(data.stats.blocks, 4, '块、边、轮次一点没少');
  assert.equal(data.edges.length, 1);
});

test('宿主没有 readTitle 时不抛错，标题仍旧退回 header 里的值', async () => {
  /* 旧宿主 / 替身没有这个 API 时保持修复前的行为，不因为取不到标题就把数据弄丢 */
  const data = JSON.parse((await buildPayload(fakeCtx(), params({ sessionId: 'root', format: 'json' }), {})).body);
  assert.equal(data.sessions.length, 2);
  assert.equal(data.sessions.find((s) => s.id === 'root').title, '根会话');
  assert.ok(data.sessions.every((s) => typeof s.title === 'string' && s.title !== ''));
});

/* ------------------------------------------------- 取数范围（NFR-2 预算） */

/** 2 轮的独立会话，与 root/child 没有血缘 —— 家族的"外面" */
const OUTSIDE_EVENTS = [
  ev('turn/start', 0, { turn: 1 }),
  ev('user/message', 1, user('外面 Q1')),
  ev('assistant/message', 2, assistant('外面 A1')),
  ev('turn/end', 3),
  ev('turn/start', 4, { turn: 2 }),
  ev('user/message', 5, user('外面 Q2')),
  ev('turn/end', 6)
];

/**
 * 列表里除家族（root → child）外还有一个独立根 outside。
 * 记录每个会话被 observeSession 的次数，用来断言"没读"。
 */
function familyCtx(extraEvents = {}) {
  const seen = [];
  const ctx = {
    sessions: {
      list: () => [
        { header: { id: 'root', parentSession: null, inheritedEventCount: 0 } },
        { header: { id: 'child', parentSession: 'root', inheritedEventCount: 13, isSeeded: true } },
        { header: { id: 'outside', parentSession: null, inheritedEventCount: 0 } }
      ]
    },
    sessionQuery: {
      observeSession: (id) => {
        seen.push(id);
        const events = id === 'root' ? ROOT_EVENTS
          : id === 'child' ? CHILD_EVENTS
            : (extraEvents[id] || []);
        return Promise.resolve({ events, [Symbol.dispose]() {} });
      },
      readTitle: (id) => Promise.resolve(`标题-${id}`)
    }
  };
  return { ctx, seen };
}

test('家族外的会话不读事件，但仍留在会话列表里（血缘判定不变）', async () => {
  /* 回归：以前 list() 里每个会话都 observeSession 一遍，40 会话 × 50 轮时要开 40 个观察句柄、
     回传 1.8 MB 轮次明细，哪怕这次请求只要当前家族。 */
  const { ctx, seen } = familyCtx();
  const out = await readSessions(ctx, [], {}, { currentId: 'root' });
  assert.deepEqual(seen.slice().sort(), ['child', 'root'], '家族内（含后代）照读，家族外一条不读');
  assert.ok(out.sessions.some((s) => s.id === 'outside'),
    '家族外会话仍留在会话列表里 —— familyOf 判定家族根/孤儿/血环看的是整张列表');
  assert.equal(out.turnsBySession.root.length, 3);
  assert.equal(out.turnsBySession.child.length, 1, '家族内的轮次一条不少');
  assert.equal(out.turnsBySession.outside, undefined, '没读过就不建键，免得被当成"读过但没内容"');
});

test('buildPayload 只回传家族范围内的轮次明细', async () => {
  const { ctx, seen } = familyCtx();
  const data = JSON.parse((await buildPayload(ctx, params({ sessionId: 'root', format: 'json' }), {})).body);
  assert.deepEqual(seen.filter((id) => id === 'outside'), [], '没有为家族外会话打开观察句柄');
  assert.equal(data.turns.root.length, 3);
  assert.equal(data.turns.child.length, 1);
  assert.ok(!data.turns.outside, '省下来的就是这份明细');
  assert.equal(data.stats.sessions, 2, '家族数据里只有家族成员');
  assert.ok(data.sessions.some((s) => s.id === 'child'), '后代没有被漏掉');
});

test('被 sessions= 显式点名的家族外会话仍然被读取', async () => {
  const { ctx, seen } = familyCtx({ outside: OUTSIDE_EVENTS });
  const data = JSON.parse((await buildPayload(ctx,
    params({ sessionId: 'root', format: 'json', sessions: 'outside' }), {})).body);
  assert.ok(seen.includes('outside'), '点名的会话必须读');
  assert.equal(data.turns.outside.length, 2, '点名会话的轮次齐全');
  assert.equal(data.turns.root.length, 3, '当前家族照旧');
});

test('sessions= 补齐冷父会话时家族向上延伸，派生边仍落在父会话的块上', async () => {
  /* 客户端用 sessions= 补齐目录里有、但当前不活跃的会话：冷父会话回到列表里，
     familyOf 才能把家族根往上提，子会话的分叉源才有块可挂。
     范围收紧不能把这条路上的祖先排除掉 —— 祖先属于"当前会话的家族"。 */
  const coldTurns = [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, user('冷 Q1')),
    ev('assistant/message', 2, assistant('冷 A1')),
    ev('turn/end', 3),
    ev('turn/start', 4, { turn: 2 }),
    ev('user/message', 5, user('冷 Q2')),
    ev('turn/end', 7)
  ];
  const ctx = {
    sessions: {
      list: () => [{ header: { id: 'current', parentSession: 'cold', inheritedEventCount: 4 } }]
    },
    sessionQuery: {
      observeSession: (id) => Promise.resolve({
        events: id === 'cold' ? coldTurns : [],
        [Symbol.dispose]() {}
      }),
      readTitle: (id) => Promise.resolve(`标题-${id}`)
    }
  };
  const data = JSON.parse((await buildPayload(ctx,
    params({ sessionId: 'current', sessions: 'cold', format: 'json' }), {})).body);
  assert.equal(data.rootId, 'cold', '家族根提到了冷父会话');
  assert.deepEqual(data.order, ['cold', 'current']);
  assert.equal(data.edges.length, 1);
  assert.equal(data.edges[0].from, 'cold:1', '注入的父会话轮次被读到，分叉源才算得出来');
  assert.equal(data.edges[0].to, 'current:empty');
  assert.equal(data.sessions.find((s) => s.id === 'cold').title, '标题-cold');
});

test('被引用连线拉进来的会话仍然读轮次（否则 FR-7 的引用节点会消失）', async () => {
  /* 范围收紧要连"被引用拉进来"的会话一起收进来：buildGraph 会把它们并进 scoped，
     不读轮次它们就成了断裂引用，导出里整个节点都没了。 */
  const { ctx, seen } = familyCtx({ outside: OUTSIDE_EVENTS });
  const links = JSON.stringify([{ id: 'R1', kind: 'reference', from: 'root:1', to: 'header:outside' }]);
  const data = JSON.parse((await buildPayload(ctx,
    params({ sessionId: 'root', format: 'json', links }), {})).body);
  assert.ok(seen.includes('outside'), '被引用拉进来的会话要读');
  assert.ok(data.sessions.some((s) => s.id === 'outside'), '它并进了家族数据');
  const edge = data.edges.find((e) => e.kind === 'reference');
  assert.ok(edge && edge.broken === false, '引用边两端都在，不是断裂边');
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

function captureRoute(over = {}, config = { maxBlocks: 3000 }) {
  const registered = [];
  const ctx = fakeCtx({
    connection: { fetch: { register: (opts) => { registered.push(opts); return () => {}; } } },
    ...over
  });
  apply(ctx, config);
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

test('sessions 超上限是客户端输入错误：返回 400，而不是 503', async () => {
  /* 回归：这个 Error 以前没有 .status，被 respondRead 兜成 503 ——
     一个纯粹的输入错误被说成服务错误，浏览器侧还会照着 5xx 去重试/报障。 */
  const route = captureRoute({}, { maxSessions: 1 });
  const res = await route.fetch(new Request(
    'http://x/api/session.graph-export?sessionId=root&format=json'));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /上限/);

  /* 同一处改动不能把别的语义一起带跑：sessionId 不可读仍然是 404 */
  const missing = await captureRoute().fetch(new Request(
    'http://x/api/session.graph-export?sessionId=nope&format=json'));
  assert.equal(missing.status, 404);
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
        from: { sessionId: 'root', turn: 1 }, to: { sessionId: 'child', turn: 2 },
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

test('只读模式下导出也带上界面上的连线：links 参数（FR-15）', async () => {
  /* 界面上的连线有 400ms 写回防抖，只读模式下更是永不落盘；导出对话框的预览走客户端
     本地 render，于是"预览里有、导出文件里一条都没有"。 */
  const route = captureRoute();        /* 没有 storageDomain → 只读 */
  const links = JSON.stringify([
    { id: 'P1', kind: 'link', from: 'root:1', to: 'child:2', label: '因为' }
  ]);

  const bare = await route.fetch(new Request(
    'http://x/api/session.graph-export?sessionId=root&format=mm'));
  assert.ok(!(await bare.text()).includes('<arrowlink'), '不带参数时确实没有连线可导 —— 这正是缺陷本身');

  const res = await route.fetch(new Request(
    `http://x/api/session.graph-export?sessionId=root&format=mm&links=${encodeURIComponent(links)}`));
  const body = await res.text();
  assert.match(body, /<arrowlink DESTINATION="ID_\d+"/, '参数里的连线导出成箭头链接');
  assert.match(body, /因为/, '连线标签进了根备注');
});

test('links 参数与存档按 id 合并、参数优先，md 导出同样带上', async () => {
  const domain = fakeStorageDomain(new Map([
    ['root', {
      version: 1,
      positions: {},
      alias: {},
      collapsedSessions: [],
      hiddenBlocks: [],
      links: [{
        id: 'L1', kind: 'link',
        from: { sessionId: 'root', turn: 1 }, to: { sessionId: 'child', turn: 2 },
        label: '存档标签'
      }]
    }]
  ]));
  const route = captureRoute({ storageDomain: domain });
  await settle();

  const links = JSON.stringify([
    { id: 'L1', kind: 'link', from: 'root:1', to: 'child:2', label: '参数标签' },
    { id: 'L2', kind: 'link', from: 'root:2', to: 'child:2', label: '新连线' }
  ]);
  const res = await route.fetch(new Request(
    `http://x/api/session.graph-export?sessionId=root&format=md&links=${encodeURIComponent(links)}`));
  const body = await res.text();
  assert.match(body, /参数标签/, '同 id 的条目用参数那条');
  assert.ok(!body.includes('存档标签'), '没有留下第二份');
  assert.match(body, /新连线/, '参数里多出来的连线也带上');

  const rows = body.split('## 手动连线')[1].split('\n').filter((l) => l.startsWith('- `'));
  assert.equal(rows.length, 2, '合并后是两条，不是三条');
});

test('links 参数不是 JSON 数组时返回 400', async () => {
  const route = captureRoute();
  const bad = await route.fetch(new Request(
    'http://x/api/session.graph-export?sessionId=root&format=json&links=%7Boops'));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /links/);

  const notArray = await route.fetch(new Request(
    'http://x/api/session.graph-export?sessionId=root&format=json&links=%7B%22a%22%3A1%7D'));
  assert.equal(notArray.status, 400, '合法 JSON 但不是数组，同样算参数非法');
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
