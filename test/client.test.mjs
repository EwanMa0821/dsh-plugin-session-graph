/**
 * 会话图谱 · 客户端产物冒烟测试
 *
 * client.js 是浏览器产物，没法在这里真跑浏览器。这里做的是：
 *   1. 让它在最小 window/document 下装载，确认注册的 id 与 factory 形状正确
 *   2. 用它注册进一个假的 slots / uiConversation，确认「图谱」视图被登记
 *   3. 用一个**带 hook 运行时**的最小 React 真渲染组件，并驱动一次重渲染
 *
 * 第 3 步才是关键：内联后的核心函数少一个、属性名写错一个、状态没接上，这里都会炸。
 *
 * 运行：node test/client.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------- 最小浏览器环境 */

const registered = [];
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  __ModuleLoader__: { load(reg) { registered.push(reg); } }
};
globalThis.document = {
  createElement(tag) { return { tag, href: '', download: '', click() { this.clicked = true; } }; },
  getElementById() { return null; }
};

/* --------------------------------- 最小 React（带 hook 槽位与重渲染） */

let slots = [];
let cursor = 0;
let pass = 0;

function createElement(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } };
}

const React = {
  createElement,
  useState(init) {
    const i = cursor++;
    if (slots[i] === undefined) slots[i] = { value: typeof init === 'function' ? init() : init, pending: undefined };
    const s = slots[i];
    if (s.pending !== undefined) { s.value = s.pending; s.pending = undefined; }
    return [s.value, (next) => { s.pending = typeof next === 'function' ? next(s.value) : next; }];
  },
  useEffect(fn) {
    const i = cursor++;
    if (pass > 0) return undefined;              /* 只在首轮跑副作用 */
    const cleanup = fn();
    if (typeof cleanup === 'function') slots[i] = { cleanup };
    return undefined;
  },
  useMemo(fn) { cursor++; return fn(); },
  useCallback(fn) { cursor++; return fn; },
  useRef(v) { const i = cursor++; if (slots[i] === undefined) slots[i] = { value: { current: v } }; return slots[i].value; }
};

