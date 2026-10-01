/**
 * 会话图谱 · 核心逻辑测试
 *
 * 只测纯逻辑（src/core/*）。DSH 运行时接线无法在此验证，
 * 那部分必须在真实宿主里安装后确认（见 README「验证边界」）。
 *
 * 运行：node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRAPH_VERSION, blockId, emptyId, increasedTitle, uniqueTitle, sessionOfId,
  turnsFromTimeline, normalizeSessions, familyOf, buildGraph, plain, clip
} from '../src/core/model.js';
import {
  layout, bounds, edgePath, edgeMidpoint, fitView, moveSelection, curve, orth, DEFAULT_LAYOUT
} from '../src/core/graph.js';
import { toFreeMind, toMarkdown, exportFilename, safeFilename, render } from '../src/core/export.js';
import {
  TIERS, SLOW_LAYOUT_MS, tierOf, tierFeatures, sessionsWithBlocks, timedLayout
} from '../src/core/scale.js';

/* ------------------------------------------------------------------ 夹具 */

const RAW_SESSIONS = [
  { sessionId: 'root',   title: '读懂《思考，快与慢》', parentSessionId: null },
  { sessionId: 'ancor',  title: '锚定效应能用在谈判里吗', parentSessionId: 'root',   forkAtTurn: 3 },
  { sessionId: 'invest', title: '这些偏差在投资里长什么样', parentSessionId: 'ancor', forkAtTurn: 2 },
  { sessionId: 'infl',   title: '和《影响力》是一回事吗', parentSessionId: 'root',   forkAtTurn: 2 }
];

const turn = (n, p, a, extra = {}) => ({
  turn: n, startSeq: n * 10, endSeq: n * 10 + 9,
  prompt: p, response: a, status: 'done', toolCalls: 0, deliverables: 0, ...extra
});

const TURNS = {
  root: [
    turn(1, '我没读过《思考，快与慢》', '整本书围绕一个比喻展开'),
    turn(2, '系统1 和系统2 用例子说明', '看到一张愤怒的脸'),
    turn(3, '系统1 会带来哪些系统性错误', '锚定、可得性、代表性'),
    turn(4, '卡尼曼是谁', '2002 年诺贝尔经济学奖得主'),
    turn(5, '只读三章读哪三章', '第 1 章、第 11–12 章、第 27–28 章')
  ],
  ancor: [
    turn(1, '锚定在谈判里怎么用', '先出价的一方通常占优'),
    turn(2, '有没有被利用的例子', '商家先挂高价再打折'),
    turn(3, '我怎么知道被锚定了', '做反向测试')
  ],
  invest: [
    turn(1, '前景理论怎么解释亏了死扛', '损失厌恶让痛苦约为快感的 2–2.5 倍'),
    turn(2, '损失厌恶和沉没成本是一回事吗', '相关但不相同')
  ],
  infl: [
    turn(1, '和《影响力》有什么重叠', '两本书都在讲自动反应'),
    turn(2, '互惠属于系统1 还是系统2', '几乎完全是系统1')
  ]
};

const graphOf = (over = {}) => buildGraph({
  sessions: normalizeSessions(RAW_SESSIONS),
  turnsBySession: TURNS,
  currentId: 'root',
  ...over
});

/* ------------------------------------------------------------- 模型基础 */

test('plain / clip 去掉标记并折叠空白', () => {
  assert.equal(plain('  <b>加粗</b>\n 文本 '), '加粗 文本');
  assert.equal(clip('一二三四五', 3), '一二三…');
  assert.equal(clip('一二', 5), '一二');
});

test('increasedTitle 半角与全角括号都自增', () => {
  assert.equal(increasedTitle('读懂《思考，快与慢》'), '读懂《思考，快与慢》 (1)');
  assert.equal(increasedTitle('解读 (1)'), '解读 (2)');
  assert.equal(increasedTitle('解读（2）'), '解读（3）');
  assert.equal(increasedTitle(''), ' (1)');
});

test('uniqueTitle 避开已占用的标题', () => {
  assert.equal(uniqueTitle('A', ['A (1)', 'A (2)']), 'A (3)');
  assert.equal(uniqueTitle('A', []), 'A (1)');
});

test('blockId / emptyId 稳定', () => {
  assert.equal(blockId('s1', 3), 's1:3');
  assert.equal(emptyId('s1'), 's1:empty');
});

test('turnsFromTimeline 容忍 Map 与普通对象，并按 turn 升序', () => {
  const map = new Map();
  map.set('b', { turn: 2, end: { seq: 29 }, prompt: 'Q2', response: 'A2' });
  map.set('a', { turn: 1, end: { seq: 19 }, prompt: 'Q1', response: 'A1' });
  const fromMap = turnsFromTimeline({ turnOrder: ['b', 'a'], turns: map });
  assert.deepEqual(fromMap.map((t) => t.turn), [1, 2]);
  assert.equal(fromMap[0].endSeq, 19);
  assert.equal(fromMap[0].status, 'done');

  const fromObj = turnsFromTimeline({ turns: { x: { turn: 1, prompt: 'Q' } } });
  assert.equal(fromObj.length, 1);
  assert.equal(fromObj[0].status, 'open', '缺 end.seq 视为进行中');
});

test('turnsFromTimeline 对空输入与异常输入不抛错', () => {
  assert.deepEqual(turnsFromTimeline(null), []);
  assert.deepEqual(turnsFromTimeline({}), []);
  assert.deepEqual(turnsFromTimeline({ turnOrder: ['x'], turns: new Map() }), []);
});

test('normalizeSessions 同时接受 sessionId/parentSessionId 与 id/parentId', () => {
  const s = normalizeSessions([
    { id: 'a', displayTitle: 'A' },
    { sessionId: 'b', title: 'B', parentSessionId: 'a', forkAtTurn: 2 },
    { id: 'a', title: '重复' }
  ]);
  assert.equal(s.length, 2, '重复 id 去重');
  assert.equal(s[1].parentId, 'a');
  assert.equal(s[1].forkAtTurn, 2);
  assert.equal(s[1].origin, 'session');
});

