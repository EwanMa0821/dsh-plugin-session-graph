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
import fs from 'node:fs';

const { readFileSync } = fs;

/* ------------------------------------------------- 最小浏览器环境 */

const registered = [];
/** window 上的监听器要真的收下来，否则拖拽/连线这类全局手势根本测不到 */
const listeners = new Map();
globalThis.window = {
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { const s = listeners.get(type); if (s) s.delete(fn); },
  __ModuleLoader__: { load(reg) { registered.push(reg); } }
};
/** 派发一个 window 事件 */
const fire = (type, ev) => {
  [...(listeners.get(type) || [])].forEach((fn) => fn(ev || {}));
};
globalThis.document = {
  createElement(tag) { return { tag, href: '', download: '', click() { this.clicked = true; } }; },
  getElementById() { return null; }
};

/* --------------------------------- 最小 React（带 hook 槽位与重渲染） */

let slots = [];
let cursor = 0;
let pass = 0;
/** 渲染后排队的副作用 */
const queued = [];

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
  useEffect(fn, deps) {
    const i = cursor++;
    const prev = slots[i];
    /* 真的比较依赖项：否则「等存档到了再定视口」这类依赖变化的副作用永远不跑，
       桩就会比 React 更宽松，测试也就测不出东西 */
    if (prev && prev.deps && deps && prev.deps.length === deps.length
      && deps.every((d, k) => Object.is(d, prev.deps[k]))) {
      return undefined;
    }
    /* 排队到渲染**结束之后**再执行 —— React 就是这个时序。
       渲染中就跑的话，回调里引用后面才声明的 ref 会踩 TDZ，
       那是桩的毛病，不是组件的毛病。 */
    queued.push({ i, fn, deps, prev });
    return undefined;
  },
  useMemo(fn, deps) {
    const i = cursor++;
    const prev = slots[i];
    if (prev && prev.deps && deps && sameDeps(prev.deps, deps)) return prev.value;
    const value = fn();
    slots[i] = { deps, value };
    return value;
  },
  /* 必须按依赖项记忆 —— 真实 React 里 useCallback([]) 是**稳定标识**。
     若每次都返回新函数，任何以它为依赖的 effect 会每渲染重跑，
     连带把它的清理逻辑（例如「取消待发写入」）也每帧执行一次。 */
  useCallback(fn, deps) {
    const i = cursor++;
    const prev = slots[i];
    if (prev && prev.deps && deps && sameDeps(prev.deps, deps)) return prev.fn;
    slots[i] = { deps, fn };
    return fn;
  },
  useRef(v) { const i = cursor++; if (slots[i] === undefined) slots[i] = { value: { current: v } }; return slots[i].value; }
};

/** 与 React 的依赖比较一致：长度相同且逐项 Object.is */
const sameDeps = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/** 渲染一次；cursor 归零，hook 槽位按调用顺序复用；副作用在渲染后统一执行 */
function render(component, props) {
  cursor = 0;
  queued.length = 0;
  const tree = component(props);
  const batch = queued.splice(0);
  batch.forEach(({ i, fn, deps, prev }) => {
    if (prev && typeof prev.cleanup === 'function') prev.cleanup();
    const cleanup = fn();
    slots[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
  });
  pass += 1;
  return tree;
}
/** 丢弃全部 hook 状态：需要一个"刚挂载"的干净组件时用。
 *  先跑卸载清理 —— 真实 React 卸载时会跑；不跑的话上一个实例的在途 fetch
 *  会落到新实例上把状态覆盖掉，造出来的假象极难查。 */
function resetComponent() {
  slots.forEach((s) => {
    if (s && typeof s.cleanup === 'function') {
      try { s.cleanup(); } catch { /* 清理失败不该影响后续用例 */ }
    }
  });
  slots = [];
  cursor = 0;
  pass = 0;
  queued.length = 0;
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
  /* 只列必需、且产品自身的视图插件也依赖的服务：`workspaces` 这类可选能力的服务一旦缺席，
     插件会永远停在 pending，而客户端 runner 是 `await fiber.await()` 等它落定的 ——
     卡住的是整个壳（见 README「immediately」那条）。 */
  assert.deepEqual(api.inject,
    ['slots', 'sessions', 'uiSession', 'uiConversation', 'uiWorkspace', 'locale']);
  assert.ok(!api.inject.includes('workspaces'), '可选能力的服务不能进 inject');
  assert.equal(typeof api.apply, 'function');
});

test('客户端清单不得声明 immediately：那会把插件塞进壳之前的引导批次', () => {
  /* 宿主把 dsh.client.immediately 的条目编入 **Vite 壳之前**的 bootstrap 批次；
     而客户端 runner 挂载插件时会 await fiber.await()。本插件注入的 uiConversation /
     uiSession / uiWorkspace 都由**非 immediately** 的视图插件提供、要等壳起来之后才存在，
     于是 fiber 永远落不定 → 壳被卡死：窗口画得出来，但完全不可交互、也没有任何标签。
     产品里只有基础设施包（api-gateway / client-locale / ui-renderer 等 10 个）声明它，
     61 个视图插件一个都没声明。 */
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dsh.client.immediately, undefined, 'immediately 只能由基础设施包声明');
  assert.equal(pkg.dsh.client.platform, 'web');
});

/* --------------------------------------------------- 假宿主与假数据 */

const source = (value) => ({ getSnapshot: () => value, subscribe: () => () => {} });

/** 可变的源：测语言切换要用（切了之后订阅者要收到通知） */
const mutableSource = (initial) => {
  let value = initial;
  const subs = new Set();
  return {
    getSnapshot: () => value,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    set(next) { value = next; [...subs].forEach((fn) => fn()); }
  };
};

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
const postCalls = [];
/** 宿主对 GET 的答复；各用例可临时改写（持久化相关的用例都跑在后面） */
let serverReply = { turns: REMOTE_TURNS, rootId: 'root', state: null, writable: true, incompatible: false };

globalThis.fetch = (url, init) => {
  fetchCalls.push(String(url));
  if (init && init.method === 'POST') {
    postCalls.push(JSON.parse(init.body));
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, writable: true }) });
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => serverReply });
};

const blankState = (over = {}) => ({
  version: 1, hidden: {}, alias: {}, positions: {},
  viewport: null, collapsedSessions: [], links: [], ...over
});

const viewRegistry = { definition: null };

