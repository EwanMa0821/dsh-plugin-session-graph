/**
 * 会话图谱 · 布局与几何
 *
 * 纯函数。分层规则见需求文档 FR-5：
 *   根会话在左，子会话逐层向右；同一会话内的轮次纵向顺排。
 */

import { emptyId } from './model.js';

export const DEFAULT_LAYOUT = {
  blockWidth: 232,
  blockHeight: 74,
  pitch: 100,
  columnStep: 320,
  sessionGap: 96,
  headerHeight: 26,
  headerGap: 10
};

const R = (n) => [n.x + n.w, n.y + n.h / 2];
const L = (n) => [n.x, n.y + n.h / 2];
const B = (n) => [n.x + n.w / 2, n.y + n.h];
const T = (n) => [n.x + n.w / 2, n.y];

/**
 * 分层布局。同一列内按家族顺序自上而下堆叠，绝不重叠。
 *
 * FR-5：**已拖拽过的块坐标即权威**，自动布局只负责没有坐标的那些。
 * 这样拖走某一块不会牵动同会话的其它块，新轮次也会落在本会话最下方。
 * 传入的坐标里若有未知块 id，忽略即可（上层已经按现有块查找）。
 *
 * @param {object} graph buildGraph 的结果
 * @param {object} [opts] 覆盖 DEFAULT_LAYOUT，另可含 `positions`
 */
export function layout(graph, opts) {
  const { positions, ...rest } = opts || {};
  const o = { ...DEFAULT_LAYOUT, ...rest };
  const saved = positions && typeof positions === 'object' ? positions : {};
  const byId = new Map(graph.sessions.map((s) => [s.id, s]));

  /* 列 = 血缘深度；上溯带环保护 */
  const depth = new Map();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    const seen = new Set();
    let cur = id;
    let d = 0;
    while (cur) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const s = byId.get(cur);
      if (!s || !s.parentId || !byId.has(s.parentId)) break;
      d += 1;
      cur = s.parentId;
    }
    depth.set(id, d);
    return d;
  };

  const cursor = new Map();     /* 每列已用高度 */
  const nodes = [];
  const headers = new Map();

  graph.order.forEach((sid) => {
    const s = byId.get(sid);
    if (!s) return;
    const col = depthOf(sid);
    const x = col * o.columnStep;
    const list = graph.blocks.filter((b) => b.sessionId === sid);
    const strip = list.length ? (list.length - 1) * o.pitch + o.blockHeight : o.blockHeight;
    const top = cursor.get(col) || 0;
    const firstBlockY = top + o.headerHeight + o.headerGap;

    /* 每块的落点：拖过的坐标即权威（FR-5），其余按本会话的顺序排 */
    const placed = list.map((b, i) => {
      const p = saved[b.id];
      const pinned = p && Number.isFinite(p.x) && Number.isFinite(p.y);
      return {
        b,
        x: pinned ? p.x : x,
        y: pinned ? p.y : firstBlockY + i * o.pitch,
        moved: !!pinned
      };
    });

    /* 会话头**跟着自己最上面那块走**。
       块被拖走之后，头若留在原来的槽位，"这块属于哪个会话"就只能靠猜 ——
       实测最糟的形态是：一个会话的块正压在另一个会话的头上面（同列的两个会话
       深度相同、共用 x，纵向先后一乱，看着就像下面那个会话的块）。
       纯自动布局时最上面那块就在 `firstBlockY`，算出来与原来的槽位**完全一致**，
       所以这条规则只在"用户摆过"时才改变结果。
       没有块的会话（空子会话）仍留在槽位，否则那块空框会没有头。 */
    const topBlockY = placed.length ? Math.min(...placed.map((p) => p.y)) : null;
    const headerY = topBlockY === null ? top : topBlockY - o.headerGap - o.headerHeight;

    const header = {
      id: `header:${sid}`, kind: 'header', sessionId: sid,
      x, y: headerY, w: o.blockWidth, h: o.headerHeight,
      title: s.title, current: sid === graph.currentId, turnCount: list.length
    };
    nodes.push(header);
    headers.set(header.id, header);

    if (!list.length) {
      nodes.push({
        id: emptyId(sid), kind: 'empty', sessionId: sid,
        x, y: firstBlockY, w: o.blockWidth, h: o.blockHeight
      });
    }
    placed.forEach((p) => {
      nodes.push({
        id: p.b.id, kind: 'block', sessionId: sid,
        x: p.x, y: p.y, w: o.blockWidth, h: o.blockHeight,
        /* moved 让界面能区分"用户摆过"与"自动落的位" */
        moved: p.moved,
        block: p.b
      });
    });

    cursor.set(col, firstBlockY + strip + o.sessionGap);
  });

  const b = bounds(nodes);
  return { nodes, headers, opts: o, bounds: b };
}