/* --------------------------------------------------------------- 家族范围 */

test('familyOf 返回从根到全部后代的顺序', () => {
  const f = familyOf(normalizeSessions(RAW_SESSIONS), 'invest');
  assert.equal(f.rootId, 'root');
  assert.deepEqual([...f.order].sort(), ['ancor', 'infl', 'invest', 'root']);
  assert.equal(f.order[0], 'root', '根在最前');
});

test('familyOf 把孤儿降级为根并给出提示，绝不丢节点', () => {
  const sessions = normalizeSessions([
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B', parentId: 'missing', forkAtTurn: 1 }
  ]);
  const f = familyOf(sessions, 'a');
  assert.deepEqual(f.order, ['a']);
  const g = buildGraph({ sessions, turnsBySession: {}, currentId: 'a' });
  assert.ok(g.notes.some((n) => n.includes('父会话已不可见')), '给出孤儿提示');
});

test('familyOf 对血缘成环不无限递归、不丢节点', () => {
  const sessions = normalizeSessions([
    { id: 'a', title: 'A', parentId: 'b' },
    { id: 'b', title: 'B', parentId: 'a' }
  ]);
  const f = familyOf(sessions, 'a');
  assert.ok(f.order.length >= 1, '至少包含当前会话');
  assert.ok(f.order.length <= 2, '不重复展开');
});

test('familyOf 对不存在的当前会话返回空并说明', () => {
  const f = familyOf(normalizeSessions(RAW_SESSIONS), 'nope');
  assert.deepEqual(f.order, []);
  assert.equal(f.rootId, null);
  assert.equal(f.notes.length, 1);
});

/* ------------------------------------------------------------------ 建图 */

test('buildGraph 折叠块并推导派生边', () => {
  const g = graphOf();
  assert.equal(g.version, GRAPH_VERSION);
  assert.equal(g.blocks.length, 12, '5+3+2+2');
  assert.equal(g.edges.length, 3);
  const byId = new Map(g.edges.map((e) => [e.id, e]));
  assert.equal(byId.get('branch:ancor').from, 'root:3');
  assert.equal(byId.get('branch:ancor').to, 'ancor:1');
  assert.equal(byId.get('branch:invest').from, 'ancor:2');
  assert.equal(byId.get('branch:infl').from, 'root:2');
});

test('buildGraph 只为当前会话的块打 current 标记', () => {
  const g = graphOf({ currentId: 'invest' });
  assert.ok(g.blocks.filter((b) => b.current).every((b) => b.sessionId === 'invest'));
  assert.equal(g.blocks.filter((b) => b.current).length, 2);
});

test('buildGraph 隐藏块：默认剔除，includeHidden 时保留并标记', () => {
  const off = graphOf({ hidden: { 'infl:2': true } });
  assert.equal(off.blocks.some((b) => b.id === 'infl:2'), false);
  assert.equal(off.stats.hiddenSkipped, 1);

  const on = graphOf({ hidden: { 'infl:2': true }, includeHidden: true });
  assert.equal(on.blocks.length, 12);
  assert.equal(on.blocks.find((b) => b.id === 'infl:2').hidden, true);
});

test('buildGraph 隐藏端点时整条派生边一并消失（FR-11）', () => {
  const g = graphOf({ hidden: { 'ancor:2': true } });
  assert.equal(g.edges.some((e) => e.id === 'branch:invest'), false);
  assert.equal(g.edges.length, 2);
});

/* ------------------------------------------------------- 手动边与引用边 */

/** 一块一链接的图，方便逐条断言 */
const linkGraph = (links, extra = {}) => buildGraph({
  sessions: normalizeSessions(RAW_SESSIONS),
  turnsBySession: TURNS,
  currentId: 'root',
  links,
  ...extra
});

test('手动连线真的会变成边 —— 存下来却画不出来是早先的缺口', () => {
  const g = linkGraph([{ id: 'L1', kind: 'link', from: 'root:1', to: 'ancor:2', label: '因为' }]);
  const e = g.edges.find((x) => x.id === 'L1');
  assert.ok(e, '连线出现在边集合里');
  assert.equal(e.kind, 'link');
  assert.equal(e.from, 'root:1');
  assert.equal(e.to, 'ancor:2');
  assert.equal(e.label, '因为');
  assert.equal(e.broken, false);
});

test('引用边与手动边是两种 kind，不会被混为一谈', () => {
  const g = linkGraph([
    { id: 'L1', kind: 'link', from: 'root:1', to: 'ancor:1' },
    { id: 'R1', kind: 'reference', from: 'root:2', to: 'ancor:2' }
  ]);
  assert.equal(g.edges.find((x) => x.id === 'L1').kind, 'link');
  assert.equal(g.edges.find((x) => x.id === 'R1').kind, 'reference');
});

test('派生边不会被当成用户数据 —— kind 是 branch', () => {
  const g = linkGraph([]);
  assert.ok(g.edges.every((e) => e.kind === 'branch'), '没给连线时只有派生边');
});

test('自环在建模层就被拒绝', () => {
  const g = linkGraph([{ id: 'L1', kind: 'link', from: 'root:1', to: 'root:1' }]);
  assert.equal(g.edges.some((e) => e.id === 'L1'), false);
});

test('连线任一端点被隐藏时整条边一并隐藏（FR-9 / FR-11）', () => {
  const links = [{ id: 'L1', kind: 'link', from: 'root:1', to: 'ancor:2' }];
  assert.equal(linkGraph(links).edges.some((e) => e.id === 'L1'), true);

  /* 起点被隐藏 */
  assert.equal(linkGraph(links, { hidden: { 'root:1': true } }).edges.some((e) => e.id === 'L1'), false);
  /* 终点被隐藏 —— 早先只处理"从它出发"的边，这是漏掉的那一半 */
  assert.equal(linkGraph(links, { hidden: { 'ancor:2': true } }).edges.some((e) => e.id === 'L1'), false);
  /* 打开显示开关后恢复 */
  assert.equal(
    linkGraph(links, { hidden: { 'ancor:2': true }, includeHidden: true }).edges.some((e) => e.id === 'L1'),
    true
  );
});