/** 渲染一次；cursor 归零，hook 槽位按调用顺序复用 */
function render(component, props) {
  cursor = 0;
  const tree = component(props);
  pass += 1;
  return tree;
}
/** 丢弃全部 hook 状态：需要一个"刚挂载"的干净组件时用 */
function resetComponent() {
  slots = [];
  cursor = 0;
  pass = 0;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------------------------------- 装载产物 */

await import('../client.js');

test('client.js 以正确的 id 与形状注册进 __ModuleLoader__', () => {
  assert.equal(registered.length, 1, '只注册一次');
  assert.equal(registered[0].id, 'dsh-plugin-session-graph');
  assert.equal(typeof registered[0].factory, 'function');
});

/* 宿主 UI 基础件的最小替身。只保留插件真正用到的两个导出。 */
function fakeExtractMarkdownPlainText(markdown, options = {}) {
  const text = String(markdown === undefined || markdown === null ? '' : markdown).replace(/\r\n?/g, '\n');
  const strip = (s) => s.replace(/[*_`#>|]/g, ' ').replace(/\s+/g, ' ').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (options.mode === 'first-line') return strip(lines[0] || '');
  if (options.mode === 'first-paragraph') {
    const para = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)[0] || '';
    return strip(para);
  }
  return strip(text);
}

/* 组件不在这里渲染：待测组件把它当元素产出，测试直接断言它的 props。 */
function MarkdownText() { return null; }

const primitivesStub = { MarkdownText, extractMarkdownPlainText: fakeExtractMarkdownPlainText };

const api = registered[0].factory((name) => {
  if (name === 'react') return React;
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
  throw new Error('客户端半只允许 react 与宿主 primitives，收到：' + name);
});

test('factory 返回 { inject, apply }', () => {
  assert.deepEqual(api.inject, ['slots', 'sessions', 'uiSession', 'uiConversation']);
  assert.equal(typeof api.apply, 'function');
});

/* --------------------------------------------------- 假宿主与假数据 */

const source = (value) => ({ getSnapshot: () => value, subscribe: () => () => {} });

const FAMILY = [
  { id: 'root', title: '读懂《思考，快与慢》', parentId: null },
  { id: 'ancor', title: '锚定效应能用在谈判里吗', parentId: 'root', forkAtTurn: 3 },
  { id: 'invest', title: '这些偏差在投资里长什么样', parentId: 'ancor', forkAtTurn: 2 }
];

const turnsOf = (prefix, n) => Array.from({ length: n }, (_, i) => ({
  turn: i + 1, startSeq: (i + 1) * 10, endSeq: (i + 1) * 10 + 8,
  prompt: prefix + '第 ' + (i + 1) + ' 问', response: prefix + '第 ' + (i + 1) + ' 答',
  status: 'done', toolCalls: 0, deliverables: 0
}));

/* Host 侧取回的家族轮次 */
/** 3 轮，其中第 2 轮是 Markdown 富文本（表格 + 代码块），用来验证渲染与摘要 */
const MARKDOWN_ANSWER = [
  '结论如下：',
  '',
  '| 层 | 依赖什么 |',
  '|---|---|',
  '| L1 | 自定义视图渲染位 |',
  '| L2 | 读会话 + 分叉 |',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '推荐 **L3 导出** 作为起点。'
].join('\n');

const REMOTE_TURNS = {
  root: turnsOf('远程根会话', 5),
  ancor: turnsOf('锚定', 3),
  invest: [
    { ...turnsOf('投资', 2)[0] },
    { ...turnsOf('投资', 2)[1], prompt: '第 2 问有 **加粗** 与 `行内代码`', response: MARKDOWN_ANSWER }
  ]
};

/* 本地装配器提供的当前会话时间线：只有已载入的两轮，其中第二轮进行中 */
const TIMELINE = {
  turnOrder: ['a', 'b'],
  turns: new Map([
    ['a', { turn: 1, start: { seq: 0 }, end: { seq: 9 }, prompt: '本地最新提问', response: '本地最新回答' }],
    ['b', { turn: 2, start: { seq: 10 }, end: null, prompt: '本地第二轮进行中', response: '' }]
  ])
};

const fetchCalls = [];
globalThis.fetch = (url) => {
  fetchCalls.push(String(url));
  return Promise.resolve({ ok: true, json: async () => ({ turns: REMOTE_TURNS }) });
};

const viewRegistry = { definition: null };

function fakeCtx() {
  const ctx = {
    slots: {
      owner: null, options: null, Component: null,
      inject(owner, cb) { this.owner = owner; return cb(); },
      register(options, Component) { this.options = options; this.Component = Component; return () => {}; }
    },
    uiConversation: {
      views: { register(d) { viewRegistry.definition = d; } },
      binding() { return { target: () => source({ timeline: TIMELINE }) }; }
    },
    sessions: {
      list: source({ byId: Object.fromEntries(FAMILY.map((s) => [s.id, { ...s, sessionId: s.id }])) }),
      fork(opts) { ctx.forked = opts; return Promise.resolve(); }
    }
  };
  return ctx;
}

const ctx = fakeCtx();
api.apply(ctx);

test('apply 把「图谱」登记进 conversation.view 槽位', () => {
  assert.equal(ctx.slots.owner, 'conversation.view');
  assert.equal(ctx.slots.options.name, 'conversation.view');
  assert.equal(ctx.slots.options.id, 'session-graph');
  assert.equal(typeof ctx.slots.options.inject, 'function');
  assert.equal(typeof ctx.slots.Component, 'function');
  assert.ok(ctx.slots.options.order > 0);
});

test('apply 注册了视图数据层，且 builder 契约正确', () => {
  const def = viewRegistry.definition;
  assert.ok(def, '注册了 view target');
  assert.equal(def.target, 'session-graph');
  assert.equal(typeof def.create, 'function');

  const builder = def.create();
  assert.equal(typeof builder.replace, 'function');
  assert.equal(typeof builder.apply, 'function');

  const a = builder.replace({ nodes: [], timeline: TIMELINE, changedTurns: [] });
  assert.equal(a.timeline, TIMELINE);
  const b = builder.apply({ upserts: [], timeline: TIMELINE, changedTurns: [] });
  assert.equal(b, a, '时间线没变时必须返回同一个引用，否则下游每次都重建');
});

/* ------------------------------------------------------- 真渲染 */

/** 递归收集整棵渲染树里的所有 React 元素 */
function elements(tree) {
  const out = [];
  (function walk(node) {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    if (node.type) { out.push(node); walk(node.props && node.props.children); return; }
    Object.values(node).forEach(walk);
  })(tree);
  return out;
}
/** 收集树里所有可读文本 */
function textsOf(tree) {
  const out = [];
  (function walk(node) {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    if (typeof node !== 'object') return;
    if (node.type) { walk(node.props && node.props.children); return; }
    Object.values(node).forEach(walk);
  })(tree);
  return out;
}

const props = ctx.slots.options.inject('root');

test('首轮渲染：本地时间线立即可用，并向 Host 请求家族数据', async () => {
  const first = render(ctx.slots.Component, props);
  await tick();
  const second = render(ctx.slots.Component, props);

  assert.ok(fetchCalls.length >= 1, '向 Host 取了家族数据');
  assert.match(fetchCalls[0], /\/api\/session\.graph-export\?format=json/);
  assert.match(fetchCalls[0], /sessionId=root/);
  assert.match(fetchCalls[0], /sessions=root%2Cancor%2Cinvest/);

  /* 首轮就该有内容（只有当前会话的块），不是空白 */
  const firstBlocks = elements(first).filter((n) => n.props && n.props['data-sg-node']);
  assert.equal(firstBlocks.length, 2, '首轮用本地时间线的 2 轮');

  /* 重渲染后：当前会话取并集（本地 2 轮 ∪ 远程 5 轮 = 5），其余会话来自远程 */
  const blocks = elements(second).filter((n) => n.props && n.props['data-sg-node']);
  assert.equal(blocks.length, 10, '当前会话 5 + 锚定 3 + 投资 2');

  const ids = blocks.map((n) => n.props['data-sg-node']);
  assert.ok(ids.includes('root:5'), '只在远程出现的轮次也要保留，不能被本地覆盖掉');
  assert.ok(ids.includes('root:2'), '只在本地出现的轮次也要保留');

  const texts = textsOf(second);
  assert.ok(texts.some((t) => t.includes('本地最新提问')), '两边都有的轮次用本地文本');
  assert.ok(texts.some((t) => t.includes('远程根会话第 5 问')), '本地缺文本的轮次用远程文本补上');
});

test('渲染树里有工具栏、会话头、派生边与选中态入口', async () => {
  const tree = render(ctx.slots.Component, props);
  const nodes = elements(tree);
  const byClass = (frag) => nodes.filter((n) => typeof n.props.className === 'string'
    && n.props.className.includes(frag));

  assert.equal(byClass('sg-root').length, 1, '根容器');
  assert.equal(byClass('sg-canvas-wrap').length, 1, '画布');
  assert.equal(byClass('sg-tools').length, 1, '工具栏');

  const labels = byClass('sg-btn').map((n) => n.props.children)
    .flat(Infinity).filter((c) => typeof c === 'string');
  ['适应视图 F', '显示已隐藏', '折叠其他会话', '↧ 导出'].forEach((t) => {
    assert.ok(labels.some((x) => x.includes(t)), '工具栏缺按钮：' + t);
  });

  const sessionHeads = byClass('sg-label');
  assert.equal(sessionHeads.length, 3, '三个会话头');
  assert.ok(sessionHeads.some((n) => n.props.className.includes('sg-current')), '当前会话头高亮');

  const svg = nodes.find((n) => n.type === 'svg');
  assert.ok(svg, '有 SVG 边层');
  const paths = (Array.isArray(svg.props.children) ? svg.props.children : [svg.props.children])
    .filter((c) => c && c.type === 'path');
  assert.ok(paths.length >= 2, '至少两条派生边，实际 ' + paths.length);
  paths.forEach((p) => assert.match(p.props.d, /^M/));
});

test('本地时间线覆盖远程的同名会话，进行中的轮次被标出', async () => {
  const tree = render(ctx.slots.Component, props);
  const nodes = elements(tree);
  const texts = textsOf(tree);

  assert.ok(texts.some((t) => t.includes('本地最新提问')), '当前会话用本地时间线');
  assert.ok(texts.some((t) => t.includes('锚定第 1 问')), '其他会话用远程数据');
  assert.ok(!texts.some((t) => t.includes('远程根会话第 1 问')), '本地数据优先，不被远程覆盖');

  const open = nodes.filter((n) => typeof n.props.className === 'string' && n.props.className.includes('sg-open'));
  assert.equal(open.length, 1, '只有一个进行中的块');
});

test('块上带可键盘聚焦与可读标签（NFR-5）', async () => {
  const blocks = elements(render(ctx.slots.Component, props))
    .filter((n) => n.props && n.props['data-sg-node']);
  blocks.forEach((b) => {
    assert.equal(b.props.tabIndex, 0, '可聚焦');
    assert.equal(b.props.role, 'button', '有角色');
    assert.match(b.props['aria-label'], /^第 \d+ 轮：/, '有可读标签');
  });
});

test('双击块会以正确的 atSeq 发起分叉（FR-6）', async () => {
  const tree = render(ctx.slots.Component, props);
  const block = elements(tree).find((n) => n.props && n.props['data-sg-node'] === 'ancor:1');
  assert.ok(block, '找得到锚定第 1 轮');
  block.props.onDoubleClick({ stopPropagation() {} });
  assert.ok(ctx.forked, '调用了 sessions.fork');
  assert.equal(ctx.forked.sessionId, 'ancor');
  assert.equal(ctx.forked.atSeq, 18, '切点取该块的结束边界序号（turnsOf 里 endSeq = n*10+8）');
  assert.equal(ctx.forked.increaseTitle, true);
});

test('进行中的块拒绝分叉', async () => {
  const saved = { ...ctx.forked };
  const tree = render(ctx.slots.Component, props);
  const openBlock = elements(tree).find((n) => n.props && n.props['data-sg-node'] === 'root:2');
  assert.ok(openBlock, '找得到进行中的那一块');
  openBlock.props.onDoubleClick({ stopPropagation() {} });
  assert.deepEqual(ctx.forked, saved, 'fork 没有被再次调用');
});

test('拖空白不会拉出原生选区，但详情面板仍可选中复制', () => {
  /* 回归：只给 .sg-node/.sg-label 写了 user-select:none，
     拖画布空白时浏览器从背后的文字节点起选区，横跨工具栏与输入框拉出一整页蓝色高亮 */
  const tree = render(ctx.slots.Component, props);
  const style = elements(tree).find((n) => n.type === 'style');
  assert.ok(style, '有样式节点');
  const css = String(style.props.children);
  assert.match(css, /\.sg-root\{[^}]*user-select:none/, '根容器不可选中');
  assert.match(css, /\.sg-canvas-wrap\{[^}]*user-select:none/, '画布不可选中');
  assert.match(css, /\.sg-side\{[^}]*user-select:text/, '右栏要能选中，否则提问与回答没法复制');
});

test('画布按下即掐掉默认行为，并立刻选中块', () => {
  render(ctx.slots.Component, props);                 /* 先跑一遍建立 hook 槽位 */
  const tree = render(ctx.slots.Component, props);
  const wrap = elements(tree).find((n) => typeof n.props.className === 'string'
    && n.props.className.includes('sg-canvas-wrap'));
  assert.ok(wrap, '找得到画布');

  let prevented = 0;
  const blockEl = { getAttribute: () => 'root:2' };
  wrap.props.onMouseDown({
    button: 0, clientX: 10, clientY: 10,
    target: { closest: (sel) => (sel === '[data-sg-node]' ? blockEl : null) },
    preventDefault: () => { prevented += 1; }
  });
  assert.equal(prevented, 1, '必须 preventDefault，否则浏览器会起选区');

  const after = render(ctx.slots.Component, props);
  assert.ok(textsOf(after).some((t) => t.includes('本地第二轮进行中')),
    '在按下时选中，不等抬起 —— 双击时手抖一两个像素也不会丢选中');
});

test('右键不进入拖拽状态，也不拦默认行为', () => {
  const tree = render(ctx.slots.Component, props);
  const wrap = elements(tree).find((n) => typeof n.props.className === 'string'
    && n.props.className.includes('sg-canvas-wrap'));
  let prevented = 0;
  wrap.props.onMouseDown({
    button: 2, clientX: 10, clientY: 10,
    target: { closest: () => null },
    preventDefault: () => { prevented += 1; }
  });
  assert.equal(prevented, 0);
});

/* ------------------------------------------------- markdown 渲染与摘要 */

test('块摘要是干净的纯文本，不残留 markdown 标记', () => {
  const tree = render(ctx.slots.Component, props);
  const nodes = elements(tree);
  /* data-sg-node 挂在外层块上，摘要文本是它的子节点 */
  const block = nodes.find((n) => n.props && n.props['data-sg-node'] === 'invest:2');
  assert.ok(block, '找得到那一块');
  const ask = (block.props.children || []).flat(Infinity)
    .find((c) => c && typeof c === 'object' && typeof c.props?.className === 'string'
      && c.props.className.includes('sg-ask'));
  assert.ok(ask, '块里有摘要行');
  assert.equal(ask.props.children, '第 2 问有 加粗 与 行内代码', '** 与 ` 都被摘掉');
  assert.ok(!/\*\*|`/.test(String(ask.props.children)));
});

test('详情面板用宿主的 MarkdownText 渲染全文，且原文换行完整传下去', async () => {
  render(ctx.slots.Component, props);
  await tick();
  const tree = render(ctx.slots.Component, props);

  /* 先选中 invest:2 那块 */
  const wrap = elements(tree).find((n) => typeof n.props.className === 'string'
    && n.props.className.includes('sg-canvas-wrap'));
  const blockEl = { getAttribute: () => 'invest:2' };
  wrap.props.onMouseDown({
    button: 0, clientX: 1, clientY: 1,
    target: { closest: (sel) => (sel === '[data-sg-node]' ? blockEl : null) },
    preventDefault: () => {}
  });
  const after = render(ctx.slots.Component, props);

  const mds = elements(after).filter((n) => n.type === MarkdownText);
  assert.equal(mds.length, 2, '提问与回答各一个 MarkdownText');

  const answer = mds.map((n) => String(n.props.text)).find((t) => t.includes('| 层 |'));
  assert.ok(answer, '回答用 MarkdownText 渲染');
  assert.equal(answer, MARKDOWN_ANSWER, '原文逐字传下去 —— 换行与表格不能在这层被压平');
  assert.ok(answer.includes('```js'), '代码围栏保留');
  assert.equal(mds[0].props.variant, 'compact', '窄面板用紧凑排版');
  assert.ok(mds[0].props.labels && mds[0].props.labels.code, 'labels 必须给，否则宿主组件内部读属性会炸');
  assert.equal(mds[0].props.labels.code.copyLabel, '复制');
});

test('未选中任何块时，画布上不产生富文本开销', () => {
  resetComponent();
  const tree = render(ctx.slots.Component, props);
  assert.ok(elements(tree).some((n) => n.props && n.props['data-sg-node']), '块照常画出来');
  assert.equal(elements(tree).filter((n) => n.type === MarkdownText).length, 0,
    '没有选中项时不该渲染 MarkdownText');
});