/** 包围盒 */
export function bounds(nodes) {
  if (!nodes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** 三次贝塞尔；控制点偏移不超过跨度一半，否则短跨度会出现 S 形抖动 */
export function curve(a, b) {
  const span = Math.abs(b[0] - a[0]);
  const dx = Math.max(16, Math.min(span * 0.45, span * 0.5));
  return `M${a[0]} ${a[1]} C${a[0] + dx} ${a[1]}, ${b[0] - dx} ${b[1]}, ${b[0]} ${b[1]}`;
}

/** 直角折线 + 圆角；拐点方向按进入段与离开段各自计算 */
export function orth(pts, r) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    if (i === pts.length - 1) { d += ` L${q[0]} ${q[1]}`; break; }
    const horiz = p[1] === q[1];
    const sx = Math.sign(q[0] - p[0]);
    const sy = Math.sign(q[1] - p[1]);
    d += ` L${q[0] - (horiz ? sx * r : 0)} ${q[1] - (horiz ? 0 : sy * r)}`;
    const nx = pts[i + 1];
    const nh = nx[1] === q[1];
    const nsx = Math.sign(nx[0] - q[0]);
    const nsy = Math.sign(nx[1] - q[1]);
    d += ` Q${q[0]} ${q[1]} ${q[0] + (nh ? nsx * r : 0)} ${q[1] + (nh ? 0 : nsy * r)}`;
  }
  return d;
}

/**
 * 一条边的 SVG 路径。
 * 端点找不到时返回空串——调用方跳过该边即可，不抛错。
 */
export function edgePath(edge, nodeMap) {
  const a = nodeMap.get(edge.from) || nodeMap.get(`header:${edge.parentId}`);
  const b = nodeMap.get(edge.to);
  if (!a || !b) return '';
  if (edge.kind === 'link' || edge.kind === 'reference') {
    if (edge.route === 'right' && Number.isFinite(edge.xr)) {
      const p = R(a); const q = R(b);
      return orth([p, [edge.xr, p[1]], [edge.xr, q[1]], q], 14);
    }
    return a.x + a.w <= b.x ? curve(R(a), L(b)) : curve(L(a), R(b));
  }
  if (a.x === b.x) return orth([B(a), T(b)], 10);
  return a.x + a.w <= b.x ? curve(R(a), L(b)) : curve(L(a), R(b));
}

/**
 * 边标签的落点（FR-9：标签显示在边中点，过长截断、悬停完整显示）。
 *
 * 贝塞尔那段的中点恰好是两端锚点的算术平均 ——
 * curve() 的控制点偏移在 t=0.5 处正好抵消（x 方向 3dx−3dx=0）。
 * 端点找不到时返回 null，调用方跳过即可。
 */
export function edgeMidpoint(edge, nodeMap) {
  const a = nodeMap.get(edge.from) || nodeMap.get(`header:${edge.parentId}`);
  const b = nodeMap.get(edge.to);
  if (!a || !b) return null;
  if (edge.kind === 'link' || edge.kind === 'reference') {
    if (edge.route === 'right' && Number.isFinite(edge.xr)) {
      return { x: edge.xr, y: (R(a)[1] + R(b)[1]) / 2 };
    }
    const left = a.x + a.w <= b.x;
    const p = left ? R(a) : L(a);
    const q = left ? L(b) : R(b);
    return { x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2 };
  }
  const p = a.x === b.x ? B(a) : (a.x + a.w <= b.x ? R(a) : L(a));
  const q = a.x === b.x ? T(b) : (a.x + a.w <= b.x ? L(b) : R(b));
  return { x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2 };
}

/**
 * 适应视图：把全部节点装进视口（FR-5）。
 * @returns {{scale:number, panX:number, panY:number}}
 */
export function fitView(nodes, viewportWidth, viewportHeight, padding = 48) {
  const b = bounds(nodes);
  if (!b.width || !b.height) return { scale: 1, panX: padding, panY: padding };
  const vw = Math.max(120, viewportWidth - padding * 2);
  const vh = Math.max(120, viewportHeight - padding * 2);
  const scale = Math.max(0.25, Math.min(1.05, Math.min(vw / b.width, vh / b.height)));
  return {
    scale,
    panX: (viewportWidth - b.width * scale) / 2 - b.minX * scale,
    panY: (viewportHeight - b.height * scale) / 2 - b.minY * scale
  };
}

/**
 * 键盘在相邻块之间移动选中（FR-5 / NFR-5）。
 * 只在按键方向的 ±45° 锥内取候选，命中后再按「同轴优先」打分——
 * 否则在列末按方向键会跳到邻列去，观感上是乱飞。
 *
 * **只在块之间走**：需求写的就是「在相邻块之间移动选中」，会话头不是块 ——
 * 选中它右栏没有任何块级信息可给，只会让详情面板空掉。
 * @returns {string|null} 下一个节点 id；无处可去时返回 null
 */
export function moveSelection(nodes, selectedId, key) {
  const walkable = nodes.filter((n) => n.kind === 'block');
  if (!walkable.length) return null;
  const cur = walkable.find((n) => n.id === selectedId) || walkable[0];
  const dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[key];
  if (!dir) return null;
  const cx = cur.x + cur.w / 2;
  const cy = cur.y + cur.h / 2;
  let best = null;
  let bestScore = Infinity;
  walkable.forEach((n) => {
    if (n.id === cur.id) return;
    const dx = n.x + n.w / 2 - cx;
    const dy = n.y + n.h / 2 - cy;
    const along = dx * dir[0] + dy * dir[1];
    if (along <= 8) return;
    const across = Math.abs(dx * dir[1] - dy * dir[0]);
    if (across > along) return;                 /* 锥约束：偏角超过 45° 不算"这个方向" */
    const score = along + across * 2.2;
    if (score < bestScore) { bestScore = score; best = n; }
  });
  return best ? best.id : null;
}