test('端点已被删除或未载入时保留边并标记 broken，不替用户删数据', () => {
  const g = linkGraph([{ id: 'L1', kind: 'link', from: 'root:1', to: 'gone:9' }]);
  const e = g.edges.find((x) => x.id === 'L1');
  assert.ok(e, '边还在');
  assert.equal(e.broken, true, '标成断裂，由界面呈现');
});

test('同一对块之间允许多条连线（不同标签）', () => {
  const g = linkGraph([
    { id: 'L1', kind: 'link', from: 'root:1', to: 'ancor:1', label: '甲' },
    { id: 'L2', kind: 'link', from: 'root:1', to: 'ancor:1', label: '乙' }
  ]);
  assert.deepEqual(
    g.edges.filter((e) => e.kind === 'link').map((e) => e.label).sort(),
    ['乙', '甲']
  );
});

test('连线的端点用持久形态的 Ref 给也能认', () => {
  const g = linkGraph([
    { id: 'L1', kind: 'link', from: { sessionId: 'root', turn: 1 }, to: { sessionId: 'ancor', turn: 2 } }
  ]);
  const e = g.edges.find((x) => x.id === 'L1');
  assert.equal(e.from, 'root:1');
  assert.equal(e.to, 'ancor:2');
});

test('缺 id 的连线也能画出来（用端点兜一个稳定 id）', () => {
  const g = linkGraph([{ kind: 'link', from: 'root:1', to: 'ancor:1' }]);
  const e = g.edges.find((x) => x.kind === 'link');
  assert.equal(e.id, 'link:root:1->ancor:1');
});

test('边标签的落点在两端锚点正中（FR-9）', () => {
  const g = linkGraph([{ id: 'L1', kind: 'link', from: 'root:1', to: 'ancor:1', label: '因为' }]);
  const { nodes, headers } = layout(g);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const e = g.edges.find((x) => x.id === 'L1');
  const mid = edgeMidpoint(e, nodeMap);

  const a = nodeMap.get('root:1');
  const b = nodeMap.get('ancor:1');
  const p = a.x + a.w <= b.x ? [a.x + a.w, a.y + a.h / 2] : [a.x, a.y + a.h / 2];
  const q = a.x + a.w <= b.x ? [b.x, b.y + b.h / 2] : [b.x + b.w, b.y + b.h / 2];
  assert.equal(mid.x, (p[0] + q[0]) / 2);
  assert.equal(mid.y, (p[1] + q[1]) / 2);
  assert.equal(headers.size >= 1, true, '会话头也参与布局');
});

test('端点找不到时不给中点，调用方跳过即可', () => {
  assert.equal(edgeMidpoint({ from: 'nope', to: 'nope2', kind: 'link' }, new Map()), null);
});

test('buildGraph 源块缺失时派生边退回源会话会话头（FR-8）', () => {
  const turns = { ...TURNS, root: TURNS.root.filter((t) => t.turn !== 3) };
  const g = buildGraph({
    sessions: normalizeSessions(RAW_SESSIONS), turnsBySession: turns, currentId: 'root'
  });
  const e = g.edges.find((x) => x.id === 'branch:ancor');
  assert.equal(e.from, 'header:root');
});

test('buildGraph 子会话无轮次时派生边指向空子会话节点（FR-8）', () => {
  const turns = { ...TURNS, ancor: [] };
  const g = buildGraph({
    sessions: normalizeSessions(RAW_SESSIONS), turnsBySession: turns, currentId: 'root'
  });
  const e = g.edges.find((x) => x.id === 'branch:ancor');
  assert.equal(e.to, 'ancor:empty');
  assert.equal(e.from, 'root:3');
});

test('buildGraph 别名优先于自动标题', () => {
  const g = graphOf({ alias: { 'root:3': '认知偏差清单' } });
  assert.equal(g.blocks.find((b) => b.id === 'root:3').alias, '认知偏差清单');
});

/* ------------------------------------------------------------------ 布局 */

test('layout 按血缘深度分列，根在最左', () => {
  const { nodes } = layout(graphOf());
  const x = (id) => nodes.find((n) => n.id === id).x;
  assert.equal(x('root:1'), 0);
  assert.equal(x('ancor:1'), 320);
  assert.equal(x('invest:1'), 640);
  assert.equal(x('infl:1'), 320);
});

test('layout 同列的会话不重叠', () => {
  const { nodes } = layout(graphOf());
  const col = nodes.filter((n) => n.x === 320);
  const boxes = col.filter((n) => n.kind !== 'empty').map((n) => [n.y, n.y + n.h]);
  boxes.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < boxes.length; i++) {
    assert.ok(boxes[i][0] >= boxes[i - 1][1], `第 ${i} 个块不得与上一个重叠`);
  }
});

test('layout 同一会话内轮次纵向顺排，间距等于 pitch', () => {
  const { nodes, opts } = layout(graphOf());
  const root = nodes.filter((n) => n.sessionId === 'root' && n.kind === 'block')
    .sort((a, b) => a.y - b.y);
  assert.equal(root.length, 5);
  for (let i = 1; i < root.length; i++) {
    assert.equal(root[i].y - root[i - 1].y, opts.pitch);
  }
});

test('layout 为无轮次的会话生成空子会话节点', () => {
  const g = buildGraph({
    sessions: normalizeSessions(RAW_SESSIONS),
    turnsBySession: { ...TURNS, invest: [] },
    currentId: 'root'
  });
  const { nodes } = layout(g);
  const empty = nodes.find((n) => n.kind === 'empty');
  assert.equal(empty.id, 'invest:empty');
});

test('bounds 覆盖全部节点', () => {
  const { nodes, bounds: b } = layout(graphOf());
  nodes.forEach((n) => {
    assert.ok(n.x >= b.minX && n.x + n.w <= b.maxX);
    assert.ok(n.y >= b.minY && n.y + n.h <= b.maxY);
  });
});

/* ---------------------------------------------------------------- 几何 */