function fakeCtx() {
  const ctx = {
    /* 记下插件在 effect 作用域里注册了什么（NFR-4） */
    effects: [],
    effect(fn, label) {
      const dispose = fn();
      this.effects.push({ label, dispose: typeof dispose === 'function' ? dispose : null });
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    slots: {
      owner: null, options: null, Component: null,
      inject(owner, cb) { this.owner = owner; return cb(); },
      register(options, Component) { this.options = options; this.Component = Component; return () => {}; }
    },
    uiConversation: {
      views: { register(d) { viewRegistry.definition = d; } },
      binding() { return { target: () => source({ timeline: ctx.timeline || TIMELINE }) }; }
    },
    sessions: {
      list: source({ byId: Object.fromEntries(FAMILY.map((s) => [s.id, { ...s, sessionId: s.id }])) }),
      fork(opts) { ctx.forked = opts; return Promise.resolve(); },
      /* FR-7：新建无历史会话；默认成功并回一个新 id，用例可改写 */
      create(opts) {
        ctx.created = opts;
        if (ctx.createFails) return Promise.reject(new Error('配额不足'));
        return Promise.resolve(ctx.createResult || 'fresh-session');
      }
    },
    uiWorkspace: {
      openSession(id) { ctx.opened = id; }
    },
    locale: (() => {
      const src = mutableSource({ active: 'zh' });
      return {
        getSnapshot: () => src.getSnapshot(),
        subscribe: (fn) => src.subscribe(fn),
        set: (next) => src.set(next),
        registered: [],
        register(ns, dicts) { this.registered.push({ ns, dicts }); },
        /* 复刻宿主 LocaleService.resolveText：按回退链解析，最后落到 en */
        resolveText(text) {
          if (typeof text === 'string') return text;
          if (!text || typeof text !== 'object') return '';
          const active = String(src.getSnapshot().active || '').toLowerCase();
          const parts = active ? active.split('-') : [];
          const chain = [];
          for (let i = parts.length; i > 0; i -= 1) chain.push(parts.slice(0, i).join('-'));
          for (const loc of chain) {
            if (typeof text[loc] === 'string' && text[loc] !== '') return text[loc];
          }
          return typeof text.en === 'string' ? text.en : '';
        }
      };
    })(),
    workspaces: {
      list: source({ items: [{ workspaceId: 'ws-1', sessionIds: ['root', 'ancor', 'invest'] }] })
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

/* openView / viewRequest 由 ui-slots 在渲染时注入，不是 inject 的产物；
   这里手动补上，才能测到 FR-14 的视图切换。 */
const viewOpens = [];
const slotKit = () => ({
  openView: (view, focus) => { viewOpens.push({ view, focus }); },
  viewRequest: null,
  completeViewRequest: () => {},
  bindDraftMirror: () => () => {}
});

const props = { ...ctx.slots.options.inject('root'), ...slotKit() };

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
  const paths = nodes.filter((n) => n.type === 'path' && typeof n.props.d === 'string'
    && n.props.d.startsWith('M') && n.props['data-sg-edge'] !== undefined);
  assert.ok(paths.length >= 2, '至少两条派生边，实际 ' + paths.length);
  paths.forEach((p) => assert.match(p.props.d, /^M/));
  assert.ok(nodes.some((n) => n.type === 'marker' && n.props.id === 'sg-arrow-solid'),
    '有实心箭头 marker');
  assert.ok(nodes.some((n) => n.type === 'marker' && n.props.id === 'sg-arrow-hollow'),
    '有空心箭头 marker（引用边用）');
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

/* ----------------------------------------------------- 详情面板的布局 */

/** 选中一个块，返回随后的渲染树 */
function selectBlock(id) {
  const tree = render(ctx.slots.Component, props);
  const wrap = elements(tree).find((n) => typeof n.props.className === 'string'
    && n.props.className.includes('sg-canvas-wrap'));
  wrap.props.onMouseDown({
    button: 0, clientX: 1, clientY: 1,
    target: { closest: (sel) => (sel === '[data-sg-node]' ? { getAttribute: () => id } : null) },
    preventDefault: () => {}
  });
  return render(ctx.slots.Component, props);
}

test('详情面板：元信息与操作固定在顶部，只有正文区滚动', async () => {
  /* 回归：正文排在前面时，长正文会把元信息与操作永远挤出可视区 */
  resetComponent();
  render(ctx.slots.Component, props);
  await tick();
  render(ctx.slots.Component, props);        /* 让远程轮次落地，invest:2 才存在 */
  const after = selectBlock('invest:2');
  const side = elements(after).find((n) => n.props && n.props.className === 'sg-side');
  assert.ok(side, '有右栏');
  const classes = [].concat(side.props.children || []).map((k) => k && k.props && k.props.className);
  assert.deepEqual(classes, ['sg-side-hd', 'sg-side-meta', 'sg-side-acts', 'sg-side-bd'],
    '固定区在前、滚动区在后');

  const css = String(elements(after).find((n) => n.type === 'style').props.children);
  assert.match(css, /\.sg-side-bd\{[^}]*overflow-y:auto/, '正文区是唯一的滚动容器');
  assert.match(css, /\.sg-side-meta\{[^}]*flex:0 0 auto/, '元信息不参与拉伸');
  assert.match(css, /\.sg-side-acts\{[^}]*flex:0 0 auto/, '操作不参与拉伸');
  assert.match(css, /\.sg-side\{flex:0 0 clamp\(/, '右栏宽度随窗口伸缩但有上下界');
});

test('块上的提问行不会退化成轮次号', () => {
  /* 轮次号已经在 sg-hd 里；sg-ask 再兜底显示一遍就是肉眼可见的重复 */
  const tree = render(ctx.slots.Component, props);
  const block = elements(tree).find((n) => n.props && n.props['data-sg-node'] === 'root:1');
  const ask = [].concat(block.props.children || []).find((c) => c && typeof c.props.className === 'string'
    && c.props.className.includes('sg-ask'));
  /* 当前会话是本地与远程的合并结果，本地那份更新，所以这里看到本地文本 */
  assert.equal(ask.props.children, '本地最新提问', '有提问时显示提问本身');
  assert.ok(!/^第 \d+ 轮$/.test(String(ask.props.children)));

  const bundle = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.ok(!bundle.includes("|| '第 ' + b.turn + ' 轮'"), '提问为空时不再兜底成轮次号');
  assert.ok(bundle.includes('（该轮提问尚未载入）'), '改用明确的占位文案');
});

/* ----------------------------------------------------------- 持久化 */

/** 挂载一次并等存档落地；副作用会在下一轮渲染才落到树上，所以要多渲染一轮 */
async function mountLoaded(p) {
  const use = p || props;
  resetComponent();
  render(ctx.slots.Component, use);
  await tick();
  render(ctx.slots.Component, use);
  return render(ctx.slots.Component, use);
}

test('存档里的隐藏与别名在加载时就生效', async () => {
  serverReply = {
    ...serverReply,
    state: blankState({ hidden: { 'root:2': true }, alias: { 'root:1': '被我改过' } })
  };
  try {
    const tree = await mountLoaded();
    const ids = elements(tree).filter((n) => n.props && n.props['data-sg-node'])
      .map((n) => n.props['data-sg-node']);
    assert.ok(!ids.includes('root:2'), '存档里藏起来的块不该出现在画布上');

    const block = elements(tree).find((n) => n.props && n.props['data-sg-node'] === 'root:1');
    const ask = [].concat(block.props.children || []).find((c) => typeof c.props.className === 'string'
      && c.props.className.includes('sg-ask'));
    assert.equal(ask.props.children, '✎ 被我改过', '别名优先于提问原文');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('存档里的视口被恢复，而不是重新适应视图', async () => {
  serverReply = {
    ...serverReply,
    state: blankState({ viewport: { zoom: 1.7, panX: 123, panY: 45 } })
  };
  try {
    const tree = await mountLoaded();
    const zoom = elements(tree).find((n) => n.props && n.props.className === 'sg-zoom');
    assert.equal(zoom.props.children, '170%', '用的是存档里的缩放，不是 fitView 的结果');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('隐藏一块会节流写回宿主，载荷是持久形态', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const before = postCalls.length;
  try {
    render(ctx.slots.Component, props);
    await tick();
    render(ctx.slots.Component, props);
    const after = selectBlock('root:2');
    const hide = elements(after).find((n) => n.props && n.props.className === 'sg-act'
      && String(n.props.children).includes('隐藏此块'));
    assert.ok(hide, '找得到隐藏按钮');
    hide.props.onClick();

    await new Promise((r) => setTimeout(r, 520));   /* 等过节流窗口 */
    assert.equal(postCalls.length, before + 1, '只提交了一次 —— 视口没被用户动过就不该写');
    const sent = postCalls[postCalls.length - 1];
    assert.equal(sent.familyRootId, 'root', '按家族根分片');
    assert.deepEqual(sent.patch.hiddenBlocks, ['root:2'], '提交的是持久形态');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('只读模式下显示标记，且一个字节都不写回', async () => {
  serverReply = { ...serverReply, state: null, writable: false };
  const before = postCalls.length;
  try {
    const tree = await mountLoaded();
    const ro = elements(tree).find((n) => n.props && n.props.className === 'sg-ro');
    assert.ok(ro, '工具条上有只读标记');

    const after = selectBlock('root:2');
    const hide = elements(after).find((n) => n.props && n.props.className === 'sg-act'
      && String(n.props.children).includes('隐藏此块'));
    hide.props.onClick();
    await new Promise((r) => setTimeout(r, 520));
    assert.equal(postCalls.length, before, '只读时不该发 POST');
  } finally {
    serverReply = { ...serverReply, state: null, writable: true };
  }
});

test('存档版本不兼容时明确说明，而不是悄悄只读', async () => {
  serverReply = { ...serverReply, state: null, writable: false, incompatible: true };
  try {
    const tree = await mountLoaded();
    const ro = elements(tree).find((n) => n.props && n.props.className === 'sg-ro');
    assert.match(String(ro.props.children), /不兼容/);
    assert.match(String(ro.props.title), /更新的版本/);
  } finally {
    serverReply = { ...serverReply, state: null, writable: true, incompatible: false };
  }
});

/* ------------------------------------------------------------- 连线 */

const canvasOf = (tree) => elements(tree).find((n) => typeof n.props.className === 'string'
  && n.props.className.includes('sg-canvas-wrap'));

/** 造一个画布上的 mousedown：closest 的行为按真实选择器分派 */
const press = (tree, opts) => canvasOf(tree).props.onMouseDown({
  button: 0, clientX: opts.x === undefined ? 10 : opts.x, clientY: opts.y === undefined ? 10 : opts.y,
  target: {
    closest(sel) {
      if (sel.includes('.sg-tools')) return null;
      if (opts.handle && sel === '[data-sg-link-handle]') return { getAttribute: () => opts.handle };
      if (opts.node && sel === '[data-sg-node]') return { getAttribute: () => opts.node };
      return null;
    }
  },
  preventDefault() {}
});

const releaseOver = (nodeId) => fire('mouseup', {
  target: {
    closest: (sel) => (sel === '[data-sg-node]' && nodeId ? { getAttribute: () => nodeId } : null)
  }
});

const nodeEl = (tree, id) => elements(tree).find((n) => n.props && n.props['data-sg-node'] === id);

test('从把手拖到另一个块即建立连线，并写回宿主', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const before = postCalls.length;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    assert.ok(nodeEl(tree, 'root:1').props.children.some((c) => c && c.props
      && c.props['data-sg-link-handle'] === 'root:1'), '块上有连线把手');

    const badge = elements(tree).find((n)=>n.props&&n.props.className==='sg-ro');
    press(tree, { handle: 'root:1' });
    tree = render(ctx.slots.Component, props);
    assert.ok(canvasOf(tree).props.className.includes('sg-linking'), '进入连线态');

    fire('mousemove', { clientX: 320, clientY: 240, preventDefault() {} });
    tree = render(ctx.slots.Component, props);
    const preview = elements(tree).find((n) => n.props && n.props.className === 'sg-e-preview');
    assert.ok(preview, '拖拽时有预览线');
    assert.match(preview.props.d, /^M/);

    releaseOver('ancor:1');
    tree = render(ctx.slots.Component, props);
    assert.ok(!canvasOf(tree).props.className.includes('sg-linking'), '松手后退出连线态');

    await new Promise((r) => setTimeout(r, 520));
    const sent = postCalls.slice(before).find((p) => p.patch.links);
    assert.ok(sent, '连线提交到宿主');
    assert.equal(sent.patch.links[0].kind, 'link');
    assert.deepEqual(sent.patch.links[0].from, { sessionId: 'root', turn: 1 }, '提交的是持久形态');
    assert.deepEqual(sent.patch.links[0].to, { sessionId: 'ancor', turn: 1 });
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('松手落在空白处即取消，不产生连线', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const before = postCalls.length;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    press(tree, { handle: 'root:1' });
    render(ctx.slots.Component, props);
    releaseOver(null);
    tree = render(ctx.slots.Component, props);
    assert.ok(!canvasOf(tree).props.className.includes('sg-linking'));

    await new Promise((r) => setTimeout(r, 520));
    assert.equal(postCalls.slice(before).filter((p) => p.patch.links).length, 0);
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('把块连到它自己会被拒绝并提示', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const before = postCalls.length;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    press(tree, { handle: 'root:1' });
    render(ctx.slots.Component, props);
    releaseOver('root:1');
    tree = render(ctx.slots.Component, props);
    const toast = elements(tree).find((n) => typeof n.props.children === 'string'
      && n.props.children.includes('不能把一个块连到它自己'));
    assert.ok(toast, '给出了自环提示');

    await new Promise((r) => setTimeout(r, 520));
    assert.equal(postCalls.slice(before).filter((p) => p.patch.links).length, 0, '没有写入');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('「连接到…」：点一次按钮、再点目标块即完成', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const before = postCalls.length;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    const after = selectBlock('root:1');
    const btn = elements(after).find((n) => n.props && n.props.className === 'sg-act'
      && String(n.props.children).includes('连接到…'));
    assert.ok(btn, '详情面板有「连接到…」');
    btn.props.onClick();

    tree = render(ctx.slots.Component, props);
    assert.ok(canvasOf(tree).props.className.includes('sg-linking'), '进入点击式连线态');
    const hint = elements(tree).find((n) => n.props && n.props.className === 'sg-hint');
    assert.match(String(hint.props.children), /点击另一个块完成连线/);

    press(tree, { node: 'ancor:2' });
    render(ctx.slots.Component, props);
    await new Promise((r) => setTimeout(r, 520));
    const sent = postCalls.slice(before).find((p) => p.patch.links);
    assert.ok(sent);
    assert.deepEqual(sent.patch.links[0].to, { sessionId: 'ancor', turn: 2 });
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('Esc 取消连线态', async () => {
  serverReply = { ...serverReply, state: blankState() };
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    press(tree, { handle: 'root:1' });
    tree = render(ctx.slots.Component, props);
    assert.ok(canvasOf(tree).props.className.includes('sg-linking'));

    fire('keydown', { key: 'Escape' });
    tree = render(ctx.slots.Component, props);
    assert.ok(!canvasOf(tree).props.className.includes('sg-linking'), 'Esc 之后回到常态');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('连线后弹出标签输入框，Enter 写入标签', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const before = postCalls.length;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    press(tree, { handle: 'root:1' });
    render(ctx.slots.Component, props);
    releaseOver('ancor:1');
    tree = render(ctx.slots.Component, props);

    const input = elements(tree).find((n) => n.props && n.props.className === 'sg-linkdraft-in');
    assert.ok(input, '建完连线就弹出标签输入框');

    input.props.onChange({ target: { value: '结论建立在这上面' } });
    tree = render(ctx.slots.Component, props);
    const again = elements(tree).find((n) => n.props && n.props.className === 'sg-linkdraft-in');
    again.props.onKeyDown({ key: 'Enter', stopPropagation() {} });
    tree = render(ctx.slots.Component, props);
    assert.ok(!elements(tree).some((n) => n.props && n.props.className === 'sg-linkdraft'),
      '确认后浮层消失');

    await new Promise((r) => setTimeout(r, 520));
    const sent = postCalls.slice(before).filter((p) => p.patch.links).pop();
    assert.equal(sent.patch.links[0].label, '结论建立在这上面');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

/* ------------------------------------------------------- 重命名与撤销 */

/** 挂载、选中一个块、点「重命名」，返回（含输入框的）渲染树 */
async function openRename(blockId) {
  resetComponent();
  render(ctx.slots.Component, props);
  await tick();
  render(ctx.slots.Component, props);
  const selectedTree = selectBlock(blockId);
  const btn = elements(selectedTree).find((n) => n.props && n.props.className === 'sg-act'
    && String(n.props.children).includes('重命名'));
  assert.ok(btn, '详情面板有重命名按钮');
  btn.props.onClick();
  return render(ctx.slots.Component, props);
}

const textIn = (tree) => {
  const out = [];
  (function walk(node) {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    if (typeof node !== 'object') return;
    if (node.type) { walk(node.props && node.props.children); return; }
  })(tree);
  return out.join(' | ');
};

test('重命名写入别名，图谱上带 ✎ 前缀', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const before = postCalls.length;
  try {
    let tree = await openRename('root:1');
    const input = elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-rename-in'));
    assert.ok(input, '弹出重命名输入框');

    input.props.onChange({ target: { value: '先做需求文档' } });
    tree = render(ctx.slots.Component, props);
    const again = elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-rename-in'));
    again.props.onKeyDown({ key: 'Enter', stopPropagation() {} });
    tree = render(ctx.slots.Component, props);

    assert.ok(!elements(tree).some((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-rename-in')), '确认后输入框收起');
    const block = elements(tree).find((n) => n.props && n.props['data-sg-node'] === 'root:1');
    assert.match(textIn(block), /✎ 先做需求文档/, '别名优先于自动标题');

    await new Promise((r) => setTimeout(r, 520));
    const sent = postCalls.slice(before).find((p) => p.patch.alias);
    assert.ok(sent, '别名写回宿主');
    assert.equal(sent.patch.alias['root:1'], '先做需求文档');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('别名留空即恢复自动标题', async () => {
  serverReply = { ...serverReply, state: blankState({ alias: { 'root:1': '旧名' } }) };
  try {
    let tree = await openRename('root:1');
    const input = elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-rename-in'));
    assert.equal(input.props.value, '旧名', '输入框预填当前别名');
    input.props.onChange({ target: { value: '   ' } });
    tree = render(ctx.slots.Component, props);
    elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-rename-in'))
      .props.onKeyDown({ key: 'Enter', stopPropagation() {} });
    tree = render(ctx.slots.Component, props);

    const block = elements(tree).find((n) => n.props && n.props['data-sg-node'] === 'root:1');
    assert.ok(!textIn(block).includes('✎'), '回到自动标题');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('撤销能逐步回退：重命名 → 隐藏', async () => {
  serverReply = { ...serverReply, state: blankState() };
  try {
    /* 第一步：重命名 root:1 */
    let tree = await openRename('root:1');
    const input = elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-rename-in'));
    input.props.onChange({ target: { value: '第一步' } });
    tree = render(ctx.slots.Component, props);
    elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-rename-in'))
      .props.onKeyDown({ key: 'Enter', stopPropagation() {} });
    tree = render(ctx.slots.Component, props);

    /* 第二步：把 root:2 藏起来 */
    tree = selectBlock('root:2');
    elements(tree).find((n) => n.props && n.props.className === 'sg-act'
      && String(n.props.children).includes('隐藏此块')).props.onClick();
    tree = render(ctx.slots.Component, props);
    assert.ok(!elements(tree).some((n) => n.props && n.props['data-sg-node'] === 'root:2'),
      'root:2 已从画布上消失');

    const undoBtn = () => elements(tree).find((n) => n.props && n.props.className === 'sg-btn'
      && String(n.props.children).includes('撤销'));
    assert.equal(undoBtn().props.disabled, false, '有可撤销的操作');

    /* 撤销一次：隐藏被回退 */
    undoBtn().props.onClick();
    tree = render(ctx.slots.Component, props);
    assert.ok(elements(tree).some((n) => n.props && n.props['data-sg-node'] === 'root:2'),
      'root:2 回来了');
    const block = elements(tree).find((n) => n.props && n.props['data-sg-node'] === 'root:1');
    assert.match(textIn(block), /✎ 第一步/, '重命名还在');

    /* 再撤销一次：重命名被回退 */
    elements(tree).find((n) => n.props && n.props.className === 'sg-btn'
      && String(n.props.children).includes('撤销')).props.onClick();
    tree = render(ctx.slots.Component, props);
    assert.ok(!textIn(elements(tree).find((n) => n.props && n.props['data-sg-node'] === 'root:1'))
      .includes('✎'), '别名也回退了');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('撤销新建的连线时显式上报删除，而不是整表覆盖', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const before = postCalls.length;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    press(tree, { handle: 'root:1' });
    render(ctx.slots.Component, props);
    releaseOver('ancor:1');
    tree = render(ctx.slots.Component, props);

    const link = elements(tree).find((n) => n.props && String(n.props['data-sg-edge'] || '').startsWith('link:'));
    assert.ok(link, '连线已建立');

    elements(tree).find((n) => n.props && n.props.className === 'sg-btn'
      && String(n.props.children).includes('撤销')).props.onClick();
    tree = render(ctx.slots.Component, props);
    assert.ok(!elements(tree).some((n) => n.props
      && String(n.props['data-sg-edge'] || '').startsWith('link:')), '连线被撤销掉');

    await new Promise((r) => setTimeout(r, 520));
    const sent = postCalls.slice(before).find((p) => p.patch.removeLinkIds);
    assert.ok(sent, '删除按 id 上报');
    assert.match(sent.patch.removeLinkIds[0], /^link:root:1->ancor:1:/);
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('Ctrl+Z 与工具条按钮等价；没得撤销时按钮禁用', async () => {
  serverReply = { ...serverReply, state: blankState() };
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    const undoBtn = () => elements(tree).find((n) => n.props && n.props.className === 'sg-btn'
      && String(n.props.children).includes('撤销'));
    assert.equal(undoBtn().props.disabled, true, '一开始没有可撤销的');

    /* 藏一块，制造一步历史 */
    tree = selectBlock('root:2');
    elements(tree).find((n) => n.props && n.props.className === 'sg-act'
      && String(n.props.children).includes('隐藏此块')).props.onClick();
    tree = render(ctx.slots.Component, props);
    assert.equal(undoBtn().props.disabled, false);

    canvasOf(tree).props.onKeyDown({ key: 'z', ctrlKey: true, preventDefault() {} });
    tree = render(ctx.slots.Component, props);
    assert.ok(elements(tree).some((n) => n.props && n.props['data-sg-node'] === 'root:2'),
      'Ctrl+Z 撤销了隐藏');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('Esc 取消重命名且不写入', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const before = postCalls.length;
  try {
    let tree = await openRename('root:1');
    const input = elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-rename-in'));
    input.props.onChange({ target: { value: '不要这个' } });
    fire('keydown', { key: 'Escape' });
    tree = render(ctx.slots.Component, props);
    assert.ok(!elements(tree).some((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-rename-in')), '输入框收起');
    assert.ok(!textIn(tree).includes('不要这个'), '没有写进去');

    await new Promise((r) => setTimeout(r, 520));
    assert.equal(postCalls.slice(before).filter((p) => p.patch.alias).length, 0);
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

/* ------------------------------------------------------- 手动布局 FR-5 */

test('拖块移动：过程只改本地坐标，松手才落盘', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const before = postCalls.length;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    const x0 = nodeEl(tree, 'root:1').props.style.left;

    press(tree, { node: 'root:1', x: 100, y: 100 });
    tree = render(ctx.slots.Component, props);
    /* 缩放不为 1 时位移要换算回世界坐标，所以只断言方向与"动了" */
    fire('mousemove', { clientX: 220, clientY: 180, preventDefault() {} });
    tree = render(ctx.slots.Component, props);
    const xLive = nodeEl(tree, 'root:1').props.style.left;
    assert.ok(xLive > x0, '拖动过程中块跟着指针走');
    assert.equal(nodeEl(tree, 'root:1').props.style.top > 0, true, '纵向同样动了');

    /* 拖动中不该落盘 */
    await new Promise((r) => setTimeout(r, 520));
    assert.equal(postCalls.slice(before).filter((p) => p.patch.positions).length, 0, '过程里不写');

    fire('mouseup', {});
    tree = render(ctx.slots.Component, props);
    assert.equal(nodeEl(tree, 'root:1').props.style.left, xLive, '松手后停在原地');

    await new Promise((r) => setTimeout(r, 520));
    const sent = postCalls.slice(before).find((p) => p.patch.positions);
    assert.ok(sent, '松手写入自有布局');
    assert.deepEqual(sent.patch.positions['root:1'], { x: xLive, y: nodeEl(tree, 'root:1').props.style.top });
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('拖块不牵动同会话其它块', async () => {
  serverReply = { ...serverReply, state: blankState() };
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    const other0 = nodeEl(tree, 'root:2').props.style.top;

    press(tree, { node: 'root:1', x: 100, y: 100 });
    render(ctx.slots.Component, props);
    fire('mousemove', { clientX: 200, clientY: 260, preventDefault() {} });
    render(ctx.slots.Component, props);
    fire('mouseup', {});
    tree = render(ctx.slots.Component, props);

    assert.equal(nodeEl(tree, 'root:2').props.style.top, other0, '邻居一动不动');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('拖空白仍然是平移，且不动任何块坐标', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const before = postCalls.length;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    const world0 = elements(tree).find((n) => n.props && n.props.className === 'sg-world')
      .props.style.transform;
    const block0 = nodeEl(tree, 'root:1').props.style.left;

    press(tree, { x: 400, y: 300 });          /* 不落在任何块上 */
    render(ctx.slots.Component, props);
    fire('mousemove', { clientX: 460, clientY: 300, preventDefault() {} });
    tree = render(ctx.slots.Component, props);

    const worldNow = elements(tree).find((n) => n.props && n.props.className === 'sg-world')
      .props.style.transform;
    assert.notEqual(worldNow, world0, '视口平移了');
    assert.equal(nodeEl(tree, 'root:1').props.style.left, block0, '块坐标没被碰');

    fire('mouseup', {});
    render(ctx.slots.Component, props);
    await new Promise((r) => setTimeout(r, 520));
    assert.equal(postCalls.slice(before).filter((p) => p.patch.positions).length, 0);
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('拖动后撤销能回到原位', async () => {
  serverReply = { ...serverReply, state: blankState() };
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    const x0 = nodeEl(tree, 'root:1').props.style.left;
    const y0 = nodeEl(tree, 'root:1').props.style.top;

    press(tree, { node: 'root:1', x: 100, y: 100 });
    render(ctx.slots.Component, props);
    fire('mousemove', { clientX: 260, clientY: 240, preventDefault() {} });
    render(ctx.slots.Component, props);
    fire('mouseup', {});
    tree = render(ctx.slots.Component, props);
    assert.notEqual(nodeEl(tree, 'root:1').props.style.left, x0, '确实挪过');

    elements(tree).find((n) => n.props && n.props.className === 'sg-btn'
      && String(n.props.children).includes('撤销')).props.onClick();
    tree = render(ctx.slots.Component, props);
    assert.equal(nodeEl(tree, 'root:1').props.style.left, x0, '撤销回到原位');
    assert.equal(nodeEl(tree, 'root:1').props.style.top, y0);
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('存档里的块坐标在加载时就生效（FR-5 验收 1）', async () => {
  serverReply = { ...serverReply, state: blankState({ positions: { 'root:1': { x: 640, y: 12 } } }) };
  try {
    const tree = await mountLoaded();
    assert.equal(nodeEl(tree, 'root:1').props.style.left, 640, '重开后位置保持');
    assert.equal(nodeEl(tree, 'root:1').props.style.top, 12);
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('点边标签即选中该连线，可改标签也可删除', async () => {
  serverReply = {
    ...serverReply,
    state: blankState({
      links: [{ id: 'L1', kind: 'link', from: 'root:1', to: 'ancor:1', label: '因为' }]
    })
  };
  const before = postCalls.length;
  try {
    let tree = await mountLoaded();
    const label = elements(tree).find((n) => n.props && n.props.className === 'sg-elabel');
    assert.ok(label, '边标签画在画布上');
    assert.equal(label.props.children, '因为');
    label.props.onClick({ stopPropagation() {} });

    tree = render(ctx.slots.Component, props);
    const side = elements(tree).find((n) => n.props && n.props.className === 'sg-side');
    const plain = JSON.stringify(side.props.children.map((k) => k && k.props && k.props.className));
    assert.match(plain, /sg-side-acts/, '右栏切成了连线面板');

    const del = elements(tree).find((n) => n.props && typeof n.props.className === 'string'
      && n.props.className.includes('sg-danger'));
    assert.ok(del, '有删除按钮');
    del.props.onClick();
    await new Promise((r) => setTimeout(r, 520));

    const sent = postCalls.slice(before).find((p) => p.patch.removeLinkIds);
    assert.deepEqual(sent.patch.removeLinkIds, ['L1'], '删除按 id 上报，而不是整表覆盖');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

/* ------------------------------------------------- 规模降级（NFR-1） */

/** 用某个会话作为当前会话渲染（当前会话影响骨架档的取舍） */
const propsFor = (sid) => ({ ...ctx.slots.options.inject(sid), ...slotKit() });

const classCount = (tree, frag) => elements(tree).filter((n) => typeof n.props.className === 'string'
  && n.props.className.includes(frag)).length;

test('密集档：省略块内正文与边标签，并明说降级原因', async () => {
  serverReply = {
    ...serverReply,
    turns: {
      root: turnsOf('第', 900),
      ancor: turnsOf('锚定', 3),
      invest: turnsOf('投资', 2)
    },
    state: blankState({
      links: [{ id: 'L1', kind: 'link', from: 'root:1', to: 'root:2', label: '因为' }]
    })
  };
  try {
    const tree = await mountLoaded();
    const blocks = elements(tree).filter((n) => n.props && n.props['data-sg-node']);
    assert.ok(blocks.length > 800, '块确实超过阈值：' + blocks.length);
    assert.equal(classCount(tree, 'sg-ans'), 0, '不画块内回答');
    assert.equal(classCount(tree, 'sg-elabel'), 0, '不画边标签');
    assert.ok(classCount(tree, 'sg-ask') > 0, '提问行还在，块仍然认得出是哪一轮');
    assert.match(textIn(tree), /已省略块内正文与边标签/, '把降级原因说出来');
  } finally {
    serverReply = { ...serverReply, state: null, turns: REMOTE_TURNS };
  }
});

test('骨架档：非当前会话只出会话头，可就地展开', async () => {
  serverReply = {
    ...serverReply,
    turns: {
      root: turnsOf('根会话第', 3100),
      ancor: turnsOf('锚定', 3),
      invest: turnsOf('投资', 2)
    },
    state: blankState()
  };
  try {
    const props2 = propsFor('invest');
    resetComponent();
    render(ctx.slots.Component, props2);
    await tick();
    let tree = render(ctx.slots.Component, props2);

    const shown = () => elements(tree).filter((n) => n.props && n.props['data-sg-node'])
      .map((n) => n.props['data-sg-node']);
    assert.ok(shown().includes('invest:1'), '当前会话的块照常画');
    assert.equal(shown().some((id) => id.startsWith('root:')), false, '巨大的祖先会话不画块');
    assert.ok(classCount(tree, 'sg-label') >= 3, '三个会话头都在，骨架没断');
    assert.match(textIn(tree), /只画分叉骨架与当前会话/, '把降级原因说出来');

    const chevron = elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-expand'));
    assert.ok(chevron, '非当前会话的头上给展开入口');
    assert.equal(chevron.props.children, '▸');

    chevron.props.onClick({ stopPropagation() {} });
    tree = render(ctx.slots.Component, props2);
    const after = elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-expand'));
    assert.equal(after.props.children, '▾', '展开后标记翻转');
    assert.ok(elements(tree).filter((n) => n.props && n.props['data-sg-node'])
      .some((n) => n.props['data-sg-node'].startsWith('root:')), '展开后该会话的块出来了');
  } finally {
    serverReply = { ...serverReply, state: null, turns: REMOTE_TURNS };
  }
});

/* ----------------------------------------- 引用式新建会话（FR-7） */

const refButton = (tree) => elements(tree).find((n) => n.props && n.props.className === 'sg-act'
  && String(n.props.children).includes('新建引用式会话'));

test('新建引用式会话：建会话、记引用边、切过去', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const before = postCalls.length;
  delete ctx.created;
  delete ctx.opened;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    const btn = refButton(selectBlock('root:1'));
    assert.ok(btn, '详情面板有「新建引用式会话」');
    btn.props.onClick();
    await new Promise((r) => setTimeout(r, 20));      /* 等新建的 await 链走完 */
    tree = render(ctx.slots.Component, props);

    assert.deepEqual(ctx.created, { workspaceId: 'ws-1' }, '按当前会话所属工作区新建');
    assert.equal(ctx.opened, 'fresh-session', '创建后切到新会话');
    assert.match(textIn(tree), /已新建引用式会话/);

    await new Promise((r) => setTimeout(r, 520));
    const sent = postCalls.slice(before).find((p) => p.patch.links);
    assert.ok(sent, '引用边写回宿主');
    const link = sent.patch.links[0];
    assert.equal(link.kind, 'reference', '记的是引用边，不是手动边');
    assert.deepEqual(link.from, { sessionId: 'root', turn: 1 }, '起点是源块');
    assert.deepEqual(link.to, { sessionId: 'fresh-session' }, '终点是**整个新会话**（它还没有轮次）');
  } finally {
    serverReply = { ...serverReply, state: null };
    delete ctx.createFails;
  }
});

test('新建会话失败时提示，且**不**留下孤立引用记录', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const before = postCalls.length;
  ctx.createFails = true;
  delete ctx.opened;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    refButton(selectBlock('root:1')).props.onClick();
    await new Promise((r) => setTimeout(r, 20));
    tree = render(ctx.slots.Component, props);

    assert.match(textIn(tree), /新建会话失败/, '把失败说出来');
    assert.equal(ctx.opened, undefined, '没有切走');
    await new Promise((r) => setTimeout(r, 520));
    assert.equal(postCalls.slice(before).filter((p) => p.patch.links).length, 0,
      '失败时不写引用记录 —— 需求里点名的失败行为');
  } finally {
    delete ctx.createFails;
    serverReply = { ...serverReply, state: null };
  }
});

test('找不到工作区时直接说明，不去猜', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const savedWs = ctx.workspaces;
  ctx.workspaces = { list: source({ items: [] }) };
  const before = postCalls.length;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    refButton(selectBlock('root:1')).props.onClick();
    await new Promise((r) => setTimeout(r, 20));
    tree = render(ctx.slots.Component, props);
    assert.match(textIn(tree), /找不到这个会话所属的工作区/);
    await new Promise((r) => setTimeout(r, 520));
    assert.equal(postCalls.slice(before).filter((p) => p.patch.links).length, 0);
  } finally {
    ctx.workspaces = savedWs;
    serverReply = { ...serverReply, state: null };
  }
});

/* ------------------------------- 跨会话跳转与定位（FR-14） */

const wsSource = (archived) => source({
  items: [{ workspaceId: 'ws-1', sessionIds: ['root', 'ancor', 'invest'] }],
  archivedSessionIds: archived || []
});

test('定位该轮：本会话内切到对话视图，并如实说明不能自动滚动', async () => {
  serverReply = { ...serverReply, state: blankState() };
  viewOpens.length = 0;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    const btn = elements(selectBlock('root:1')).find((n) => n.props && n.props.className === 'sg-act'
      && String(n.props.children).includes('在对话视图中定位该轮'));
    assert.ok(btn, '详情面板有定位入口');
    btn.props.onClick();
    tree = render(ctx.slots.Component, props);

    assert.deepEqual(viewOpens.map((v) => v.view), ['transcript-view'], '切到对话视图');
    assert.equal(viewOpens[0].focus, undefined,
      '**不传 focus** —— 对话视图不认它，传了就是造一个假入口');
    assert.match(textIn(tree), /无法自动滚动，请找第 1 轮/, '把能力缺口说出来');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('定位该轮：跨会话时先切会话，挂载后再切视图', async () => {
  serverReply = { ...serverReply, state: blankState() };
  viewOpens.length = 0;
  delete ctx.opened;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    const btn = elements(selectBlock('ancor:1')).find((n) => n.props && n.props.className === 'sg-act'
      && String(n.props.children).includes('在对话视图中定位该轮'));
    btn.props.onClick();
    tree = render(ctx.slots.Component, props);
    assert.equal(ctx.opened, 'ancor', '先切到目标会话');
    assert.equal(viewOpens.length, 0, '此时视图还没挂出来，不能急着切');

    /* 目标会话的视图挂出来之后，待办才执行 */
    const target = propsFor('ancor');
    tree = render(ctx.slots.Component, target);
    assert.deepEqual(viewOpens.map((v) => v.view), ['transcript-view'], '挂载后补上切视图');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('归档会话的会话头可点击被禁用，并说明原因', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const saved = ctx.workspaces;
  ctx.workspaces = { list: wsSource(['invest']) };
  delete ctx.opened;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    const tree = render(ctx.slots.Component, props);
    const head = elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-label')
      && String(n.props.className).includes('sg-unavailable'));
    assert.ok(head, '归档会话拿到禁用样式');
    assert.equal(head.props.onClick, undefined, '点了也没有处理函数');
    assert.equal(head.props['aria-disabled'], 'true');
    assert.match(String(head.props.title), /已归档，无法切换/);

    /* 没归档的照常可点 */
    const normal = elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-label') && n.props.className.includes('sg-current'));
    assert.equal(typeof normal.props.onClick, 'function');
  } finally {
    ctx.workspaces = saved;
    serverReply = { ...serverReply, state: null };
  }
});

test('切换会话失败时提示，且不改变当前会话', async () => {
  serverReply = { ...serverReply, state: blankState() };
  const saved = ctx.uiWorkspace;
  ctx.uiWorkspace = { openSession() { throw new Error('载体不可连'); } };
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    const head = elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-label') && !n.props.className.includes('sg-current')
      && typeof n.props.onClick === 'function');
    head.props.onClick();
    tree = render(ctx.slots.Component, props);
    assert.match(textIn(tree), /切换会话失败：载体不可连/, '把原因说出来');
    const cur = elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-current'));
    assert.ok(cur, '当前会话保持不变');
  } finally {
    ctx.uiWorkspace = saved;
    serverReply = { ...serverReply, state: null };
  }
});

/* ---------------------------- 空态 / 加载态 / 错误态（FR-13） */

const turnAt = (n, prompt, response, status) => ({
  turn: n, startSeq: n * 10, endSeq: n * 10 + 8,
  prompt, response, status: status || 'done', toolCalls: 0, deliverables: 0
});
const NO_TIMELINE = { turnOrder: [], turns: new Map() };

const statePane = (tree) => elements(tree).find((n) => typeof n.props.className === 'string'
  && n.props.className.includes('sg-state'));

test('首次装配中显示骨架屏，不是空白', async () => {
  serverReply = { ...serverReply, state: blankState(), turns: { root: [], ancor: [], invest: [] } };
  ctx.timeline = NO_TIMELINE;
  try {
    const p = propsFor('root');
    resetComponent();
    const tree = render(ctx.slots.Component, p);      /* 不等取数回来 */
    const pane = statePane(tree);
    assert.ok(pane, '有加载态');
    assert.ok(pane.props.className.includes('sg-skel'), '是骨架屏');
    assert.ok(elements(tree).some((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-skel-line')), '有占位线条');
  } finally {
    serverReply = { ...serverReply, state: null, turns: REMOTE_TURNS };
    ctx.timeline = TIMELINE;
  }
});

test('空家族显示空态，并提供「去对话视图开始提问」', async () => {
  serverReply = { ...serverReply, state: blankState(), turns: { root: [], ancor: [], invest: [] } };
  ctx.timeline = NO_TIMELINE;
  viewOpens.length = 0;
  try {
    const tree = await mountLoaded(propsFor('root'));
    const pane = statePane(tree);
    assert.ok(pane, '有空态');
    assert.match(textIn(pane), /还没有可显示的轮次/);
    const btn = elements(pane).find((n) => n.props && n.props.className.includes('sg-btn')
      && String(n.props.children).includes('去对话视图开始提问'));
    assert.ok(btn, '给了下一步入口，而不是只说"没有数据"');
    btn.props.onClick();
    assert.deepEqual(viewOpens.map((v) => v.view), ['transcript-view']);
  } finally {
    serverReply = { ...serverReply, state: null, turns: REMOTE_TURNS };
    ctx.timeline = TIMELINE;
  }
});

test('装配失败时视图区域显示错误态，可重试且其余功能不受影响', async () => {
  /* 核心层写得很防御，喂坏数据并不会抛；要触发「装配整体失败」这条兜底路径，
     得让它在建模途中真的炸掉 —— 用一个读属性就抛的 Proxy 当会话条目。 */
  const bomb = new Proxy({}, {
    get() { throw new Error('会话列表读取失败'); },
    ownKeys() { throw new Error('会话列表读取失败'); }
  });
  const savedList = ctx.sessions.list;
  ctx.sessions.list = source({ byId: { root: bomb } });
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);

    const pane = statePane(tree);
    assert.ok(pane, '有错误态');
    assert.ok(pane.props.className.includes('sg-state-err'));
    assert.match(textIn(pane), /图谱没能装配起来/);
    assert.match(textIn(pane), /会话列表读取失败/, '把原因原样带出来');
    assert.ok(elements(tree).some((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-side')), '右栏还在 —— 没有整页白屏');
    assert.ok(elements(tree).some((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-tools')), '工具条还在');

    /* 重试：换回好的数据，点重试要真的重新取数并恢复 */
    ctx.sessions.list = savedList;
    const callsBefore = fetchCalls.length;
    elements(pane).find((n) => n.props && n.props.className.includes('sg-btn')
      && String(n.props.children).includes('重试')).props.onClick();
    await tick();
    tree = render(ctx.slots.Component, props);
    assert.ok(fetchCalls.length > callsBefore, '重试真的重新取数了');
    /* 会话列表换成了新对象，useSource 要重新订阅并拉一次快照 —— 再渲染一次才看得到 */
    tree = render(ctx.slots.Component, props);
    assert.equal(statePane(tree), undefined, '恢复后不再显示错误态');
    assert.ok(elements(tree).some((n) => n.props && n.props['data-sg-node']), '块回来了');
  } finally {
    ctx.sessions.list = savedList;
    serverReply = { ...serverReply, state: null, ok: true, status: 200 };
  }
});

test('部分块数据不可读：该块降级、其余正常，图角报数', async () => {
  ctx.timeline = NO_TIMELINE;
  serverReply = {
    ...serverReply,
    state: blankState(),
    turns: {
      root: [
        turnAt(1, '正常的提问', '正常的回答'),
        turnAt(2, '', ''),                      /* 读不出来 */
        turnAt(3, '又一个正常提问', '回答')
      ],
      ancor: [],
      invest: []
    }
  };
  try {
    const tree = await mountLoaded(propsFor('root'));
    const thin = elements(tree).filter((n) => typeof (n.props && n.props.className) === 'string'
      && n.props.className.includes('sg-node-thin'));
    assert.equal(thin.length, 1, '只有读不出来的那一块降级');
    assert.equal(thin[0].props['data-sg-node'], 'root:2');
    assert.match(textIn(thin[0]), /这一轮的内容读不出来/);

    const ok2 = elements(tree).find((n) => n.props && n.props['data-sg-node'] === 'root:1');
    assert.match(textIn(ok2), /正常的提问/, '其余块照常');
    assert.equal(elements(tree).some((n) => n.props && n.props['data-sg-node'] === 'root:3'), true);

    const corner = elements(tree).find((n) => n.props && n.props.className === 'sg-corner');
    assert.ok(corner, '图角有说明');
    assert.match(String(corner.props.children), /1 个块数据不完整/);
  } finally {
    serverReply = { ...serverReply, state: null, turns: REMOTE_TURNS };
  }
});

test('还在进行中的轮次不算"数据不完整"', async () => {
  serverReply = {
    ...serverReply,
    state: blankState(),
    turns: {
      root: [turnAt(1, '已经答完', '回答'), { ...turnAt(2, '刚发出还没答', ''), status: 'open' }],
      ancor: [], invest: []
    }
  };
  try {
    const tree = await mountLoaded();
    assert.equal(elements(tree).filter((n) => typeof (n.props && n.props.className) === 'string'
      && n.props.className.includes('sg-node-thin')).length, 0, '进行中的轮次不算不完整');
  } finally {
    serverReply = { ...serverReply, state: null, turns: REMOTE_TURNS };
  }
});

/* ------------------------------------------ 未载入轮次（FR-4） */

test('骨架块画成骨架样式，保留轮次号与提问预览', async () => {
  ctx.timeline = NO_TIMELINE;
  serverReply = {
    ...serverReply,
    state: blankState(),
    turns: {
      root: [{ turn: 1, startSeq: 10, endSeq: 18, prompt: '提问预览还在', response: '', status: 'done' }],
      ancor: [], invest: []
    },
    blocks: [{ id: 'root:1', sessionId: 'root', turn: 1, skeleton: true }]
  };
  try {
    const tree = await mountLoaded(propsFor('root'));
    const node = nodeEl(tree, 'root:1');
    assert.ok(node.props.className.includes('sg-node-skel'), '骨架样式');
    assert.match(textIn(node), /第 1 轮/, '轮次号还在');
    assert.match(textIn(node), /提问预览还在/, '提问预览还在');
    assert.match(textIn(node), /点击载入这一轮的完整内容/, '给出下一步动作');

    const corner = elements(tree).find((n) => n.props && n.props.className === 'sg-corner');
    assert.ok(corner, '图角有说明');
    assert.match(String(corner.props.children), /1 个块尚未载入/);
  } finally {
    serverReply = { ...serverReply, state: null, turns: REMOTE_TURNS, blocks: undefined };
    ctx.timeline = TIMELINE;
  }
});

test('点骨架块会把这一轮点名要回来（分页载入）', async () => {
  ctx.timeline = NO_TIMELINE;
  serverReply = {
    ...serverReply,
    state: blankState(),
    turns: {
      root: [{ turn: 1, startSeq: 10, endSeq: 18, prompt: '提问预览还在', response: '', status: 'done' }],
      ancor: [], invest: []
    },
    blocks: [{ id: 'root:1', sessionId: 'root', turn: 1, skeleton: true }]
  };
  let tree;
  try {
    tree = await mountLoaded(propsFor('root'));
    const before = fetchCalls.length;
    press(tree, { node: 'root:1' });
    tree = render(ctx.slots.Component, propsFor('root'));
    await tick();
    tree = render(ctx.slots.Component, propsFor('root'));

    assert.ok(fetchCalls.length > before, '重新取数了');
    const last = String(fetchCalls[fetchCalls.length - 1]);
    assert.match(last, /[?&]full=root%3A1/, '点名带上了这一轮的 id');
  } finally {
    serverReply = { ...serverReply, state: null, turns: REMOTE_TURNS, blocks: undefined };
    ctx.timeline = TIMELINE;
  }
});

test('普通块不会误判成骨架块', async () => {
  serverReply = {
    ...serverReply,
    state: blankState(),
    turns: REMOTE_TURNS,
    blocks: [{ id: 'root:1', sessionId: 'root', turn: 1, skeleton: true }]
  };
  try {
    /* Host 说它是骨架，但本地时间线把正文合并回来了 —— 那就按普通块画 */
    const tree = await mountLoaded(propsFor('root'));
    const node = nodeEl(tree, 'root:1');
    assert.ok(!node.props.className.includes('sg-node-skel'), '有正文就不算骨架');
    assert.ok(!node.props.className.includes('sg-node-thin'), '也不是"数据不完整"');
  } finally {
    serverReply = { ...serverReply, state: null, turns: REMOTE_TURNS, blocks: undefined };
  }
});

/* ------------------------------------------------ 本地化（NFR-3） */

test('把字典登记给宿主的本地化服务', () => {
  const hit = ctx.locale.registered.find((r) => r.ns === 'dsh-plugin-session-graph');
  assert.ok(hit, '登记过本插件的命名空间');
  assert.equal(typeof hit.dicts.zh['view.title'], 'string');
  assert.equal(hit.dicts.en['view.title'], 'Graph');
  assert.equal(Object.keys(hit.dicts.zh).length, Object.keys(hit.dicts.en).length,
    '两种语言的词条数一致');
});

test('默认按中文渲染', async () => {
  ctx.locale.set({ active: 'zh' });
  try {
    const tree = await mountLoaded();
    assert.match(textIn(tree), /适应视图 F/, '工具条是中文');
    assert.match(textIn(tree), /第 1 轮/, '块标题是中文');
  } finally {
    ctx.locale.set({ active: 'zh' });
  }
});

test('语言切成 en 之后界面整体变英文', async () => {
  ctx.locale.set({ active: 'en' });
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    const tree = render(ctx.slots.Component, props);
    const text = textIn(tree);
    assert.match(text, /Fit view \(F\)/, '工具条跟着变');
    assert.match(text, /Turn 1/, '块标题跟着变');
    assert.match(text, /Undo/, '撤销按钮跟着变');
    assert.ok(!/适应视图/.test(text), '不该再出现中文工具条');
    assert.ok(!/第 1 轮/.test(text), '不该再出现中文块标题');
  } finally {
    ctx.locale.set({ active: 'zh' });
  }
});

test('语言变化会就地生效，不需要重新挂载', async () => {
  ctx.locale.set({ active: 'zh' });
  try {
    let tree = await mountLoaded();
    assert.match(textIn(tree), /适应视图 F/);
    ctx.locale.set({ active: 'en' });           /* 通知订阅者 */
    tree = render(ctx.slots.Component, props);
    assert.match(textIn(tree), /Fit view \(F\)/, '同一实例上换语言即生效');
  } finally {
    ctx.locale.set({ active: 'zh' });
  }
});

test('不认识的键不会在界面上留空洞', async () => {
  const tree = await mountLoaded();
  /* 抽查几个主要区域，确认没有 undefined 漏出来 */
  const text = textIn(tree);
  assert.ok(!/undefined/.test(text), '没有 undefined');
  assert.ok(!/\{turn\}|\{n\}|\{msg\}/.test(text), '没有未插值的占位符');
});

/* ------------------------------------- 验收 13 / NFR-4 复核 */

test('切走再回来，选中块还在（验收 13）', async () => {
  serverReply = { ...serverReply, state: blankState() };
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    selectBlock('root:2');
    tree = render(ctx.slots.Component, props);
    assert.ok(nodeEl(tree, 'root:2').props.className.includes('sg-selected'), '先选中');

    /* 模拟切到别处再切回来：组件被卸载重建 */
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    tree = render(ctx.slots.Component, props);
    assert.ok(nodeEl(tree, 'root:2').props.className.includes('sg-selected'),
      '重挂载后选中态恢复');

    /* 清干净，免得影响后面的用例 —— 点空白处才清选中（点同一个块是保持选中） */
    press(tree, { x: 600, y: 500 });
    releaseOver(null);
    tree = render(ctx.slots.Component, props);
    assert.ok(!nodeEl(tree, 'root:2').props.className.includes('sg-selected'), '点空白清掉选中');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('选中的块被隐藏后，详情面板不会拿它去建内容', async () => {
  serverReply = { ...serverReply, state: blankState({ hidden: { 'root:2': true } }) };
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    /* 选中一个已隐藏、因而不在画布上的块，界面要退回空态而不是崩 */
    let tree = render(ctx.slots.Component, props);
    const aside = elements(tree).find((n) => n.props && n.props.className === 'sg-side');
    assert.ok(aside, '右栏照常在');
    assert.ok(!textIn(tree).includes('undefined'), '没有 undefined 漏出来');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

test('字典注册落在 effect 作用域内（NFR-4）', () => {
  assert.ok(Array.isArray(ctx.effects), '假 ctx 记录了 effect');
  assert.ok(ctx.effects.some((e) => typeof e.label === 'string' && e.label.includes('dictionaries')),
    '字典注册包在 ctx.effect 里：' + ctx.effects.map((e) => e.label).join(', '));
});

/* ------------------------------------- 卸载不留残留（验收 22 / NFR-4） */

test('组件卸载后 window 上不留任何监听，待发写入也被取消', async () => {
  serverReply = { ...serverReply, state: blankState() };
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);

    const live = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
    assert.ok(live() > 0, '挂载时确实注册了全局监听');

    /* 造一个待发写入：定时器还挂着 */
    tree = selectBlock('root:1');
    elements(tree).find((n) => n.props && n.props.className === 'sg-act'
      && String(n.props.children).includes('隐藏此块')).props.onClick();
    const postsBefore = postCalls.length;

    resetComponent();                       /* 等价于卸载：会跑所有清理 */
    assert.equal(live(), 0, '卸载后全局监听清零，实际剩 ' + live());

    /* 待发的写入也不该再发出去 */
    await new Promise((r) => setTimeout(r, 520));
    assert.equal(postCalls.length, postsBefore, '卸载后不再写回');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

/* `sessions=` 的用途是把 Host 活跃列表里没有的**家族成员**补进来（例如已归档的父会话），
   不是"请把整个目录读一遍"。报全量会让 Host 侧按家族收敛取数的优化失效 ——
   点一个骨架块又变成重读整库。这条用例专门盯住"只报家族内"。 */
test('sessions= 只报家族内的会话：家族外的会话不该进请求（否则 Host 会读全库）', async () => {
  const savedList = ctx.sessions.list;
  const byId = {
    ...Object.fromEntries(FAMILY.map((s) => [s.id, { ...s, sessionId: s.id }])),
    outsider: { id: 'outsider', title: '别的家族', parentId: null, sessionId: 'outsider' }
  };
  ctx.sessions.list = source({ byId });
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    render(ctx.slots.Component, props);
    const url = fetchCalls[fetchCalls.length - 1];
    assert.match(url, /sessions=root%2Cancor%2Cinvest/, '只报家族内的三个会话');
    assert.ok(!url.includes('outsider'), '家族外的会话不能进 sessions=：' + url);
  } finally {
    ctx.sessions.list = savedList;
  }
});

/* ============================================================================
   回归：这一批是"装完插件整个界面坏掉"以及若干静默失效的直接原因
   ============================================================================ */

test('视图组件外面有兜底：渲染抛错时给出可读的错误卡片，而不是白屏', () => {
  /* 宿主用 renderSlot(..., { only: viewId }) 把 active view 挂进对话根，
     组件一抛错整片视图区就是纯白 —— 标签照常显示，看起来"只是没内容"，
     现场找不到任何线索。这层外壳必须把异常兜成一张卡片。 */
  const safe = ctx.slots.Component;
  assert.equal(typeof safe, 'function');
  /* 触发器要选**组件体内确实没有守卫**的那条路：resolveSessionId 会去问
     props.sessions.current()，它抛错时异常会冒出组件体 —— 正是宿主里那种"白屏"路径。 */
  const boom = {
    sessionId: '',
    ctx: {},
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} }, current() { throw new Error('boom-current'); } }
  };
  let tree;
  assert.doesNotThrow(() => { tree = safe(boom); }, '外壳必须吞掉渲染异常');
  assert.ok(JSON.stringify(tree).includes('会话图谱渲染失败'), '给出兜底卡片');
});

/* 宿主取视图标签时**直接调用**这个 thunk（ui-slots 的 resolveSlotLabel 是
   `typeof label === 'function' ? label() : label`，没有任何兜底），
   而且调用时机与组件无关：注册槽位、**切换会话**（activateView 里又取一次 viewTabs）、
   换语言都会跑。它必须在模块作用域可用 —— 早先写成 `() => t('view.title')`，
   而 t 只活在 GraphView 里，于是宿主一取标签就抛 ReferenceError：切会话切不动、
   输入框也跟着废掉。现有用例只断言了槽位形状，从没调用过 label()，所以没抓到。 */
test('视图标签在模块作用域可解析：宿主取标签不抛错（回归：曾经整个界面被它带崩）', () => {
  const label = ctx.slots.options.label;
  assert.equal(typeof label, 'function');
  assert.doesNotThrow(() => label(), '宿主 resolveSlotLabel 会直接调用它，抛错会打断 activateView');
  assert.equal(label(), '图谱', '默认中文');
  assert.notEqual(label(), 'view.title', '绝不能把键名当文案显示');
});

test('切语言后视图标签跟着变，且仍然不抛错', () => {
  const label = ctx.slots.options.label;
  const before = ctx.locale.getSnapshot().active;
  try {
    ctx.locale.set({ active: 'en' });
    assert.equal(label(), 'Graph');
  } finally {
    ctx.locale.set({ active: before });
  }
  assert.equal(label(), '图谱', '切回来要跟着回来');
});

test('宿主解析器缺席时视图标签退回本地字典，而不是抛错', () => {
  const label = ctx.slots.options.label;
  const savedResolver = ctx.locale.resolveText;
  const before = ctx.locale.getSnapshot().active;
  try {
    delete ctx.locale.resolveText;
    ctx.locale.set({ active: 'en' });
    assert.equal(label(), 'Graph');
  } finally {
    ctx.locale.resolveText = savedResolver;
    ctx.locale.set({ active: before });
  }
});

/* 400ms 防抖窗口里删两条连线时，合并补丁曾用对象展开把前一次的 removeLinkIds
   覆盖掉；而 Host 侧的 links 是按 id 合并的，于是被覆盖掉的那条连线在存档里"复活"。 */
test('防抖窗口内连删两条连线：removeLinkIds 取并集，不能只报最后一条', async () => {
  serverReply = {
    ...serverReply,
    state: blankState({
      links: [
        { id: 'L1', kind: 'link', from: 'root:1', to: 'root:2', label: '甲' },
        { id: 'L2', kind: 'link', from: 'root:1', to: 'root:3', label: '乙' }
      ]
    })
  };
  const before = postCalls.length;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);

    /* 点标签选中边 → 面板里点删除；两次都落在同一个防抖窗口内 */
    const labelOf = (text) => elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-elabel') && n.props.children === text);
    const delBtn = (t) => elements(t).find((n) => n.props && n.props.className === 'sg-act sg-danger');

    labelOf('甲').props.onClick({ stopPropagation() {} });
    tree = render(ctx.slots.Component, props);
    delBtn(tree).props.onClick();
    tree = render(ctx.slots.Component, props);

    labelOf('乙').props.onClick({ stopPropagation() {} });
    tree = render(ctx.slots.Component, props);
    delBtn(tree).props.onClick();

    await new Promise((r) => setTimeout(r, 520));
    const sent = postCalls.slice(before).map((c) => c.patch.removeLinkIds || []).flat();
    assert.deepEqual([...new Set(sent)].sort(), ['L1', 'L2'],
      '两次删除的 id 都要上报，否则被覆盖掉的那条会在存档里复活');
    const last = postCalls[postCalls.length - 1].patch;
    assert.deepEqual(last.links, [], '界面上两条都没了');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

/* 拖会话头是"平移画布"（所有非块节点都走平移），而 mouseup 之后浏览器必补一个 click：
   不加防护时，一拖会话头就顺带把会话切走。块上早就防了，会话头漏了。 */
test('拖会话头平移后不会顺带切换会话', () => {
  resetComponent();
  const tree = render(ctx.slots.Component, props);
  delete ctx.opened;

  /* 取一个**非当前**会话的头（当前会话点了也不会切） */
  const headOf = (t, title) => elements(t).find((n) => typeof n.props.className === 'string'
    && n.props.className.includes('sg-label') && n.props.onClick
    && textsOf(n).some((x) => x.includes(title)));
  const head = headOf(tree, '锚定效应');
  assert.ok(head, '找得到非当前会话的会话头');

  /* 在画布上按下（会话头不是块 → 走平移）、拖过阈值、松手 */
  const wrap = elements(tree).find((n) => typeof n.props.className === 'string'
    && n.props.className.includes('sg-canvas-wrap'));
  wrap.props.onMouseDown({ button: 0, clientX: 100, clientY: 100, target: { closest: () => null }, preventDefault() {} });
  fire('mousemove', { clientX: 160, clientY: 100, preventDefault() {} });
  fire('mouseup', { clientX: 160, clientY: 100, target: { closest: () => null } });

  /* 松手后浏览器补的那一次 click 落在会话头上 */
  head.props.onClick();
  assert.equal(ctx.opened, undefined, '拖出来的那一次 click 不能当成切换会话');

  /* 真正的单击仍然要能切会话 */
  const head2 = headOf(render(ctx.slots.Component, props), '锚定效应');
  head2.props.onClick();
  assert.equal(ctx.opened, 'ancor', '单击照旧切换会话');
});

/* 「折叠其他会话」原先是个死按钮：只改自己的高亮，没有任何渲染读它。
   需求 FR-5 / FR-11：折叠非当前会话的块，只保留会话头与派生边，可就地展开。 */
test('「折叠其他会话」真的折叠：只留会话头与派生边，且可就地展开', async () => {
  serverReply = { ...serverReply, state: blankState() };
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);

    const shown = () => elements(tree).filter((n) => n.props && n.props['data-sg-node'])
      .map((n) => n.props['data-sg-node']);
    assert.equal(shown().length, 10, '默认：家族内全部会话的块都画');

    const btn = elements(tree).find((n) => n.props && typeof n.props.className === 'string'
      && n.props.className.includes('sg-btn') && String(n.props.children).includes('折叠其他会话'));
    btn.props.onClick();
    tree = render(ctx.slots.Component, props);

    const after = shown();
    assert.ok(after.every((id) => id.startsWith('root:')), '只剩当前会话的块：' + after.join(','));
    assert.equal(elements(tree).filter((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-label')).length, 3, '三个会话头都还在，骨架没断');
    assert.ok(elements(tree).some((n) => n.props && n.props['data-sg-edge']), '派生边还在');

    /* 折叠后派生边的终点要退到会话头，不能画到看不见的块上 */
    const drawn = elements(tree).filter((n) => n.props && n.props['data-sg-edge']);
    const nodeIds = new Set(elements(tree).filter((n) => n.props && n.props['data-sg-node'])
      .map((n) => n.props['data-sg-node']));
    assert.ok(nodeIds.size > 0);
    drawn.forEach((p) => assert.ok(typeof p.props.d === 'string' && p.props.d.startsWith('M')));

    /* 会话头上的 ▸ 展开回来 */
    const chev = elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-expand') && n.props.children === '▸');
    assert.ok(chev, '折叠的会话头上有展开入口');
    chev.props.onClick({ stopPropagation() {} });
    tree = render(ctx.slots.Component, props);
    assert.ok(shown().some((id) => id.startsWith('ancor:')), '展开后该会话的块回来了');

    /* 关掉开关：恢复默认全展开 */
    const btn2 = elements(tree).find((n) => n.props && typeof n.props.className === 'string'
      && n.props.className.includes('sg-btn') && String(n.props.children).includes('折叠其他会话'));
    btn2.props.onClick();
    tree = render(ctx.slots.Component, props);
    assert.equal(shown().length, 10, '关掉后回到全展开');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});

/* 没有可用会话 id 时，取数 effect 直接 return，`loaded` 永远是 false，
   而"首次装配中"的判定是 `!loaded && 块数 === 0` —— 界面就一直转，什么都不会发生。 */
test('没有可用会话 id 时不卡在「首次装配中」，而是给出空态', async () => {
  resetComponent();
  const bare = { ...ctx.slots.options.inject(''), ...slotKit() };
  render(ctx.slots.Component, bare);
  await tick();
  const tree = render(ctx.slots.Component, bare);
  assert.ok(!textIn(tree).includes('正在装配'), '不能一直显示装配中');
  assert.ok(textIn(tree).includes('还没有可显示的轮次'), '要给空态，而不是空转：' + textIn(tree).slice(0, 80));
});

/* 编辑连线标签原先每敲一个字符就 remember() + persist()：撤销变成"退一个字符"，
   50 步历史也会被一次输入冲光。改名输入框早就是"先攒后提交"，标签要对齐。 */
test('编辑连线标签：编辑期间不写回，回车后才落一次盘、只占一格撤销', async () => {
  serverReply = {
    ...serverReply,
    state: blankState({ links: [{ id: 'L1', kind: 'link', from: 'root:1', to: 'root:2', label: '甲' }] })
  };
  const before = postCalls.length;
  try {
    resetComponent();
    render(ctx.slots.Component, props);
    await tick();
    let tree = render(ctx.slots.Component, props);
    elements(tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('sg-elabel')).props.onClick({ stopPropagation() {} });
    tree = render(ctx.slots.Component, props);

    const input = elements(tree).find((n) => n.props && n.props.className === 'sg-linkdraft-in sg-wide');
    assert.ok(input, '标签输入框在');
    input.props.onChange({ target: { value: '甲乙' } });
    input.props.onChange({ target: { value: '甲乙丙' } });
    await new Promise((r) => setTimeout(r, 520));
    assert.equal(postCalls.length, before, '编辑期间一个字节都不写');

    const input2 = elements(render(ctx.slots.Component, props))
      .find((n) => n.props && n.props.className === 'sg-linkdraft-in sg-wide');
    input2.props.onKeyDown({ key: 'Enter', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 520));
    assert.equal(postCalls.length, before + 1, '回车只落一次盘');
    const sent = postCalls[postCalls.length - 1].patch.links;
    assert.equal(sent[0].label, '甲乙丙');
  } finally {
    serverReply = { ...serverReply, state: null };
  }
});