test('curve 的控制点不越位（短跨度不出现 S 形抖动）', () => {
  const d = curve([0, 0], [60, 40]);
  const m = /C([\d.]+) [\d.]+, ([\d.]+) [\d.]+, ([\d.]+)/.exec(d);
  const x0 = Number(m[1]);
  const x1 = Number(m[2]);
  assert.ok(x0 < x1, `控制点应递增，实际 ${x0} -> ${x1}`);
  assert.ok(x1 <= 60);
});

test('orth 不产生重复点与回退段', () => {
  const d = orth([[816, 559], [900, 559], [900, 229], [816, 229]], 14);
  assert.ok(!/L([\d.]+) ([\d.]+) L\1 \2/.test(d), '无重复点');
  assert.ok(d.includes('Q900 559'), '拐点被圆角化');
  const vert = orth([[711, 262], [711, 296]], 10);
  assert.equal(vert, 'M711 262 L711 296');
});

test('edgePath 对派生边与手动边都返回路径，缺失端点返回空串', () => {
  const { nodes } = layout(graphOf());
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const branch = edgePath({ kind: 'branch', from: 'root:3', to: 'ancor:1' }, nodeMap);
  assert.ok(branch.startsWith('M') && branch.includes('C'));

  const link = edgePath({ kind: 'link', from: 'root:2', to: 'invest:2', route: 'right', xr: 1050 }, nodeMap);
  assert.ok(link.includes('Q'), '绕行路线带圆角');

  assert.equal(edgePath({ kind: 'branch', from: 'nope', to: 'ancor:1' }, nodeMap), '');
});

test('fitView 的缩放被限制在 25%–105% 且居中', () => {
  const { nodes } = layout(graphOf());
  const fit = fitView(nodes, 900, 600);
  assert.ok(fit.scale >= 0.25 && fit.scale <= 1.05);
  const tiny = fitView(nodes, 40, 40);
  assert.equal(tiny.scale, 0.25, '极窄视口触底');
  const huge = fitView([{ x: 0, y: 0, w: 10, h: 10 }], 5000, 5000);
  assert.equal(huge.scale, 1.05, '极宽视口触顶');
});

test('moveSelection 只在按键方向的锥内移动，同轴优先', () => {
  const { nodes } = layout(graphOf());
  assert.equal(moveSelection(nodes, 'root:1', 'ArrowDown'), 'root:2');
  assert.equal(moveSelection(nodes, 'root:5', 'ArrowDown'), null, '列末没有"下方"时不乱跳到邻列');
  assert.equal(moveSelection(nodes, 'root:3', 'ArrowRight'), 'ancor:3', '同行的那一块优先');
  assert.equal(moveSelection(nodes, 'root:1', 'ArrowLeft'), null);
  assert.equal(moveSelection(nodes, 'root:1', 'Nope'), null);
});

/* ---------------------------------------------------------------- .mm 导出 */

const nodeOpen = (x) => (x.match(/<node [^>]*[^/]>/g) || []).length;
const nodeSelf = (x) => (x.match(/<node [^>]*\/>/g) || []).length;
const nodeClose = (x) => (x.match(/<\/node>/g) || []).length;

test('.mm 标签平衡且版本正确', () => {
  const { content } = toFreeMind(graphOf());
  assert.match(content, /^<map version="1\.0\.1">/);
  assert.equal(nodeOpen(content), nodeClose(content));
  assert.equal(nodeSelf(content), 0, '本例没有空子会话');
});

test('.mm 每个块节点内都区分了「问」与「答」（FR-15 核心）', () => {
  const g = graphOf();
  const { content } = toFreeMind(g);
  assert.equal((content.match(/TYPE="NODE"/g) || []).length, 12, '每块一个节点富文本');
  assert.equal((content.match(/<b>问<\/b>/g) || []).length, 12);
  assert.equal((content.match(/<b>答<\/b>/g) || []).length, 12);
  assert.equal((content.match(/TYPE="NOTE"/g) || []).length, 13, '12 个块 + 1 个根备注');
  assert.ok(content.includes('第 3 轮 · 系统1 会带来哪些系统性错误'), 'TEXT 里带提问截断作为第三层保底');
});

test('.mm 分叉会话挂在分叉源块之下，不是平级', () => {
  const { content } = toFreeMind(graphOf());
  const lines = content.split('\n');
  const iRoot3 = lines.findIndex((l) => l.includes('第 3 轮 · 系统1 会带来哪些系统性错误'));
  const iAncor = lines.findIndex((l) => l.includes('锚定效应能用在谈判里吗'));
  assert.ok(iRoot3 >= 0 && iAncor > iRoot3, '子会话出现在源块之后');
  const indent = (s) => s.length - s.trimStart().length;
  assert.equal(indent(lines[iAncor]) - indent(lines[iRoot3]), 2, '缩进只深一层');
  assert.ok(lines[iAncor + 1].includes('第 1 轮 · 锚定在谈判里怎么用'));
});

test('.mm 手动连线导出为 arrowlink，且指向已生成的节点 id', () => {
  const link = { id: 'L1', kind: 'link', from: 'root:5', to: 'invest:2', label: '两条线的结论' };
  const { content } = toFreeMind(graphOf(), { links: [link] });
  const arrows = content.match(/<arrowlink DESTINATION="(ID_\d+)"/g) || [];
  assert.equal(arrows.length, 1);
  const id = /DESTINATION="(ID_\d+)"/.exec(arrows[0])[1];
  assert.ok(content.includes(`ID="${id}"`), 'DESTINATION 指向真实生成的节点');
  assert.ok(content.includes('连线：root:5 → invest:2（两条线的结论）'), '标签写进根备注');
});

test('.mm 连线端点被隐藏时不导出该连线，但记录在根备注', () => {
  const link = { id: 'L1', kind: 'link', from: 'root:5', to: 'infl:2', label: 'X' };
  const g = graphOf({ hidden: { 'infl:2': true } });
  const { content } = toFreeMind(g, { links: [link] });
  assert.equal((content.match(/<arrowlink /g) || []).length, 0);
  assert.ok(content.includes('未导出的连线：root:5 → infl:2（X）'));
  assert.ok(content.includes('有 1 个块因被隐藏而未导出'));
});

test('.mm 引用式会话用虚线边与书签图标，且不重复前缀', () => {
  const sessions = normalizeSessions([
    ...RAW_SESSIONS,
    { id: 'ref1', title: '引用：读懂《思考，快与慢》 第 2 轮', parentId: null }
  ]);
  const link = { id: 'R1', kind: 'reference', from: 'root:2', to: 'ref1:1', label: '引用自' };
  const g = buildGraph({
    sessions,
    turnsBySession: { ...TURNS, ref1: [turn(1, '引用式提问', '不带历史')] },
    currentId: 'root',
    links: [link]           /* 引用式会话靠链线被拉进范围，血缘上它不是家族成员 */
  });
  assert.equal(g.sessions.some((s) => s.id === 'ref1'), true, '被引用的会话进入图范围');
  const { content } = toFreeMind(g, { links: [link] });
  assert.equal((content.match(/STYLE="dash"/g) || []).length, 1);
  assert.equal((content.match(/BUILTIN="bookmark"/g) || []).length, 1);
  assert.equal((content.match(/引用：引用：/g) || []).length, 0, '不重复前缀');
  assert.equal((content.match(/<node TEXT="引用：/g) || []).length, 1);
});

test('sessionOfId 认得出会话头，split(":")[0] 认不出', () => {
  assert.equal(sessionOfId('root:3'), 'root');
  assert.equal(sessionOfId('header:fresh'), 'fresh');
  assert.equal(sessionOfId('header:a:b'), 'a:b', '会话 id 自带冒号也不会切错');
  assert.equal(sessionOfId('solo'), 'solo');
  /* 这就是那个 bug：直接切第一段会得到字面量 "header" */
  assert.equal('header:fresh'.split(':')[0], 'header');
});

test('引用边指向**整个会话头**时也能导出（新会话还没有轮次）', () => {
  const sessions = normalizeSessions([
    ...RAW_SESSIONS,
    { id: 'fresh', title: '引用：先做需求文档', parentId: null }
  ]);
  /* FR-7 新建出来的会话是空壳：没有轮次，引用只能指向它的会话头 */
  const link = { id: 'R1', kind: 'reference', from: 'root:2', to: 'header:fresh', label: '引用自' };
  const g = buildGraph({
    sessions,
    turnsBySession: { ...TURNS, fresh: [] },
    currentId: 'root',
    links: [link]
  });
  const { content } = toFreeMind(g, { links: [link] });
  assert.equal((content.match(/引用：先做需求文档/g) || []).length >= 1, true,
    '引用式会话挂在源块之下 —— 早先 to.split(":")[0] 得到 "header"，这条会被静默丢掉');
  assert.equal((content.match(/STYLE="dash"/g) || []).length, 1, '虚线边');
});

test('引用边指向某个块时照旧（两种终点形态都要认）', () => {
  const sessions = normalizeSessions([
    ...RAW_SESSIONS,
    { id: 'ref1', title: '引用：读懂《思考，快与慢》 第 2 轮', parentId: null }
  ]);
  const link = { id: 'R1', kind: 'reference', from: 'root:2', to: 'ref1:1' };
  const g = buildGraph({
    sessions, turnsBySession: { ...TURNS, ref1: [turn(1, '引用式提问', '不带历史')] },
    currentId: 'root', links: [link]
  });
  const { content } = toFreeMind(g, { links: [link] });
  assert.equal((content.match(/STYLE="dash"/g) || []).length, 1);
});

test('指向会话头的引用边不能被误判为断裂', () => {
  const sessions = normalizeSessions([
    ...RAW_SESSIONS,
    { id: 'fresh', title: '引用：新会话', parentId: null }
  ]);
  const mk = (to) => ({ id: 'R1', kind: 'reference', from: 'root:2', to, label: '引用自' });
  const at = (to) => buildGraph({
    sessions, turnsBySession: { ...TURNS, fresh: [] }, currentId: 'root', links: [mk(to)]
  }).edges.find((e) => e.kind === 'reference');

  /* 这是修掉的那个 bug：已知节点集合原先只装块 id，会话头不在里面 */
  assert.equal(at('header:fresh').broken, false, '会话头是真实存在的节点');
  /* 该会话确实没有第 1 轮，所以块级终点仍然该判断裂 */
  assert.equal(at('fresh:1').broken, true);
  assert.equal(at('ghost:9').broken, true, '真不存在');
  assert.equal(at('header:gone').broken, true, '不存在的会话头');
});

test('引用式会话即便没有轮次也会被拉进图范围', () => {
  const sessions = normalizeSessions([
    ...RAW_SESSIONS,
    { id: 'fresh', title: '引用：新会话', parentId: null }
  ]);
  const link = { id: 'R1', kind: 'reference', from: 'root:2', to: 'header:fresh' };
  const g = buildGraph({
    sessions, turnsBySession: { ...TURNS, fresh: [] }, currentId: 'root', links: [link]
  });
  assert.equal(g.sessions.some((s) => s.id === 'fresh'), true,
    '血缘上它是独立根，靠引用边才进得来');
  assert.equal(g.blocks.some((b) => b.sessionId === 'fresh'), false, '它确实还没有块');
});

test('正文里的尖括号是内容：摘要保留它，导出里被正确转义', () => {
  /* 回归：早先摘要层对正文也做了"剥标记语言"，把代码里的 <div> 直接吃掉了 */
  const g = buildGraph({
    sessions: normalizeSessions([{ id: 'root', title: '根' }]),
    turnsBySession: { root: [turn(1, '把 <div class="a"> 改成 <span>', '用 <template> 包一下')] },
    currentId: 'root'
  });
  assert.equal(g.blocks[0].prompt, '把 <div class="a"> 改成 <span>', '块摘要不被剥标签');
  assert.equal(g.blocks[0].response, '用 <template> 包一下');

  const mm = toFreeMind(g).content;
  assert.ok(mm.includes('&lt;div'), '.mm 里是转义而不是删除');
  assert.ok(mm.includes('&lt;span&gt;'));
  assert.ok(!/<div class=/.test(mm), '没有裸标签泄漏进 .mm');

  const md = toMarkdown(g).content;
  assert.ok(md.includes('<div class="a">'), '.md 原样保留');
});

test('标题仍然剥标记语言（标题是短标签，不是正文）', () => {
  const g = buildGraph({
    sessions: normalizeSessions([{ id: 'root', title: '<b>加粗的标题</b>' }]),
    turnsBySession: { root: [turn(1, 'Q', 'A')] },
    currentId: 'root'
  });
  assert.equal(g.sessions[0].title, '加粗的标题');
});

test('.mm 特殊字符被正确转义，且不泄漏原始标签', () => {
  const g = graphOf();
  const b = g.blocks.find((x) => x.id === 'root:1');
  b.prompt = '这样 <b>加粗</b> & "引号" 与 \'单引号\'';
  const { content } = toFreeMind(g);
  assert.ok(content.includes('&amp;'));
  assert.ok(content.includes('&quot;'));
  assert.ok(content.includes('&apos;'));
  assert.ok(!content.includes('<b>加粗</b>'), '原文里的标签被转义，不会裸着出现');
  /* 剥掉合法实体后，不应再出现裸的 & < > */
  const stripped = content.replace(/&(amp|lt|gt|quot|apos);/g, '').replace(/<[^>]*>/g, '');
  assert.equal(/[&<>]/.test(stripped), false);
});

test('.mm 分叉源未知的子会话不会从导出结果里消失', () => {
  /* forkAtTurn 为 null：上游没能推出分叉轮次（冷会话、继承计数缺失等） */
  const sessions = normalizeSessions([
    { id: 'root', title: '根' },
    { id: 'orphanFork', title: '推不出分叉源的子会话', parentId: 'root', forkAtTurn: null }
  ]);
  const g = buildGraph({
    sessions,
    turnsBySession: { root: [turn(1, 'Q1', 'A1')], orphanFork: [turn(1, '子会话提问', '子会话回答')] },
    currentId: 'root'
  });
  const mm = toFreeMind(g).content;
  const md = toMarkdown(g).content;
  assert.ok(mm.includes('推不出分叉源的子会话'), '.mm 仍包含该子会话');
  assert.ok(md.includes('推不出分叉源的子会话'), '.md 仍包含该子会话');
  assert.equal(nodeOpen(mm), nodeClose(mm));
});

test('.mm 分叉源轮次被隐藏时，子会话退到会话层出现', () => {
  const g = graphOf({ hidden: { 'root:3': true } });
  const mm = toFreeMind(g).content;
  assert.ok(mm.includes('锚定效应能用在谈判里吗'), '源块被隐藏也不能让子会话消失');
  assert.equal(nodeOpen(mm), nodeClose(mm));
});

test('.mm 空子会话节点是自闭合的，且不影响标签平衡', () => {
  const g = buildGraph({
    sessions: normalizeSessions(RAW_SESSIONS),
    turnsBySession: { ...TURNS, invest: [] },
    currentId: 'root'
  });
  const { content } = toFreeMind(g);
  assert.equal(nodeSelf(content), 1);
  assert.equal(nodeOpen(content), nodeClose(content));
  assert.ok(content.includes('空子会话 · 尚未提问'));
});

test('.mm 进行中的块带沙漏图标', () => {
  const turns = { ...TURNS, root: [turn(1, 'Q', 'A', { status: 'open', endSeq: null })] };
  const g = buildGraph({ sessions: normalizeSessions(RAW_SESSIONS), turnsBySession: turns, currentId: 'root' });
  const { content } = toFreeMind(g);
  assert.ok(content.includes('BUILTIN="hourglass"'));
});

/* ---------------------------------------------------------------- .md 导出 */

test('.md 每个块是一个列表项，其下「问」「答」各带一个正文块', () => {
  const { content } = toMarkdown(graphOf());
  assert.equal((content.match(/^- \*\*第 \d+ 轮\*\*/gm) || []).length, 5, '根会话 5 个块在顶层');
  assert.equal((content.match(/- \*\*问\*\*/g) || []).length, 12, '每个块一个「问」');
  assert.equal((content.match(/- \*\*答\*\*/g) || []).length, 12, '每个块一个「答」');
});

test('.md 正文以缩进块嵌入：表格与代码块不会被压成一行', () => {
  const answer = [
    '结论如下：', '',
    '| 层 | 依赖 |', '|---|---|', '| L1 | 视图位 |', '',
    '```js', 'const x = 1;', '```'
  ].join('\n');
  const g = buildGraph({
    sessions: normalizeSessions([{ id: 'root', title: '根' }]),
    turnsBySession: { root: [turn(1, '问一句', answer)] },
    currentId: 'root'
  });
  const { content } = toMarkdown(g);
  assert.ok(content.includes('    | 层 | 依赖 |'), '表格行整体缩进，仍是表格');
  assert.ok(content.includes('    |---|'), '分隔行一起缩进');
  assert.ok(/^ {4}```js$/m.test(content), '代码围栏缩进后仍是围栏');
  assert.ok(content.includes('    const x = 1;'), '代码内容一起缩进');
  /* 旧行为会把整段压成一行，产出 "| 层 | 依赖 | |---|---|" 这种四不像 */
  assert.ok(!content.includes('| 层 | 依赖 | |---|'), '没有被压成一行');
});

test('.mm 行内 Markdown 转成 HTML，且围栏代码内的标记不被误吃', () => {
  const answer = [
    '| 层 | 依赖 |', '|---|---|', '| **L1** | 视图位 |', '',
    '见 `sessionQuery` 与 [报告](https://x.md)。', '',
    '```js', 'if (a ** b) {}', '```'
  ].join('\n');
  const g = buildGraph({
    sessions: normalizeSessions([{ id: 'root', title: '根' }]),
    turnsBySession: { root: [turn(1, '调研 **DSH**', answer)] },
    currentId: 'root'
  });
  const { content } = toFreeMind(g);
  const node = /<richcontent TYPE="NODE">([\s\S]*?)<\/richcontent>/.exec(content)[1];

  assert.ok(node.includes('<b>DSH</b>'), '粗体转成 <b>');
  assert.ok(!node.includes('**DSH**'), '不再残留 ** 源码');
  assert.ok(node.includes('<b>L1</b>'), '表格单元格里的粗体也转了');
  assert.ok(!node.includes('|---|---|'), '表格分隔行是纯噪声，丢掉');
  assert.ok(node.includes('<code>sessionQuery</code>'), '行内代码转成 <code>');
  assert.ok(node.includes('<a href="https://x.md">报告</a>'), '链接转成锚点');
  assert.ok(node.includes('if (a ** b) {}'), '围栏内的 ** 是代码，必须原样保留');
  assert.ok(!node.includes('```'), '围栏标记本身不留在导图里');
  assert.equal(nodeOpen(content), nodeClose(content));
});

test('.mm 正文逐行成段：换行不会被丢掉', () => {
  const answer = ['第一段。', '', '第二段。'].join('\n');
  const g = buildGraph({
    sessions: normalizeSessions([{ id: 'root', title: '根' }]),
    turnsBySession: { root: [turn(1, '问', answer)] },
    currentId: 'root'
  });
  const { content } = toFreeMind(g);
  /* 标签只加在第一段，后续段落是独立的 <p> —— 段段都挂标签反而更乱 */
  assert.equal((content.match(/<b>答<\/b>/g) || []).length, 1);
  assert.ok(content.includes('<p><b>答</b>　第一段。</p>'));
  assert.ok(content.includes('<p>第二段。</p>'), '第二段是独立的段落，没被并进第一段');
  assert.ok(!content.includes('第一段。 第二段。'), '换行没有被压成空格');
  assert.equal(nodeOpen(content), nodeClose(content));
});

test('.md 分叉会话以嵌套项出现，引用式不带重复前缀', () => {
  const { content } = toMarkdown(graphOf());
  assert.ok(content.includes('␟') === false);
  assert.match(content, /- \*\*⑂ 分叉 → 锚定效应能用在谈判里吗\*\*/);
});

test('.md 手动连线另起清单，隐藏端点的连线进未导出清单', () => {
  const links = [
    { id: 'L1', kind: 'link', from: 'root:5', to: 'invest:2', label: '结论合看' },
    { id: 'L2', kind: 'link', from: 'root:4', to: 'infl:2', label: '被隐藏的' }
  ];
  const g = graphOf({ hidden: { 'infl:2': true } });
  const { content } = toMarkdown(g, { links });
  assert.ok(content.includes('## 手动连线'));
  assert.ok(content.includes('`root:5` — **结论合看** → `invest:2`'));
  assert.ok(content.includes('## 未导出的连线（端点被隐藏）'));
});

/* -------------------------------------------------------------- 文件名 */

test('safeFilename 先剥标记语言、再清理路径非法字符，并限长', () => {
  /* 标题在进入这一层之前都已经被 plain() 处理过，所以 <h> 会被当作标签剥掉 */
  assert.equal(safeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_gi_j');
  assert.equal(safeFilename('报告 2026/10'), '报告 2026_10');
  assert.equal(safeFilename('   '), 'session-graph');
  assert.equal(safeFilename('x'.repeat(100)).length, 60);
});

test('exportFilename 用家族根标题', () => {
  const g = graphOf({ currentId: 'invest' });
  assert.equal(exportFilename(g, 'mm'), '会话图谱-读懂《思考，快与慢》.mm');
  assert.equal(exportFilename(g, 'md'), '会话图谱-读懂《思考，快与慢》.md');
});

test('render 按格式分发', () => {
  const g = graphOf();
  assert.match(render(g, 'mm').content, /^<map/);
  assert.match(render(g, 'md').content, /^# 会话图谱/);
  assert.match(render(g, 'unknown').content, /^<map/, '未知格式回落 mm');
});

/* --------------------------------------------------- 手动布局（FR-5） */

/** 同一会话里三块，方便观察"拖走一块会不会牵动别人" */
const stackGraph = () => buildGraph({
  sessions: normalizeSessions([{ id: 'root', title: '根' }]),
  turnsBySession: { root: [1, 2, 3].map((n) => turn(n, 'Q' + n, 'A' + n)) },
  currentId: 'root'
});
const atOf = (result, id) => {
  const n = result.nodes.find((x) => x.id === id);
  return n ? { x: n.x, y: n.y, moved: !!n.moved } : null;
};

test('layout 尊重已保存坐标：已拖拽过的块坐标即权威', () => {
  const g = stackGraph();
  const auto = layout(g);
  const saved = layout(g, { positions: { 'root:2': { x: 900, y: 40 } } });

  assert.deepEqual(atOf(saved, 'root:2'), { x: 900, y: 40, moved: true }, '用存档坐标');
  assert.deepEqual(atOf(saved, 'root:1'), { x: auto.nodes.find((n) => n.id === 'root:1').x,
    y: auto.nodes.find((n) => n.id === 'root:1').y, moved: false }, '同会话其它块不被牵动');
  assert.deepEqual(atOf(saved, 'root:3'), { x: auto.nodes.find((n) => n.id === 'root:3').x,
    y: auto.nodes.find((n) => n.id === 'root:3').y, moved: false });
});

test('layout 只在没有坐标时自动落位 —— 新块落在本会话最下方', () => {
  const g = stackGraph();
  const before = layout(g, { positions: { 'root:1': { x: 500, y: 500 } } });
  const y1 = atOf(before, 'root:1').y;
  const y2 = atOf(before, 'root:2').y;
  assert.equal(y1, 500, '第一块在存档位置');
  assert.ok(y2 < 500, '第二块仍在自动位，没有因为第一块被拖走而跟着跑');
});

test('layout 忽略未知块 id 的坐标记录，不报错也不删别的', () => {
  const g = stackGraph();
  const saved = layout(g, {
    positions: { 'ghost:9': { x: 1, y: 2 }, 'root:1': { x: 7, y: 8 } }
  });
  assert.equal(saved.nodes.some((n) => n.id === 'ghost:9'), false, '幽灵记录被忽略');
  assert.deepEqual(atOf(saved, 'root:1'), { x: 7, y: 8, moved: true }, '同批里的合法记录照常生效');
});

test('layout 容忍畸形坐标：非数字就当没给', () => {
  const g = stackGraph();
  const auto = layout(g);
  const saved = layout(g, {
    positions: { 'root:1': { x: 'no', y: 1 }, 'root:2': null, 'root:3': { x: NaN, y: 3 } }
  });
  ['root:1', 'root:2', 'root:3'].forEach((id) => {
    assert.equal(atOf(saved, id).y, auto.nodes.find((n) => n.id === id).y, id + ' 回到自动位');
    assert.equal(atOf(saved, id).moved, false);
  });
});

test('bounds 把被拖远的块也算进去，适应视图才不会漏掉它', () => {
  const g = stackGraph();
  const auto = layout(g);
  const saved = layout(g, { positions: { 'root:1': { x: 2000, y: 0 } } });
  assert.ok(bounds(saved.nodes).maxX > bounds(auto.nodes).maxX + 1000);
});

/* ------------------------------------------------- 规模降级（NFR-1） */

test('tierOf 按块数分档，边界不含糊', () => {
  assert.equal(tierOf(0), 'full');
  assert.equal(tierOf(800), 'full', '800 仍在满档');
  assert.equal(tierOf(801), 'dense');
  assert.equal(tierOf(3000), 'dense', '3000 仍是密集档');
  assert.equal(tierOf(3001), 'skeleton');
  assert.equal(tierOf(NaN), 'full');
  assert.equal(tierOf(undefined), 'full');
});

test('tierFeatures：越大的档省得越多', () => {
  assert.deepEqual(tierFeatures('full'), { blockText: true, edgeLabels: true, skeletonOnly: false });
  assert.deepEqual(tierFeatures('dense'), { blockText: false, edgeLabels: false, skeletonOnly: false });
  assert.deepEqual(tierFeatures('skeleton'), { blockText: false, edgeLabels: false, skeletonOnly: true });
  assert.deepEqual(tierFeatures('?'), tierFeatures('full'), '认不出的档位按满档处理');
});

test('sessionsWithBlocks：满档与密集档不限制会话', () => {
  const sessions = normalizeSessions(RAW_SESSIONS);
  assert.equal(sessionsWithBlocks(sessions, 'full', 'root', []), null);
  assert.equal(sessionsWithBlocks(sessions, 'dense', 'root', []), null);
});

test('sessionsWithBlocks：骨架档只默认画当前会话', () => {
  const sessions = normalizeSessions(RAW_SESSIONS);
  const set = sessionsWithBlocks(sessions, 'skeleton', 'ancor', []);
  assert.ok(set.has('ancor'), '当前会话');
  /* 祖先不默认展开 —— 那往往正是最大的那一个，展开了就等于没降级。
     它的**会话头**仍在，派生边也仍在，分叉骨架不会断。 */
  assert.equal(set.has('root'), false, '祖先只出头，不默认画块');
  assert.equal(set.has('invest'), false, '后代同理');
});

test('sessionsWithBlocks：显式展开的会话也进来，未知 id 忽略', () => {
  const sessions = normalizeSessions(RAW_SESSIONS);
  const set = sessionsWithBlocks(sessions, 'skeleton', 'root', ['invest', 'ghost']);
  assert.ok(set.has('invest'));
  assert.equal(set.has('ghost'), false);
});

test('sessionsWithBlocks：当前会话不在列表里时不硬塞', () => {
  const sessions = normalizeSessions(RAW_SESSIONS);
  const set = sessionsWithBlocks(sessions, 'skeleton', 'nope', []);
  assert.equal(set.size, 0);
});

test('timedLayout 顺带量出耗时并判定是否超预算', () => {
  let t = 0;
  const clock = () => t;
  t = 100;
  const fast = timedLayout(() => { t = 150; return 'ok'; }, clock);
  assert.equal(fast.result, 'ok');
  assert.equal(fast.ms, 50);
  assert.equal(fast.slow, false);

  t = 0;
  const slow = timedLayout(() => { t = SLOW_LAYOUT_MS + 1; }, clock);
  assert.equal(slow.slow, true, '超过预算要给出回落信号');
});

test('timedLayout 不吞异常：布局炸了要让上层知道', () => {
  assert.throws(() => timedLayout(() => { throw new Error('boom'); }, () => 0), /boom/);
});

/* --------------------------------------- 家族范围稳定性（FR-14） */

test('家族范围不随当前会话变化', () => {
  const sessions = normalizeSessions(RAW_SESSIONS);
  const a = familyOf(sessions, 'root');
  const b = familyOf(sessions, 'ancor');
  const c = familyOf(sessions, 'invest');

  assert.equal(a.rootId, b.rootId, '血缘根一致');
  assert.equal(a.rootId, c.rootId);
  assert.deepEqual([...b.order].sort(), [...a.order].sort(), '成员集合一致');
  assert.deepEqual([...c.order].sort(), [...a.order].sort());
});

test('切换当前会话后装配出的图规模一致，只有 current 变', () => {
  const sessions = normalizeSessions(RAW_SESSIONS);
  const mk = (currentId) => buildGraph({ sessions, turnsBySession: TURNS, currentId });
  const g1 = mk('root');
  const g2 = mk('ancor');

  assert.equal(g1.stats.sessions, g2.stats.sessions, '会话数不变');
  assert.equal(g1.stats.blocks, g2.stats.blocks, '块数不变');
  assert.deepEqual(g1.order.slice().sort(), g2.order.slice().sort(), '顺序集合不变');
  assert.equal(g1.currentId, 'root');
  assert.equal(g2.currentId, 'ancor', '变的只有高亮');
});

/* --------------------------------------------------------- 布局常量契约 */

test('默认布局常量与原型一致', () => {
  assert.equal(DEFAULT_LAYOUT.blockWidth, 232);
  assert.equal(DEFAULT_LAYOUT.blockHeight, 74);
  assert.equal(DEFAULT_LAYOUT.pitch, 100);
  assert.equal(DEFAULT_LAYOUT.columnStep, 320);
});
