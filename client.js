/* 由 scripts/build-client.mjs 生成 —— 请勿直接编辑；改 src/ 后重新生成。 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-session-graph",
  factory(require) {
    const React = require('react');
    const h = React.createElement;
/* ---- src/core/model.js ---- */
/**
 * 会话图谱 · 核心模型
 *
 * 纯函数、零依赖、不触碰 DSH 运行时。输入输出都是普通 JSON，
 * 因此可以在 Node 里直接单测（见 test/core.test.mjs）。
 *
 * 术语（与需求文档 §2.1 一致）：
 *   Session  会话描述 { id, title, parentId, forkAtTurn, blank }
 *   Turn     轮次描述 { turn, startSeq, endSeq, prompt, response, status, toolCalls, deliverables }
 *   Block    块      一个轮次在图谱上的呈现（FR-2）
 *   Edge     边      派生边 / 手动边 / 引用边（FR-8/9）
 *   Graph    图模型   供布局与导出共用的规范化结果
 */

const GRAPH_VERSION = 1;

/** 块 id。`sessionId:turn`，全流程唯一。 */
const blockId = (sessionId, turn) => `${sessionId}:${turn}`;

/** 空子会话占位节点的 id（FR-8：子会话尚无自有轮次时的终点） */
const emptyId = (sessionId) => `${sessionId}:empty`;

/**
 * 块 id ↔ 持久形态的 Ref（§5.2）。
 *
 * id 的约定归 model 管（`blockId` / `emptyId` 也在这里），
 * 所以解析也放这里 —— 持久层只是引用它，不该各写一份。
 */
function idToRef(id) {
  const s = String(id === undefined || id === null ? '' : id);
  if (s === '') return null;
  const cut = s.indexOf(':');
  if (cut <= 0) return null;
  const head = s.slice(0, cut);
  const tail = s.slice(cut + 1);
  if (head === 'header') return { sessionId: tail };
  if (tail === 'empty') return { sessionId: head };
  const turn = Number(tail);
  return Number.isInteger(turn) && turn > 0 ? { sessionId: head, turn } : null;
}

/** Ref → 客户端内部 id；认不出来返回空串 */
function refToId(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return '';
  const sessionId = str(ref.sessionId);
  if (sessionId === '') return '';
  if (ref.turn === undefined || ref.turn === null) return `header:${sessionId}`;
  const turn = Number(ref.turn);
  return Number.isInteger(turn) && turn > 0 ? `${sessionId}:${turn}` : '';
}

const str = (v) => (v === undefined || v === null ? '' : String(v));
/* 注意 Number(null) === 0：显式的 null/undefined/空串必须判成"没有值"，
   否则"这一轮没有结束边界"会被读成"在 0 号事件结束"。 */
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** 压成单行：只用于**标题、别名**这类短标签。 */
const squash = (v) => str(v).replace(/\s+/g, ' ').trim();
/** 剥标记语言 + 压成单行。同样只用于标题、别名。 */
const plain = (v) => squash(str(v).replace(/<[^>]*>/g, ''));

/**
 * 规整**正文**（提问、回答）。
 *
 * 关键在于**保留换行**：正文是 Markdown，表格、代码块、列表全靠换行成立。
 * 早先对正文也用了 squash，把所有换行折成空格，于是详情面板里退化成一大段
 * 裸露的 Markdown 源码，导出的表格也被压成了一行。
 */
const tidy = (v) => str(v)
  .replace(/\r\n?/g, '\n')
  .split('\n')
  .map((line) => line.replace(/[ \t]+$/, ''))
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  /* 首尾整体去空白：首行若留着前导空格，Markdown 会把它当缩进代码块。
     只去整体首尾，**不动**行内缩进 —— 那正是列表与代码块的结构。 */
  .trim();

/**
 * 把 Markdown 摘要成一行可读文本 —— 给导出里的 `TEXT` 属性用。
 * 画布上的摘要不用这个，客户端用宿主自己的 `extractMarkdownPlainText`。
 */
function summarize(v) {
  return squash(str(v)
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, ' ')
    .replace(/[|]/g, ' '));
}

/** 截断，超出补省略号。传入的应当已经是单行文本。 */
function clip(v, n) {
  const s = squash(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * 子会话标题自增：源标题末尾括号数字 +1，半角与全角括号都支持（FR-6 / §3）。
 * 与产品既有「分支」动作的规则一致。
 */
function increasedTitle(title) {
  const t = str(title);
  let m = /^(.*?)\s*\((\d+)\)$/.exec(t);
  if (m) return `${m[1]} (${Number(m[2]) + 1})`;
  m = /^(.*?)（(\d+)）$/.exec(t);
  if (m) return `${m[1]}（${Number(m[2]) + 1}）`;
  return `${t} (1)`;
}

/** 生成一个当前家族内不重名的子会话标题 */
function uniqueTitle(title, existing) {
  const taken = new Set((existing || []).map(str));
  let out = increasedTitle(title);
  let guard = 0;
  while (taken.has(out) && guard++ < 64) out = increasedTitle(out);
  return out;
}

/**
 * 把 DSH 装配器提供的轮次时间线折算成轮次记录。
 *
 * 时间线形状为 `{ turnOrder, turns }`（turns 是 Map 或普通对象），
 * 每个轮次记录至少能读到 `end.seq`（参见 ui-chat 的 `forkAt`）。
 * 这里做**防御性读取**：任何字段缺失都不抛错，只是留空。
 *
 * @param {{turnOrder?: any[], turns?: Map<any, any>|Record<string, any>}} timeline
 * @returns {Array<object>} 轮次记录，按 turn 升序
 */
function turnsFromTimeline(timeline) {
  if (!timeline) return [];
  const order = Array.isArray(timeline.turnOrder) ? timeline.turnOrder : [];
  const bag = timeline.turns;
  const get = (k) => {
    if (!bag) return undefined;
    return typeof bag.get === 'function' ? bag.get(k) : bag[k];
  };
  const out = [];
  const seen = new Set();

  const take = (rec, fallbackTurn) => {
    if (!rec) return;
    const turn = Number(rec.turn ?? fallbackTurn);
    if (!Number.isFinite(turn) || seen.has(turn)) return;
    seen.add(turn);
    const endSeq = numOrNull(rec.end && rec.end.seq);
    out.push({
      turn,
      startSeq: numOrNull(rec.start && rec.start.seq) ?? numOrNull(rec.seq),
      endSeq,
      prompt: tidy(rec.prompt ?? rec.ask ?? rec.promptPreview),
      response: tidy(rec.response ?? rec.answer ?? rec.responsePreview),
      status: rec.status === 'failed' ? 'failed' : endSeq === null ? 'open' : 'done',
      toolCalls: Number(rec.toolCalls ?? rec.toolCallCount ?? 0) || 0,
      deliverables: Number(rec.deliverables ?? rec.deliverableCount ?? 0) || 0
    });
  };

  if (order.length) order.forEach((k, i) => take(get(k), i + 1));
  else if (bag) {
    const vals = typeof bag.values === 'function' ? [...bag.values()] : Object.values(bag);
    vals.forEach((r, i) => take(r, i + 1));
  }
  out.sort((a, b) => a.turn - b.turn);
  return out;
}

/**
 * 会话列表规范化。只保留 id 与血缘必需字段，容忍字段名差异。
 * @param {Array<object>} raw DSH 会话列表项（`sessionId`/`id`、`parentSessionId`/`parentId` 都接受）
 */
function normalizeSessions(raw) {
  const out = [];
  const seen = new Set();
  (raw || []).forEach((s) => {
    if (!s) return;
    const id = str(s.id ?? s.sessionId);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const parentId = str(s.parentId ?? s.parentSessionId) || null;
    out.push({
      id,
      title: plain(s.displayTitle ?? s.title ?? s.name) || id,
      parentId,
      /* 分叉源轮次。上游没有这个字段时留 null，派生边会退回挂到会话头 */
      forkAtTurn: numOrNull(s.forkAtTurn ?? s.forkAt ?? s.parentTurn),
      blank: !!s.blank,
      origin: str(s.origin) || 'session'
    });
  });
  return out;
}

/**
 * 家族范围（FR-3）。
 *
 * 从 currentId 沿 parentId 上溯到无法继续的祖先，再向下展开全部后代。
 * 孤儿（父不在列表）降级为根；血缘成环时把环成员作为根渲染——**绝不丢节点、绝不无限递归**。
 *
 * @returns {{ rootId: string|null, order: string[], notes: string[], roots: string[] }}
 */
function familyOf(sessions, currentId) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  if (!byId.has(currentId)) {
    return { rootId: null, order: [], notes: ['当前会话不在会话列表中'], roots: [] };
  }

  /* 上溯：只沿真实存在于列表里的父链走，遇到环就停 */
  const chain = [];
  const seen = new Set();
  let cursor = currentId;
  while (cursor !== undefined && cursor !== null) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    chain.push(cursor);
    const parent = byId.get(cursor).parentId;
    cursor = parent && byId.has(parent) ? parent : undefined;
  }
  const rootId = chain[chain.length - 1];

  /* 下拓：从根深度优先展开后代，环安全 */
  const order = [];
  const visited = new Set();
  const walk = (id) => {
    if (visited.has(id)) return;
    visited.add(id);
    order.push(id);
    sessions
      .filter((s) => s.parentId === id && byId.has(s.parentId))
      .map((s) => s.id)
      .sort()
      .forEach(walk);
  };
  walk(rootId);

  /* 孤儿降级为根 */
  const notes = [];
  sessions.forEach((s) => {
    if (s.parentId && !byId.has(s.parentId)) notes.push(`会话「${s.title}」的父会话已不可见，已作为根显示`);
  });
  /* 成环检测：上溯长度异常时给出告警 */
  if (chain.length > byId.size) notes.push('血缘存在环，已按根处理');

  const roots = [rootId];
  return { rootId, order, notes, roots };
}

/**
 * 装配图模型：块 + 派生边 + 家族顺序。
 *
 * @param {object} input
 * @param {Array<object>} input.sessions      规范化后的会话
 * @param {Record<string, object[]>} input.turnsBySession 每个会话的轮次
 * @param {string} input.currentId            当前会话
 * @param {Record<string, boolean>} [input.hidden] 隐藏的块
 * @param {Record<string, string>} [input.alias]   块别名
 * @param {boolean} [input.includeHidden]     是否把隐藏块也纳入（导出时用）
 * @returns {object} Graph
 */
function buildGraph(input) {
  const sessions = input.sessions || [];
  const turnsBySession = input.turnsBySession || {};
  const hidden = input.hidden || {};
  const alias = input.alias || {};
  const links = input.links || [];
  const includeHidden = !!input.includeHidden;
  const currentId = input.currentId;

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const fam = familyOf(sessions, currentId);
  const scopedIds = new Set(fam.order);

  /* 引用式会话不在血缘家族里，但被引用连线拉进范围（FR-7） */
  links.forEach((l) => {
    if (!l || l.kind !== 'reference') return;
    const target = String(l.to === undefined ? '' : l.to).split(':')[0];
    if (byId.has(target)) scopedIds.add(target);
  });

  const scoped = sessions.filter((s) => scopedIds.has(s.id));

  /* 每个会话的全部轮次（**不过滤隐藏**）。端点是否被隐藏必须按全集判断，
     否则"被隐藏的块"会与"从未载入的轮次"混同，导致派生边悄悄改挂到会话头。 */
  const allBySession = new Map();
  scoped.forEach((s) => {
    allBySession.set(s.id, (turnsBySession[s.id] || []).map((t) => ({
      ...t, id: blockId(s.id, t.turn)
    })));
  });

  /* 块 */
  const blocks = [];
  const blocksBySession = new Map();
  let hiddenSkipped = 0;
  scoped.forEach((s) => {
    const list = [];
    allBySession.get(s.id).forEach((t) => {
      const isHidden = !!hidden[t.id];
      if (isHidden && !includeHidden) { hiddenSkipped += 1; return; }
      const b = {
        id: t.id,
        sessionId: s.id,
        sessionTitle: s.title,
        turn: t.turn,
        startSeq: t.startSeq ?? null,
        endSeq: t.endSeq ?? null,
        prompt: tidy(t.prompt),
        response: tidy(t.response),
        status: t.status || (t.endSeq === null ? 'open' : 'done'),
        toolCalls: Number(t.toolCalls) || 0,
        deliverables: Number(t.deliverables) || 0,
        loaded: t.loaded !== false,
        current: s.id === currentId,
        hidden: isHidden,
        alias: alias[t.id] ? plain(alias[t.id]) : ''
      };
      blocks.push(b);
      list.push(b);
    });
    blocksBySession.set(s.id, list);
  });

  /* 派生边：
       起点 = 源会话中该轮次的块；该轮次**不存在**（未载入）时退回源会话会话头
       终点 = 子会话首个自有轮次的块；子会话无轮次时用空子会话节点
     任一端点被隐藏时整条边一并消失（FR-11），而不是改挂到会话头 */
  const edges = [];
  scoped.forEach((s) => {
    if (!s.parentId || !byId.has(s.parentId) || !scopedIds.has(s.parentId)) return;
    const parentAll = allBySession.get(s.parentId) || [];
    const mineAll = allBySession.get(s.id) || [];

    let from;
    let fromHidden = false;
    const src = s.forkAtTurn === null || s.forkAtTurn === undefined
      ? undefined
      : parentAll.find((t) => t.turn === s.forkAtTurn);
    if (src) {
      from = src.id;
      fromHidden = !!hidden[src.id];
    } else {
      from = `header:${s.parentId}`;
    }

    const first = mineAll[0];
    const to = first ? first.id : emptyId(s.id);
    const toHidden = first ? !!hidden[first.id] : false;

    if (!includeHidden && (fromHidden || toHidden)) return;

    edges.push({
      id: `branch:${s.id}`, kind: 'branch', from, to,
      sessionId: s.id, parentId: s.parentId
    });
  });

  /* 手动边与引用边：由用户数据生成（§5.2 三种 kind 中，branch 是推导的，这两类是存下来的）。
     - 自环拒绝（创建时就该拦，这里再兜一层）
     - **任一端点**被隐藏则整条边一并隐藏（FR-9 / FR-11），不只是从它出发的边
     - 端点已被删除或未载入时保留边、标记 broken，**不替用户删数据** */
  const knownNode = new Set(blocks.map((b) => b.id));
  links.forEach((l) => {
    if (!l || (l.kind !== 'link' && l.kind !== 'reference')) return;
    const from = refToId(l.from) || str(l.from);
    const to = refToId(l.to) || str(l.to);
    if (!from || !to || from === to) return;
    if (!includeHidden && (hidden[from] || hidden[to])) return;
    edges.push({
      id: str(l.id) || `${l.kind}:${from}->${to}`,
      kind: l.kind,
      from,
      to,
      ...(l.label ? { label: str(l.label) } : {}),
      broken: !knownNode.has(from) || !knownNode.has(to),
      ...(l.createdAt !== undefined ? { createdAt: l.createdAt } : {})
    });
  });

  const stats = {
    sessions: scoped.length,
    blocks: blocks.length,
    hiddenSkipped,
    edges: edges.length
  };

  return {
    version: GRAPH_VERSION,
    currentId,
    rootId: fam.rootId,
    order: fam.order,
    notes: fam.notes,
    sessions: scoped,
    blocks,
    edges,
    stats
  };
}

/* ---- src/core/graph.js ---- */
/**
 * 会话图谱 · 布局与几何
 *
 * 纯函数。分层规则见需求文档 FR-5：
 *   根会话在左，子会话逐层向右；同一会话内的轮次纵向顺排。
 */


const DEFAULT_LAYOUT = {
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
 * @param {object} graph buildGraph 的结果
 * @param {object} [opts] 覆盖 DEFAULT_LAYOUT
 */
function layout(graph, opts) {
  const o = { ...DEFAULT_LAYOUT, ...(opts || {}) };
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

    const header = {
      id: `header:${sid}`, kind: 'header', sessionId: sid,
      x, y: top, w: o.blockWidth, h: o.headerHeight,
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
    list.forEach((b, i) => {
      nodes.push({
        id: b.id, kind: 'block', sessionId: sid,
        x, y: firstBlockY + i * o.pitch, w: o.blockWidth, h: o.blockHeight, block: b
      });
    });

    cursor.set(col, firstBlockY + strip + o.sessionGap);
  });

  const b = bounds(nodes);
  return { nodes, headers, opts: o, bounds: b };
}

/** 包围盒 */
function bounds(nodes) {
  if (!nodes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** 三次贝塞尔；控制点偏移不超过跨度一半，否则短跨度会出现 S 形抖动 */
function curve(a, b) {
  const span = Math.abs(b[0] - a[0]);
  const dx = Math.max(16, Math.min(span * 0.45, span * 0.5));
  return `M${a[0]} ${a[1]} C${a[0] + dx} ${a[1]}, ${b[0] - dx} ${b[1]}, ${b[0]} ${b[1]}`;
}

/** 直角折线 + 圆角；拐点方向按进入段与离开段各自计算 */
function orth(pts, r) {
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
function edgePath(edge, nodeMap) {
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
function edgeMidpoint(edge, nodeMap) {
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
function fitView(nodes, viewportWidth, viewportHeight, padding = 48) {
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
 * @returns {string|null} 下一个节点 id；无处可去时返回 null
 */
function moveSelection(nodes, selectedId, key) {
  const walkable = nodes.filter((n) => n.kind === 'block' || n.kind === 'header');
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

/* ---- src/core/export.js ---- */
/**
 * 会话图谱 · 导出
 *
 * FR-15：把图谱导出为思维导图软件可导入的格式。
 * 核心约束——**一个块在导出结果里是同一个节点，节点内部区分用户提问与助手回答**。
 *
 * `.mm` 用三层保底（同一份文本，任何一层都不缺内容）：
 *   1. richcontent NODE —— 支持节点富文本的工具直接看到「问」「答」两段
 *   2. richcontent NOTE —— 大多数工具显示备注，作为保底
 *   3. TEXT 里的提问截断 —— 连备注都不显示的工具至少能看到提问
 *
 * `.md` 里同一个块是一个列表项，其下 `**问**` / `**答**` 两个子项，
 * 正文以**缩进块**原样嵌入 —— 这样正文里的表格、代码块、列表才能正确渲染。
 */


const FORMATS = ['mm', 'md'];

const escXml = (v) => String(v === undefined || v === null ? '' : v)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

/**
 * Markdown 行内标记 → FreeMind richcontent 认的 HTML。
 *
 * `.mm` 的 richcontent 是 **HTML**，不是 Markdown。不转换的话，思维导图里会
 * 原样显示 `**DSH**`、`| 层 | 依赖 |` 这些源码。先转义再做替换，顺序不能反。
 */
function inlineHtml(text) {
  return escXml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '<a href="$2">$1</a>');
}

/** 表格分隔行（`|---|---|`）在思维导图里只是噪声，丢掉 */
const isTableRule = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');

/**
 * 把一段 Markdown 正文逐行转成 `<p>`，首行带标签（如「问」）。返回**数组**，
 * 由调用方决定怎么分行输出 —— 行拆开之后 `.mm` 才 diff 得动、预览也读得了。
 *
 * 空行与表格分隔行跳过（空 `<p>` 在多数思维导图软件里会渲染成一行空白）；
 * 围栏代码换成等宽段落并丢掉 ``` 标记 —— 在导图里那三个反引号只是噪声，
 * 且围栏内不能再套行内标记，否则代码里的 `**` 会被吃掉。
 */
function paragraphList(text, label) {
  const out = [];
  const push = (html) => {
    const head = out.length === 0 ? `<b>${escXml(label)}</b>　` : '';
    out.push(`<p>${head}${html}</p>`);
  };

  let fenced = false;
  tidy(text).split('\n').forEach((raw) => {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) {
      if (line !== '') push(`<font face="Courier New, monospace">${escXml(raw.replace(/\s+$/, ''))}</font>`);
      return;
    }
    if (line === '' || isTableRule(line)) return;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    push(heading ? `<b>${inlineHtml(heading[1])}</b>` : inlineHtml(line.replace(/^>\s?/, '')));
  });

  if (out.length === 0) out.push(`<p><b>${escXml(label)}</b></p>`);   /* 正文为空也要留一格 */
  return out;
}

/** 把多行文本整体缩进 n 个空格，供 Markdown 列表项内部嵌入块内容 */
function indentBlock(text, n) {
  const pad = ' '.repeat(n);
  return tidy(text).split('\n').map((line) => (line === '' ? '' : pad + line)).join('\n');
}

/** 时间戳，`YYYY-MM-DD HH:mm` */
function stamp(at) {
  const d = at instanceof Date ? at : new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 文件名安全化：路径非法字符替换、长度截断、空标题回落 */
function safeFilename(title, fallback = 'session-graph') {
  const base = plain(title).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  return (base || fallback).slice(0, 60);
}

/** 导出文件名：`会话图谱-<家族根标题>.mm|.md` */
function exportFilename(graph, format) {
  const root = graph.sessions.find((s) => s.id === graph.rootId);
  const base = safeFilename(root ? root.title : '', '会话图谱');
  return `会话图谱-${base}.${format === 'md' ? 'md' : 'mm'}`;
}

/* ---------------------------------------------------------------- 树装配 */

/**
 * 把图模型装配成导出树。
 *
 * - 分叉出来的会话挂在**它的分叉源块**之下（真正的树，不平级）
 * - 引用式会话挂在源块之下，带虚线边标记
 * - 手动连线和引用连线在 `.mm` 里是 arrowlink，在 `.md` 里另起清单
 *
 * @param {object} graph buildGraph 结果
 * @param {object} [options] { links: [{id, from, to, label, kind, route, xr}] }
 */
function buildTree(graph, options = {}) {
  const links = options.links || [];
  const bySession = new Map(graph.sessions.map((s) => [s.id, s]));
  const blocksOf = (sid) => graph.blocks.filter((b) => b.sessionId === sid);
  const childrenAt = (sid, turn) =>
    graph.sessions.filter((s) => s.parentId === sid && s.forkAtTurn === turn);
  /**
   * 挂在会话层、而不是某个块下面的子会话。
   *
   * 包括两类：分叉源轮次未知（forkAtTurn 为 null），以及分叉源轮次不在可见块里
   * （被隐藏、或尚未载入）。**没有这一层，这两种子会话会在导出结果里整个消失。**
   */
  const leftoverChildren = (sid) => {
    const visibleTurns = new Set(blocksOf(sid).map((b) => b.turn));
    return graph.sessions.filter((s) => s.parentId === sid
      && (s.forkAtTurn === null || s.forkAtTurn === undefined || !visibleTurns.has(s.forkAtTurn)));
  };
  const refsAt = (blockIdValue) =>
    links.filter((l) => l.kind === 'reference' && l.from === blockIdValue)
      .map((l) => l.to.split(':')[0])
      .filter((sid) => bySession.has(sid));

  /* 家族根：没有父、或父不在家族内的会话 */
  const roots = graph.order
    .map((id) => bySession.get(id))
    .filter((s) => s && (!s.parentId || !bySession.has(s.parentId)));

  const skipped = [];
  const keptLinks = [];
  const visible = new Set(graph.blocks.map((b) => b.id));
  links.forEach((l) => {
    if (l.kind === 'reference') return;                       /* 引用关系已由树结构表达 */
    if (visible.has(l.from) && visible.has(l.to)) keptLinks.push(l);
    else skipped.push(l);
  });

  const linkFrom = new Map();
  keptLinks.forEach((l) => {
    if (!linkFrom.has(l.from)) linkFrom.set(l.from, []);
    linkFrom.get(l.from).push(l);
  });

  return { roots, blocksOf, childrenAt, leftoverChildren, refsAt, keptLinks, linkFrom, skipped };
}

/* ------------------------------------------------------------------ .mm */

/**
 * FreeMind `.mm`（XML）。可导入 XMind / MindManager / Freeplane / MindMeister。
 * @returns {{ content: string, filename: string }}
 */
function toFreeMind(graph, options = {}) {
  const tree = buildTree(graph, options);
  const ids = new Map();
  let uid = 0;
  const idOf = (key) => {
    if (!ids.has(key)) ids.set(key, `ID_${1000000000 + (++uid)}`);
    return ids.get(key);
  };
  const pad = (d) => '  '.repeat(d);
  const out = [];

  /* 富文本**逐行**输出：整段挤成一行时，文件没法 diff，导出预览也只能横向裁切 */
  function rich(type, depth, parts) {
    out.push(`${pad(depth)}<richcontent TYPE="${type}"><html><body>`);
    parts.forEach((p) => out.push(`${pad(depth + 1)}${p}`));
    out.push(`${pad(depth)}</body></html></richcontent>`);
  }

  function blockNode(block, depth) {
    const title = block.alias
      ? `✎ ${block.alias}`
      : `第 ${block.turn} 轮 · ${clip(summarize(block.prompt), 24)}`;
    const bg = block.current ? ' BACKGROUND_COLOR="#e4edfd"' : '';
    out.push(`${pad(depth)}<node TEXT="${escXml(title)}" ID="${idOf(block.id)}"${bg}>`);
    /* 第 1 层：节点富文本里「问」「答」两段（正文里的换行原样保留） */
    rich('NODE', depth + 1, [
      ...paragraphList(block.prompt, '问'),
      ...paragraphList(block.response, '答')
    ]);
    /* 第 2 层：备注里的全文与元信息 */
    rich('NOTE', depth + 1, [
      ...paragraphList(block.prompt, '问：'),
      ...paragraphList(block.response, '答：'),
      `<p>元信息：${escXml(block.sessionTitle)} · 第 ${block.turn} 轮 · ` +
      `${block.toolCalls} 个工具 · ${block.deliverables} 个交付物</p>`
    ]);
    if (block.status === 'open') out.push(`${pad(depth + 1)}<icon BUILTIN="hourglass"/>`);
    if (block.status === 'failed') out.push(`${pad(depth + 1)}<icon BUILTIN="messagebox_warning"/>`);
    if (block.deliverables) out.push(`${pad(depth + 1)}<icon BUILTIN="attach"/>`);

    /* 手动连线 → 箭头链接（FreeMind 格式没有边标签，标签另见根备注） */
    (tree.linkFrom.get(block.id) || []).forEach((l) => {
      out.push(`${pad(depth + 1)}<arrowlink DESTINATION="${idOf(l.to)}" COLOR="#4176e6" ` +
        `STARTARROW="None" ENDARROW="Default"/>`);
    });

    tree.childrenAt(block.sessionId, block.turn).forEach((s) => sessionNode(s, depth + 1, 'fork'));
    tree.refsAt(block.id).forEach((sid) => sessionNode(byIdSafe(sid), depth + 1, 'ref'));
    out.push(`${pad(depth)}</node>`);
  }

  function byIdSafe(sid) { return graph.sessions.find((s) => s.id === sid); }

  function sessionNode(s, depth, mode) {
    if (!s) return;
    const ref = mode === 'ref';
    const label = ref && /^引用[:：]/.test(s.title) ? s.title : (ref ? `引用：${s.title}` : s.title);
    out.push(`${pad(depth)}<node TEXT="${escXml(label)}" ID="${idOf(`S:${s.id}`)}">`);
    if (ref) {
      out.push(`${pad(depth + 1)}<edge COLOR="#81858c" STYLE="dash"/>`);
      out.push(`${pad(depth + 1)}<icon BUILTIN="bookmark"/>`);
    }
    const mine = tree.blocksOf(s.id);
    if (!mine.length) {
      out.push(`${pad(depth + 1)}<node TEXT="空子会话 · 尚未提问" ID="${idOf(`E:${s.id}`)}"/>`);
    } else {
      mine.forEach((b) => blockNode(b, depth + 1));
    }
    /* 分叉源轮次未知或不可见的孩子挂在会话层，绝不丢节点 */
    tree.leftoverChildren(s.id).forEach((c) => sessionNode(c, depth + 1, 'fork'));
    out.push(`${pad(depth)}</node>`);
  }

  /* 合成根：承载家族全部根会话，并在备注里写导出说明 */
  const rootLabel = tree.roots.map((s) => s.title).join(' / ') || '会话图谱';
  out.push(`<node TEXT="${escXml('会话图谱 · ' + rootLabel)}" ID="${idOf('ROOT')}">`);
  tree.roots.forEach((s) => sessionNode(s, 1, 'fork'));

  const note = [
    `导出时间：${options.stamp || stamp()}`,
    `会话 ${graph.stats.sessions} 个 · 块 ${graph.stats.blocks} 个`,
    '每个块内用「问」「答」两段区分用户提问与助手回答。',
    '分叉出来的会话挂在它的分叉源块之下；手动连线导出为箭头链接。'
  ];
  if (graph.stats.hiddenSkipped) note.push(`有 ${graph.stats.hiddenSkipped} 个块因被隐藏而未导出。`);
  tree.keptLinks.forEach((l) => note.push(`连线：${l.from} → ${l.to}${l.label ? `（${l.label}）` : ''}`));
  tree.skipped.forEach((l) => note.push(`未导出的连线：${l.from} → ${l.to}${l.label ? `（${l.label}）` : ''}`));
  rich('NOTE', 1, note.map((n) => `<p>${escXml(n)}</p>`));
  out.push('</node>');

  const content = '<map version="1.0.1">\n' +
    `<!-- 「会话图谱」导出 · ${options.stamp || stamp()} · ` +
    `${graph.stats.sessions} 个会话 / ${graph.stats.blocks} 个块 -->\n` +
    out.join('\n') + '\n</map>\n';
  return { content, filename: exportFilename(graph, 'mm') };
}

/* ------------------------------------------------------------------ .md */

/**
 * Markdown 大纲。可导入 XMind（Markdown）、Obsidian 与任意大纲工具。
 * @returns {{ content: string, filename: string }}
 */
function toMarkdown(graph, options = {}) {
  const tree = buildTree(graph, options);
  const ind = (d) => '  '.repeat(d);
  const out = [];
  const rootLabel = tree.roots.map((s) => s.title).join(' / ') || '会话图谱';

  out.push(`# 会话图谱 · ${rootLabel}`, '');
  out.push(`> 导出时间 ${options.stamp || stamp()} · 会话 ${graph.stats.sessions} 个 · 块 ${graph.stats.blocks} 个`);
  out.push('>');
  out.push('> 每个块内用 **问** / **答** 两段区分用户提问与助手回答，正文按其原有 Markdown 结构缩进呈现。', '');

  function blockItem(block, depth) {
    const alias = block.alias ? `（${block.alias}）` : '';
    out.push(`${ind(depth)}- **第 ${block.turn} 轮**${alias}`, '');
    /* 正文以缩进块嵌入，而不是拼在 `- **问**：` 后面 ——
       拼在后面会让表格、代码块、多段列表全塌成一行。 */
    out.push(`${ind(depth + 1)}- **问**`, '');
    out.push(indentBlock(block.prompt, (depth + 2) * 2), '');
    out.push(`${ind(depth + 1)}- **答**`, '');
    out.push(indentBlock(block.response, (depth + 2) * 2), '');
    out.push(`${ind(depth + 1)}- *${block.sessionTitle} · ${block.toolCalls} 个工具 · ${block.deliverables} 个交付物*`, '');
    tree.childrenAt(block.sessionId, block.turn).forEach((s) => sessionItem(s, depth + 1, 'fork'));
    tree.refsAt(block.id).forEach((sid) =>
      sessionItem(graph.sessions.find((s) => s.id === sid), depth + 1, 'ref'));
  }

  function sessionItem(s, depth, mode) {
    if (!s) return;
    const mark = mode === 'ref' ? '🔗 引用' : '⑂ 分叉';
    const label = mode === 'ref' ? s.title.replace(/^引用[:：]\s*/, '') : s.title;
    out.push(`${ind(depth)}- **${mark} → ${label}**`);
    const mine = tree.blocksOf(s.id);
    if (!mine.length) out.push(`${ind(depth + 1)}- *空子会话 · 尚未提问*`);
    else mine.forEach((b) => blockItem(b, depth + 1));
    tree.leftoverChildren(s.id).forEach((c) => sessionItem(c, depth + 1, 'fork'));
  }

  tree.roots.forEach((s) => {
    out.push(`## ${s.title}`, '');
    tree.blocksOf(s.id).forEach((b) => blockItem(b, 0));
    tree.leftoverChildren(s.id).forEach((c) => sessionItem(c, 0, 'fork'));
    out.push('');
  });

  if (tree.keptLinks.length) {
    out.push('---', '', '## 手动连线', '');
    tree.keptLinks.forEach((l) =>
      out.push(`- \`${l.from}\` —${l.label ? ` **${l.label}** ` : ' '}→ \`${l.to}\``));
    out.push('');
  }
  if (tree.skipped.length) {
    out.push('---', '', '## 未导出的连线（端点被隐藏）', '');
    tree.skipped.forEach((l) =>
      out.push(`- \`${l.from}\` → \`${l.to}\`${l.label ? `（${l.label}）` : ''}`));
    out.push('');
  }

  const content = out.join('\n');
  return { content, filename: exportFilename(graph, 'md') };
}

/** 统一入口 */
function render(graph, format, options = {}) {
  return format === 'md' ? toMarkdown(graph, options) : toFreeMind(graph, options);
}

/* ---- src/core/state.js ---- */
/**
 * 会话图谱 · 持久化状态
 *
 * 纯函数，Host 与客户端两侧共用（客户端侧会被内联进 client.js）。
 * 职责：把「界面上的偏好」与「用户创建的关系」规整成可持久化的形态，
 * 并在两个形态之间转换：
 *
 *   持久形态   Ref 用对象 `{ sessionId, turn? }`（需求文档 §5.2）
 *   客户端形态 端点用字符串 id `sessionId:turn` / `header:sessionId`
 *
 * 版本演进照 §5.3：`version` 必填；**未知版本拒绝应用并明说不兼容，不猜测性解析**。
 */

/* id 的约定归 model 管（blockId / emptyId / idToRef / refToId），这里只引用 */

const STATE_VERSION = 1;

/** NFR-1：超限就截断，避免一条癫狂的记录把界面拖死 */
const LIMITS = {
  links: 2000,
  positions: 4000,
  alias: 2000,
  hiddenBlocks: 4000,
  collapsedSessions: 200,
  aliasLength: 200,
  labelLength: 120
};

const sxStr = (v) => (v === undefined || v === null ? '' : String(v));
const sxIsObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function emptyState(now = 0) {
  return {
    version: STATE_VERSION,
    links: [],
    positions: {},
    viewport: null,
    collapsedSessions: [],
    hiddenBlocks: [],
    alias: {},
    updatedAt: now
  };
}

/* --------------------------------------------------------- id ↔ Ref */

/* 实现在 model.js（id 约定归它管）。这里重导出，调用方不必关心住在哪。 */

/* ------------------------------------------------------------ 规整 */

/** 字符串数组：去空、去重、限长 */
const sxUniq = (raw, limit) =>
  [...new Set((Array.isArray(raw) ? raw : []).map(sxStr).filter(Boolean))].slice(0, limit);

/** 干净的初始状态 */
function sxCapObject(raw, limit, mapValue) {
  const out = {};
  if (!sxIsObject(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= limit) break;
    const value = mapValue(v);
    if (value === null) continue;
    out[sxStr(k)] = value;
    n += 1;
  }
  return out;
}

const sxSanitizeLink = (raw, now) => {
  if (!sxIsObject(raw)) return null;
  /* 端点两种形态都收：规范的 Ref 对象，或客户端内部用的字符串 id */
  const fromRef = sxIsObject(raw.from) ? raw.from : idToRef(raw.from);
  const toRef = sxIsObject(raw.to) ? raw.to : idToRef(raw.to);
  if (!sxIsObject(fromRef) || !sxIsObject(toRef)) return null;
  if (!sxStr(fromRef.sessionId) || !sxStr(toRef.sessionId)) return null;
  const kind = raw.kind === 'reference' ? 'reference' : 'link';
  const id = sxStr(raw.id)
    || `${kind}:${refToId(fromRef) || fromRef.sessionId}->${refToId(toRef) || toRef.sessionId}`;
  return {
    id,
    kind,
    from: { sessionId: sxStr(fromRef.sessionId), ...(fromRef.turn ? { turn: Number(fromRef.turn) } : {}) },
    to: { sessionId: sxStr(toRef.sessionId), ...(toRef.turn ? { turn: Number(toRef.turn) } : {}) },
    ...(raw.label ? { label: sxStr(raw.label).slice(0, LIMITS.labelLength) } : {}),
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : now,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : now
  };
};

/**
 * 把任意外来记录规整成合法状态。
 * @returns {object|null} 版本不认识时返回 null（调用方据此拒绝应用，而不是猜）
 */
function sanitizeState(raw, now = 0) {
  if (!sxIsObject(raw)) return null;
  const version = Number(raw.version);
  if (version !== STATE_VERSION) return null;

  const viewport = sxIsObject(raw.viewport)
    ? {
      zoom: sxClamp(raw.viewport.zoom, 0.25, 2, 1),
      panX: sxClamp(raw.viewport.panX, -1e6, 1e6, 0),
      panY: sxClamp(raw.viewport.panY, -1e6, 1e6, 0)
    }
    : null;

  return {
    version: STATE_VERSION,
    links: (Array.isArray(raw.links) ? raw.links : [])
      .slice(0, LIMITS.links).map((l) => sxSanitizeLink(l, now)).filter(Boolean),
    positions: sxCapObject(raw.positions, LIMITS.positions, (v) => {
      if (!sxIsObject(v)) return null;
      const x = Number(v.x);
      const y = Number(v.y);
      return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : null;
    }),
    viewport,
    collapsedSessions: sxUniq(raw.collapsedSessions, LIMITS.collapsedSessions),
    hiddenBlocks: sxUniq(raw.hiddenBlocks, LIMITS.hiddenBlocks),
    alias: sxCapObject(raw.alias, LIMITS.alias, (v) => {
      const text = sxStr(v).trim().slice(0, LIMITS.aliasLength);
      return text === '' ? null : text;
    }),
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : now
  };
}

function sxClamp(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/* -------------------------------------------------------- 增量合并 */

/**
 * 把客户端提交的增量并进状态。**纯函数**，不改原对象。
 *
 * 约定：patch 里出现的键才动，未出现的保持不变；
 * 传 `null` 表示清空该键（例如删除一条连线用 links 的完整列表覆盖）。
 *
 * @param {object} state 已规整的状态
 * @param {object} patch 客户端增量
 * @param {number} now
 */
function mergePatch(state, patch, now = 0) {
  const base = sanitizeState(state, now) || emptyState(now);
  if (!sxIsObject(patch)) return base;
  const next = { ...base, version: STATE_VERSION, updatedAt: now };

  if ('hiddenBlocks' in patch) {
    next.hiddenBlocks = sxUniq(patch.hiddenBlocks, LIMITS.hiddenBlocks);
  }
  if ('alias' in patch) {
    next.alias = sxCapObject(patch.alias, LIMITS.alias, (v) => {
      const text = sxStr(v).trim().slice(0, LIMITS.aliasLength);
      return text === '' ? null : text;
    });
  }
  if ('positions' in patch) {
    next.positions = sxCapObject(patch.positions, LIMITS.positions, (v) => {
      if (!sxIsObject(v)) return null;
      const x = Number(v.x);
      const y = Number(v.y);
      return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : null;
    });
  }
  if ('collapsedSessions' in patch) {
    next.collapsedSessions = sxUniq(patch.collapsedSessions, LIMITS.collapsedSessions);
  }
  if ('viewport' in patch) {
    next.viewport = sxIsObject(patch.viewport)
      ? {
        zoom: sxClamp(patch.viewport.zoom, 0.25, 2, 1),
        panX: sxClamp(patch.viewport.panX, -1e6, 1e6, 0),
        panY: sxClamp(patch.viewport.panY, -1e6, 1e6, 0)
      }
      : null;
  }
  if ('links' in patch) {
    const incoming = (Array.isArray(patch.links) ? patch.links : [])
      .slice(0, LIMITS.links).map((l) => sxSanitizeLink(l, now)).filter(Boolean);
    /* 按 id 覆盖式合并：同一 id 视为更新，其它保留 —— 这样客户端可以只发变化的那几条 */
    const byId = new Map(base.links.map((l) => [l.id, l]));
    incoming.forEach((l) => {
      const prev = byId.get(l.id);
      byId.set(l.id, prev ? { ...prev, ...l, createdAt: prev.createdAt, updatedAt: now } : l);
    });
    next.links = [...byId.values()].slice(0, LIMITS.links);
  }
  if (Array.isArray(patch.removeLinkIds) && patch.removeLinkIds.length) {
    const drop = new Set(patch.removeLinkIds.map(sxStr));
    next.links = next.links.filter((l) => !drop.has(l.id));
  }
  return next;
}

/* ------------------------------------------------- 两侧形态的转换 */

/** 持久形态 → 客户端内部形态（端点换成字符串 id） */
function stateToClient(state) {
  const s = sanitizeState(state, 0) || emptyState(0);
  const hidden = {};
  s.hiddenBlocks.forEach((id) => { hidden[id] = true; });
  const positions = {};
  Object.entries(s.positions).forEach(([id, p]) => { positions[id] = { x: p.x, y: p.y }; });
  return {
    version: s.version,
    hidden,
    alias: { ...s.alias },
    positions,
    viewport: s.viewport ? { ...s.viewport } : null,
    collapsedSessions: [...s.collapsedSessions],
    links: s.links.map((l) => ({
      id: l.id,
      kind: l.kind,
      from: refToId(l.from),
      to: refToId(l.to),
      ...(l.label ? { label: l.label } : {})
    }))
  };
}

/** 客户端增量 → 持久形态增量 */
function clientPatchToState(patch) {
  if (!sxIsObject(patch)) return {};
  const out = {};
  if ('hidden' in patch) {
    out.hiddenBlocks = Object.entries(sxIsObject(patch.hidden) ? patch.hidden : {})
      .filter(([, on]) => !!on).map(([id]) => sxStr(id));
  }
  if ('alias' in patch) out.alias = sxIsObject(patch.alias) ? patch.alias : {};
  if ('positions' in patch) out.positions = sxIsObject(patch.positions) ? patch.positions : {};
  if ('viewport' in patch) out.viewport = patch.viewport;
  if ('collapsedSessions' in patch) {
    out.collapsedSessions = Array.isArray(patch.collapsedSessions) ? patch.collapsedSessions : [];
  }
  if ('links' in patch) {
    out.links = (Array.isArray(patch.links) ? patch.links : []).map((l) => ({
      ...l,
      from: sxIsObject(l.from) ? l.from : idToRef(l.from),
      to: sxIsObject(l.to) ? l.to : idToRef(l.to)
    })).filter((l) => l.from && l.to);
  }
  if (Array.isArray(patch.removeLinkIds)) out.removeLinkIds = patch.removeLinkIds;
  /* 落盘前先过一遍规整，别把畸形数据写进去 */
  const cleaned = {};
  const normalized = mergePatch(emptyState(0), out, 0);
  if ('hiddenBlocks' in out) cleaned.hiddenBlocks = normalized.hiddenBlocks;
  if ('alias' in out) cleaned.alias = normalized.alias;
  if ('positions' in out) cleaned.positions = normalized.positions;
  if ('viewport' in out) cleaned.viewport = normalized.viewport;
  if ('collapsedSessions' in out) cleaned.collapsedSessions = normalized.collapsedSessions;
  if ('links' in out) cleaned.links = normalized.links;
  if (out.removeLinkIds) cleaned.removeLinkIds = out.removeLinkIds;
  return cleaned;
}

/* ------------------------------------------------------------ 其他 */

/** 状态里引用了哪些会话 —— 家族判定与清理用得上 */
function sessionsInState(state) {
  const s = sanitizeState(state, 0);
  if (!s) return [];
  const ids = new Set();
  s.links.forEach((l) => { ids.add(l.from.sessionId); ids.add(l.to.sessionId); });
  s.hiddenBlocks.forEach((id) => { const r = idToRef(id); if (r) ids.add(r.sessionId); });
  Object.keys(s.alias).forEach((id) => { const r = idToRef(id); if (r) ids.add(r.sessionId); });
  s.collapsedSessions.forEach((id) => ids.add(id));
  return [...ids];
}

/* ============================================================
   会话图谱 · 客户端应用
   本文件由 scripts/build-client.mjs 原样追加到生成的 client.js 中，
   运行在 __ModuleLoader__ 的 factory 作用域里，因此可以直接使用
   上面已经内联的核心函数（buildGraph / layout / render ...）。

   约束（NFR-2）：只用 --dsw-* 主题变量；除 react 与宿主的 primitives 基础件外
   不 require 别的包；不向 document.body 追加；样式以 React 元素渲染，随组件卸载移除。
   ============================================================ */

const NS = 'dsh-plugin-session-graph';
const TARGET = 'session-graph';
const VIEW_ORDER = 20;

/* 宿主的 UI 基础件是**基线模块**：`dsh-client-ui-conversation` 自己也这样直接 require，
   没有任何客户端插件把它写进 dsh.client.external。直接用它渲染 Markdown，
   与产品其余部分的排版完全一致，也不必自己造一套解析器。 */
const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
/* 取不到就退化成纯文本：宁可排版朴素，也不能因为一个导出缺失让整个视图崩掉 */
const MarkdownText = (primitives && primitives.MarkdownText) || null;
const extractMarkdownPlainText = (primitives && primitives.extractMarkdownPlainText) || null;

/** MarkdownText 要求一整份界面文案；键就这 6 个 */
const MD_LABELS = {
  code: {
    copyLabel: '复制',
    copiedLabel: '已复制',
    toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '不换行' }
  },
  footnotes: '脚注'
};

/** 正文渲染：优先用宿主的渲染器，缺失时退回纯文本 */
function markdownBlock(text, key) {
  if (!MarkdownText) return h('div', { key, className: 'sg-tx' }, text);
  return h('div', { key, className: 'sg-md' },
    h(MarkdownText, { text, labels: MD_LABELS, variant: 'compact' }));
}

/**
 * 摘要成单行：优先用宿主自己的 Markdown 抽取（与产品一致），
 * 拿不到时退回核心模块里的正则实现。
 */
function digest(text, mode) {
  const src = String(text === undefined || text === null ? '' : text);
  if (src.trim() === '') return '';
  let plainText = '';
  if (extractMarkdownPlainText) {
    try {
      plainText = extractMarkdownPlainText(src, { mode: mode || 'first-line' });
    } catch {
      plainText = '';
    }
  }
  return squash(plainText || summarize(src));
}

const CSS = `
.sg-root{position:absolute;inset:0;display:flex;font-family:inherit;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);user-select:none;-webkit-user-select:none}
.sg-canvas-wrap{flex:1;min-width:0;position:relative;overflow:hidden;user-select:none;-webkit-user-select:none;
  cursor:grab;
  background-image:radial-gradient(var(--dsw-alias-border-l2) 1px,transparent 1px);background-size:22px 22px}
.sg-canvas-wrap.sg-panning{cursor:grabbing}
.sg-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
.sg-world svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.sg-e-branch{fill:none;stroke:var(--dsw-alias-label-dimmed);stroke-width:1.6}
.sg-e-link{fill:none;stroke:var(--dsw-alias-state-business-primary);stroke-width:1.6;stroke-dasharray:6 5}
.sg-e-ref{fill:none;stroke:var(--dsw-alias-label-caption);stroke-width:1.7;stroke-dasharray:1.5 4.5}
/* 端点已不存在的边：保留数据但画不出来，用样式说明而不假装它不存在 */
.sg-e-broken{stroke:var(--dsw-alias-state-error-primary);stroke-dasharray:2 3;opacity:.55}
/* 边标签：落在边中点，过长截断、悬停看全文（FR-9） */
.sg-elabel{position:absolute;transform:translate(-50%,-50%);max-width:150px;padding:1px 6px;
  border-radius:5px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-stroke);
  font-size:10.5px;line-height:1.5;color:var(--dsw-alias-state-business-primary);cursor:pointer;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none}
.sg-elabel:hover{background:var(--dsw-alias-bg-layer-2)}
.sg-elabel-ref{color:var(--dsw-alias-label-caption)}
.sg-elabel-broken{color:var(--dsw-alias-state-error-primary);text-decoration:line-through}
.sg-node{position:absolute;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);
  box-shadow:var(--dsw-elevation-stroke);padding:8px 11px;display:flex;flex-direction:column;gap:3px;
  cursor:grab;user-select:none;transition:background .12s,box-shadow .12s}
.sg-node:hover{background:var(--dsw-alias-bg-layer-2)}
.sg-node:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary),var(--dsw-elevation-panel)}
.sg-node.sg-current{border-left:3px solid var(--dsw-alias-state-business-primary);padding-left:9px}
.sg-node.sg-selected{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary),var(--dsw-elevation-panel)}
.sg-node.sg-hidden{opacity:.28;border:1.5px dashed var(--dsw-alias-border-l4);background:transparent}
.sg-node.sg-empty{cursor:default;border:1.5px dashed var(--dsw-alias-border-l4);background:transparent;
  box-shadow:none;display:grid;place-items:center;text-align:center;font-size:11.5px;
  color:var(--dsw-alias-label-caption);pointer-events:none}
.sg-hd{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-caption)}
.sg-hd .sg-turn{font-weight:600}
.sg-hd .sg-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.sg-hd .sg-dot.sg-open{background:var(--dsw-alias-state-warn-primary)}
.sg-hd .sg-dot.sg-failed{background:var(--dsw-alias-state-error-primary)}
.sg-hd .sg-sp{flex:1}
.sg-badge{display:inline-flex;align-items:center;gap:3px;height:15px;padding:0 5px;border-radius:4px;
  background:var(--dsw-alias-markdown-tag);font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
/* 提问行只放提问本身 —— 轮次号已经在上一行的 sg-hd 里了，这里再兜底显示一遍就是重复 */
.sg-ask{font-size:12.5px;color:var(--dsw-alias-label-primary);line-height:1.35;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.sg-ask.sg-empty{color:var(--dsw-alias-label-caption)}
.sg-ans{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.35;overflow:hidden;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.sg-label{position:absolute;height:26px;display:flex;align-items:center;gap:7px;padding:0 9px;border-radius:7px;
  background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);white-space:nowrap;
  cursor:pointer;user-select:none;font-size:12px}
.sg-label.sg-current{background:var(--dsw-alias-state-business-tertiary);border-color:transparent}
.sg-label .sg-sdot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.sg-label.sg-current .sg-sdot{background:var(--dsw-alias-state-business-primary)}
.sg-label .sg-st{font-weight:600;color:var(--dsw-alias-label-primary);max-width:210px;overflow:hidden;
  text-overflow:ellipsis}
.sg-label .sg-sm{color:var(--dsw-alias-label-caption);font-size:11px}
.sg-tools{position:absolute;top:12px;right:12px;display:flex;align-items:center;gap:4px;padding:4px;
  border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);z-index:8}
.sg-btn{height:26px;padding:0 9px;border:none;border-radius:7px;background:transparent;cursor:pointer;
  font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:5px}
.sg-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sg-btn.sg-on{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.sg-zoom{font-size:11.5px;color:var(--dsw-alias-label-caption);padding:0 6px;font-variant-numeric:tabular-nums}
.sg-hint{position:absolute;left:12px;bottom:12px;font-size:11.5px;color:var(--dsw-alias-label-caption);
  background:var(--dsw-alias-bg-layer-1);border-radius:7px;padding:5px 10px;box-shadow:var(--dsw-elevation-stroke);z-index:8}
.sg-hint-warn{left:auto;right:12px;bottom:12px;color:var(--dsw-alias-state-warn-primary)}
/* 只读标记：存储不可用或存档版本不认识时挂在工具条上 */
.sg-ro{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:5px;
  background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);
  font-size:11px;white-space:nowrap}
/* 右栏：元信息与操作**固定**在上，只有正文区滚动。
   正文可能很长，若把它排在前面，元信息和操作会被永远挤出可视区。 */
.sg-side{flex:0 0 clamp(320px, 26vw, 430px);border-left:.5px solid var(--dsw-alias-border-l1);display:flex;
  flex-direction:column;min-height:0;user-select:text;-webkit-user-select:text}
.sg-side-hd{padding:13px 15px 11px;border-bottom:.5px solid var(--dsw-alias-border-l1);display:flex;
  align-items:center;gap:8px;flex:0 0 auto}
.sg-side-hd .sg-t{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);flex:0 0 auto}
.sg-side-hd .sg-s{font-size:11.5px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;min-width:0}
.sg-x{margin-left:auto;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;
  font-size:15px;padding:2px 5px;border-radius:5px;flex:0 0 auto}
.sg-x:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sg-side-meta{padding:12px 15px 0;flex:0 0 auto}
.sg-side-acts{padding:12px 15px 13px;flex:0 0 auto;border-top:.5px solid var(--dsw-alias-border-l1);
  margin-top:12px;display:flex;flex-direction:column;gap:7px}
/* 唯一滚动的区域 */
.sg-side-bd{flex:1;overflow-y:auto;padding:12px 15px 16px;min-height:0}
/* 小标题在正文区与固定区都要用，所以不做后代限定 */
.sg-lb{font-size:11px;font-weight:600;letter-spacing:.05em;color:var(--dsw-alias-label-caption);
  margin-bottom:6px}
.sg-sec{margin-bottom:15px}
.sg-sec .sg-lb{margin-bottom:6px}
.sg-sec .sg-tx{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word}
.sg-sec .sg-tx.sg-strong{color:var(--dsw-alias-label-primary)}
/* 宿主 markdown 渲染器的容器：面板只有 330px，宽内容要能横向滚而不是撑破布局 */
.sg-md{font-size:12.5px}
.sg-md>div{font-size:12.5px}
.sg-md table{display:block;width:max-content;max-width:100%;overflow-x:auto;font-size:11.5px}
.sg-md pre{max-width:100%;overflow-x:auto}
.sg-md img,.sg-md svg{max-width:100%;height:auto}
.sg-md>*:first-child{margin-top:0}
.sg-md>*:last-child{margin-bottom:0}
.sg-meta{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12px}
.sg-meta .sg-k{color:var(--dsw-alias-label-caption)}
.sg-meta .sg-v{color:var(--dsw-alias-label-secondary);text-align:right}
.sg-acts{display:flex;flex-direction:column;gap:7px}
.sg-act{height:34px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;
  cursor:pointer;display:flex;align-items:center;gap:9px;padding:0 11px;text-align:left}
.sg-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sg-act.sg-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-on-brand,#fff);
  border-color:transparent;font-weight:600}
.sg-act:disabled{opacity:.45;cursor:not-allowed}
.sg-emptybox{padding:30px 18px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-caption);line-height:1.7}
.sg-err{margin:16px;padding:12px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.sg-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,#0000003d);display:grid;place-items:center;z-index:20}
.sg-dlg{width:760px;max-width:calc(100% - 40px);max-height:calc(100% - 40px);display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-lg,16px);
  box-shadow:var(--dsw-elevation-prominent);overflow:hidden}
.sg-dlg-hd{padding:14px 16px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);display:flex;align-items:center;gap:9px}
.sg-dlg-hd .sg-t{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary);flex:0 0 auto}
.sg-dlg-hd .sg-s{font-size:11.5px;color:var(--dsw-alias-label-caption);min-width:0;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.sg-dlg-bd{padding:14px 16px;overflow-y:auto;min-height:0}
.sg-row{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.sg-row .sg-lb{font-size:12px;color:var(--dsw-alias-label-caption);width:56px;flex:0 0 56px}
.sg-seg{display:inline-flex;padding:3px;border-radius:9px;background:var(--dsw-alias-bg-module-platform);gap:3px}
.sg-seg button{height:28px;padding:0 12px;border:none;border-radius:7px;background:transparent;cursor:pointer;
  font:inherit;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.sg-seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font-weight:600;box-shadow:var(--dsw-elevation-stroke)}
.sg-chk{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
/* 长行折行而不是横向裁切：「.mm」的富文本行本来就长，横向滚动读不了 */
.sg-prev{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);
  background:var(--dsw-alias-bg-module-platform);padding:11px 13px;font-family:ui-monospace,Consolas,monospace;
  font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;
  overflow-wrap:anywhere;overflow-y:auto;max-height:280px}
.sg-dlg-ft{padding:11px 16px;border-top:.5px solid var(--dsw-alias-border-l1);display:flex;align-items:center;gap:9px}
/* min-width:0 是关键：flex 项默认 min-width:auto，长提示会把按钮挤出对话框 */
.sg-dlg-ft .sg-hi{flex:1;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-caption)}
.sg-bigbtn{height:32px;padding:0 15px;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;font:inherit;
  font-size:12.5px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary)}
.sg-bigbtn.sg-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-on-brand,#fff);
  border-color:transparent;font-weight:600}
`;

/* ------------------------------------------------------------ 小工具 */

/** 订阅一个快照源。只依赖 { getSnapshot, subscribe } 这两个方法。 */
function useSource(source) {
  const [value, setValue] = React.useState(() => {
    try { return source && source.getSnapshot ? source.getSnapshot() : undefined; } catch { return undefined; }
  });
  React.useEffect(() => {
    if (!source || typeof source.subscribe !== 'function') return undefined;
    let alive = true;
    const pull = () => { if (alive) { try { setValue(source.getSnapshot()); } catch { /* 源暂时不可读 */ } } };
    pull();
    const off = source.subscribe(pull);
    return () => { alive = false; if (typeof off === 'function') off(); };
  }, [source]);
  return value;
}

/** 会话列表快照 → 数组。宿主可能给它套好几层壳，这里尽量都认。 */
function listOf(snapshot) {
  if (!snapshot) return [];
  if (Array.isArray(snapshot)) return snapshot;
  for (const key of ['items', 'sessions', 'rows', 'list', 'entries']) {
    if (Array.isArray(snapshot[key])) return snapshot[key];
  }
  if (snapshot.byId && typeof snapshot.byId === 'object') return Object.values(snapshot.byId);
  return [];
}

/** 当前会话 id：优先用槽位注入给的，缺失时从会话目录里找一个像样的 */
function resolveSessionId(props, snapshot) {
  if (props && props.sessionId) return props.sessionId;
  const sessions = props && props.sessions;
  if (sessions) {
    for (const key of ['current', 'currentId', 'activeId']) {
      const v = typeof sessions[key] === 'function' ? sessions[key]() : sessions[key];
      if (typeof v === 'string' && v) return v;
    }
  }
  const list = listOf(snapshot);
  const marked = list.find((s) => s && (s.current === true || s.active === true));
  if (marked) return marked.id || marked.sessionId;
  return list.length === 1 ? (list[0].id || list[0].sessionId) : '';
}

/* ------------------------------------------------------------ 主组件 */

function GraphView(props) {
  const { ctx, target, sessions } = props || {};
  const listSnapshot = useSource(sessions && sessions.list);
  const sessionId = resolveSessionId(props, listSnapshot);
  const [selected, setSelected] = React.useState(null);
  const [hidden, setHidden] = React.useState({});
  const [alias, setAlias] = React.useState({});
  const [links, setLinks] = React.useState([]);
  const [selectedEdge, setSelectedEdge] = React.useState(null);
  /* 持久化：存档读回来之后才允许写，避免首帧的空状态把存档冲掉 */
  const [writable, setWritable] = React.useState(true);
  const [incompatible, setIncompatible] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');
  const [loaded, setLoaded] = React.useState(false);
  const [showHidden, setShowHidden] = React.useState(false);
  const [collapseOthers, setCollapseOthers] = React.useState(false);
  const [view, setView] = React.useState({ scale: 1, panX: 24, panY: 20, fitted: false });
  const [exportOpen, setExportOpen] = React.useState(false);
  const [exportFmt, setExportFmt] = React.useState('mm');
  const [exportHidden, setExportHidden] = React.useState(false);
  const [toast, setToast] = React.useState('');
  /* 只留一个"路由是否可用"的布尔量，给空态说人话用；不对外暴露状态码 */
  const [routeOk, setRouteOk] = React.useState(true);
  const hostRef = React.useRef(null);
  const [size, setSize] = React.useState({ w: 900, h: 600 });

  const graphSnapshot = useSource(target);

  /* 视口尺寸：跟随容器，切换视图后回来仍正确 */
  React.useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth || 900, h: el.clientHeight || 600 });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth || 900, h: el.clientHeight || 600 });
    return () => ro.disconnect();
  }, []);

  /* 每次数据变化重建图模型 */
  const sessionsNorm = React.useMemo(() => normalizeSessions(listOf(listSnapshot)), [listSnapshot]);
  const sessionKey = sessionsNorm.map((s) => s.id).join(',');
  const localTurns = React.useMemo(
    () => turnsFromTimeline(graphSnapshot && graphSnapshot.timeline),
    [graphSnapshot]
  );

  /* 家族里其他会话的轮次要向 Host 取（本地的装配器时间线只覆盖当前会话）。
     取不到就退化成"只有当前会话有块"——家族骨架仍然完整。 */
  const [remote, setRemote] = React.useState(null);
  /* 存档里的家族根 id 与视口，写回时要用 */
  const familyRef = React.useRef('');
  const savedViewportRef = React.useRef(null);
  /* 存档读回来之前禁止写：否则首帧的空状态会把已存的隐藏/别名冲掉 */
  const loadedRef = React.useRef(false);

  React.useEffect(() => {
    if (!sessionId) return undefined;
    let alive = true;
    const url = '/api/session.graph-export'
      + '?format=json'
      + '&sessionId=' + encodeURIComponent(sessionId)
      + (sessionKey ? '&sessions=' + encodeURIComponent(sessionKey) : '');
    const carrier = typeof fetch === 'function' ? fetch : null;
    if (!carrier) { setRouteOk(false); setLoaded(true); return undefined; }
    carrier(url, { credentials: 'same-origin' })
      .then((r) => {
        if (!alive) return null;
        setRouteOk(!!(r && r.ok));
        return r && r.ok ? r.json() : null;
      })
      .then((data) => {
        if (!alive) return;
        if (!data) { setLoaded(true); loadedRef.current = true; return; }
        if (data.turns) setRemote(data.turns);
        if (typeof data.rootId === 'string') familyRef.current = data.rootId;
        /* 存档是基线，界面上的改动在此之上叠加 */
        const saved = data.state || null;
        setHidden(saved && saved.hidden ? saved.hidden : {});
        setAlias(saved && saved.alias ? saved.alias : {});
        setLinks(saved && saved.links ? saved.links : []);
        setWritable(data.writable !== false);
        setIncompatible(!!data.incompatible);
        savedViewportRef.current = (saved && saved.viewport) || null;
        loadedRef.current = true;
        setLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        setRouteOk(false);
        loadedRef.current = true;
        setLoaded(true);
      });
    return () => { alive = false; };
  }, [sessionId, sessionKey]);

  /* 写回：交互写入按帧合并后节流提交（§5.3 的写入策略） */
  const writableRef = React.useRef(true);
  writableRef.current = writable;
  const pendingRef = React.useRef(null);
  const timerRef = React.useRef(null);
  const persist = React.useCallback((patch) => {
    if (!loadedRef.current || !writableRef.current) return;
    const payload = clientPatchToState(patch);
    if (!Object.keys(payload).length) return;
    pendingRef.current = { ...(pendingRef.current || {}), ...payload };
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const body = pendingRef.current;
      pendingRef.current = null;
      if (!body || !familyRef.current || typeof fetch !== 'function') return;
      fetch('/api/session.graph-export', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ familyRootId: familyRef.current, patch: body })
      }).then((r) => {
        if (r && r.ok) { setSaveError(''); return; }
        /* 提交失败：保留内存状态并标记未保存，而不是回滚用户刚做的操作 */
        setSaveError(r && r.status === 409 ? '存档由更新的版本写入，本次改动未保存' : '改动未能保存');
        if (r && r.status === 409) setIncompatible(true);
      }).catch(() => setSaveError('改动未能保存'));
    }, 400);
  }, []);

  const clearPending = React.useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    pendingRef.current = null;
  }, []);
  React.useEffect(() => () => clearPending(), [clearPending]);

  const turnsBySession = React.useMemo(() => {
    const out = { ...(remote || {}) };
    if (!sessionId || !localTurns.length) return out;
    /* 逐字段合并，而不是整条覆盖。
       本地时间线更新更快，但它的轮次记录里**没有问答文本**（文本在 data 这个 Map 里，
       按插件定义键存放），远程读的是原始事件、文本是齐的——
       整条覆盖会把文本抹成空。 */
    const byTurn = new Map((out[sessionId] || []).map((t) => [t.turn, t]));
    localTurns.forEach((t) => {
      const prev = byTurn.get(t.turn) || {};
      byTurn.set(t.turn, {
        ...prev,
        ...t,
        prompt: t.prompt || prev.prompt || '',
        response: t.response || prev.response || '',
        toolCalls: t.toolCalls || prev.toolCalls || 0,
        deliverables: t.deliverables || prev.deliverables || 0
      });
    });
    out[sessionId] = [...byTurn.values()].sort((a, b) => a.turn - b.turn);
    return out;
  }, [remote, localTurns, sessionId]);

  const graph = React.useMemo(() => {
    try {
      return buildGraph({
        sessions: sessionsNorm,
        turnsBySession,
        currentId: sessionId,
        hidden, alias, links,
        includeHidden: showHidden
      });
    } catch (e) {
      return { error: e };
    }
  }, [sessionsNorm, turnsBySession, sessionId, hidden, alias, links, showHidden]);

  const laid = React.useMemo(() => {
    if (!graph || graph.error) return { nodes: [], headers: new Map(), bounds: null, opts: DEFAULT_LAYOUT };
    try { return layout(graph); } catch { return { nodes: [], headers: new Map(), bounds: null, opts: DEFAULT_LAYOUT }; }
  }, [graph]);

  const nodeMap = React.useMemo(() => new Map(laid.nodes.map((n) => [n.id, n])), [laid]);

  /* 视口是否被**用户**动过：挂载时把刚恢复的视口原样写回去是纯浪费，
     而且会让「打开一次图谱」产生一次写入。
     声明放在最前 —— 下面几个副作用会引用它。 */
  const viewTouchedRef = React.useRef(false);

  /* 首次适应视图：**等存档回来再定视口**，否则会先按默认位置摆好、
     存档里的缩放与平移就白存了。 */
  React.useEffect(() => {
    if (view.fitted || !laid.nodes.length || !loaded) return;
    const saved = savedViewportRef.current;
    if (saved) setView({ scale: saved.zoom, panX: saved.panX, panY: saved.panY, fitted: true });
    else setView({ ...fitView(laid.nodes, size.w, size.h), fitted: true });
  }, [laid, size, view.fitted, loaded]);

  /* 视口变化后节流写回；只在**用户动过**之后写，且用取整后的键避免亚像素抖动 */
  const viewKey = Math.round(view.scale * 1000) + ':' + Math.round(view.panX) + ':' + Math.round(view.panY);
  React.useEffect(() => {
    if (!loaded || !view.fitted || !viewTouchedRef.current) return;
    persist({ viewport: { zoom: view.scale, panX: view.panX, panY: view.panY } });
  }, [viewKey, loaded, persist]);

  const fit = React.useCallback(() => {
    viewTouchedRef.current = true;
    setView({ ...fitView(laid.nodes, size.w, size.h), fitted: true });
  }, [laid, size]);

  const say = React.useCallback((m) => {
    setToast(m);
    setTimeout(() => setToast(''), 2600);
  }, []);

  /* ---- 交互 ---- */
  const drag = React.useRef(null);
  const [panning, setPanning] = React.useState(false);

  const onWheel = React.useCallback((ev) => {
    ev.preventDefault();
    viewTouchedRef.current = true;
    const r = hostRef.current ? hostRef.current.getBoundingClientRect() : { left: 0, top: 0 };
    const mx = ev.clientX - r.left;
    const my = ev.clientY - r.top;
    setView((v) => {
      const next = Math.max(0.25, Math.min(2, v.scale * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
      const k = next / v.scale;
      return { scale: next, panX: mx - (mx - v.panX) * k, panY: my - (my - v.panY) * k, fitted: true };
    });
  }, []);

  const onDown = React.useCallback((ev) => {
    const el = ev.target;
    if (el.closest && el.closest('.sg-tools')) return;
    if (ev.button !== 0) return;

    /* 必须掐掉按下事件的默认行为：否则浏览器会从画布背后的文字节点起选区，
       拖一次就横跨工具栏、提示条与输入框拉出一整页蓝色高亮。
       preventDefault 同时会挡住自动聚焦，所以这里手动把焦点收回到画布，
       方向键导航才继续可用。 */
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    if (hostRef.current && typeof hostRef.current.focus === 'function') {
      try { hostRef.current.focus({ preventScroll: true }); } catch { /* 老浏览器不吃参数 */ }
    }

    const nodeEl = el.closest ? el.closest('[data-sg-node]') : null;
    const id = nodeEl ? nodeEl.getAttribute('data-sg-node') : null;
    const hit = id && nodeMap.has(id) ? id : null;
    /* 在**按下**时选中，而不是等抬起：双击过程中手抖一两个像素很常见，
       若靠"没移动过"来决定选中，双击就会既不选中、又照样分叉 */
    if (hit) setSelected(hit);
    drag.current = {
      kind: 'pan',
      sx: ev.clientX, sy: ev.clientY,
      px: view.panX, py: view.panY,
      moved: false,
      id: hit
    };
    setPanning(true);
  }, [nodeMap, view]);

  React.useEffect(() => {
    const move = (ev) => {
      const d = drag.current;
      if (!d) return;
      /* 拖拽期间持续拦默认行为：挡住原生的拖放、拖拽滚动与选区 */
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      const dx = ev.clientX - d.sx;
      const dy = ev.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) { d.moved = true; viewTouchedRef.current = true; }
      if (d.kind === 'pan') setView((v) => ({ ...v, panX: d.px + dx, panY: d.py + dy, fitted: true }));
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      setPanning(false);
      /* 空白处单击（且没拖动）才清选中；点在块上时选中已在按下时给过了 */
      if (d && !d.moved && !d.id) setSelected(null);
    };
    /* 拖到窗口外再松手也要收尾，否则拖拽状态会一直挂着 */
    const cancel = (ev) => { if (ev && ev.key === 'Escape') { drag.current = null; setPanning(false); } };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('blur', up);
    window.addEventListener('keydown', cancel, true);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('blur', up);
      window.removeEventListener('keydown', cancel, true);
    };
  }, []);

  const onKeyDown = React.useCallback((ev) => {
    const k = ev.key;
    if (k === 'f' || k === 'F') { ev.preventDefault(); fit(); return; }
    if (k === 'Escape') { ev.preventDefault(); setExportOpen(false); setSelected(null); return; }
    if (k.indexOf('Arrow') === 0) {
      ev.preventDefault();
      const next = moveSelection(laid.nodes, selected, k);
      if (next) setSelected(next);
    }
  }, [fit, laid, selected]);

  /* ---- 动作 ---- */
  const doFork = React.useCallback((sid, turn) => {
    const block = graph.blocks.find((b) => b.sessionId === sid && b.turn === turn);
    if (block && block.status === 'open') { say('该轮尚未结束，不能从这里分叉'); return; }
    const atSeq = block ? block.endSeq : null;
    if (atSeq === null || atSeq === undefined) { say('这一轮没有可用的分叉边界，可能尚未载入'); return; }
    try {
      const titles = graph.sessions.map((s) => s.title);
      const src = graph.sessions.find((s) => s.id === sid);
      const childTitle = src ? uniqueTitle(src.title, titles) : undefined;
      const p = ctx.sessions.fork({ sessionId: sid, atSeq, increaseTitle: true, onCreated: () => undefined });
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          const code = err && err.rpcError ? err.rpcError.code : '';
          if (code === 'session/fork-unavailable') say('没有可用的已完成轮次');
          else if (code === 'session/not-found') say('源会话不可用，请刷新图谱');
          else say('分叉失败：' + (err && err.message ? err.message : String(err)));
        });
      }
      say('已从第 ' + turn + ' 轮分叉' + (childTitle ? ' → ' + childTitle : ''));
    } catch (e) {
      say('分叉失败：' + (e && e.message ? e.message : String(e)));
    }
  }, [ctx, graph, say]);

  const openSession = React.useCallback((sid) => {
    if (typeof ctx.sessions.retain === 'function') { try { ctx.sessions.retain(sid); } catch { /* 已保留 */ } }
    if (typeof props.onOpenSession === 'function') props.onOpenSession(sid);
    else say('请在左侧会话列表中选择该会话');
  }, [ctx, props, say]);

  /* 导出：生成内容 → 不挂到 body 的 anchor 触发下载 */
  const exportText = React.useCallback((fmt, includeHidden) => {
    const g = buildGraph({
      sessions: sessionsNorm, turnsBySession, currentId: sessionId,
      hidden, alias, links, includeHidden
    });
    return render(g, fmt, { links, stamp: stamp(new Date()) });
  }, [sessionsNorm, turnsBySession, sessionId, hidden, alias, links]);

  /* 导出（FR-15）：优先走 Host 路由——先 HEAD 预检，通过后交给浏览器下载管理器；
     路由不可用时回落到本地生成 + Blob，保证功能不因为接线问题而消失。 */
  const routeUrl = React.useCallback((fmt, includeHidden) => {
    const ids = sessionsNorm.map((s) => s.id).join(',');
    return '/api/session.graph-export'
      + '?format=' + fmt
      + '&sessionId=' + encodeURIComponent(sessionId)
      + (ids ? '&sessions=' + encodeURIComponent(ids) : '')
      + (includeHidden ? '&includeHidden=true' : '')
      + (Object.keys(hidden).length ? '&hidden=' + encodeURIComponent(JSON.stringify(hidden)) : '')
      + (Object.keys(alias).length ? '&alias=' + encodeURIComponent(JSON.stringify(alias)) : '');
  }, [sessionsNorm, sessionId, hidden, alias]);

  const saveUrl = React.useCallback((url, filename) => {
    /* 与产品既有会话日志导出同一手法：anchor 不挂到 document.body，直接 click() */
    const a = document.createElement('a');
    a.href = url;
    if (filename) a.download = filename;
    a.click();
  }, []);

  const doDownload = React.useCallback(async () => {
    const fmt = exportFmt;
    let filename = '';
    try {
      const out = exportText(fmt, exportHidden);
      filename = out.filename;
    } catch (e) {
      say('导出失败：' + (e && e.message ? e.message : String(e)));
      return;
    }
    const url = routeUrl(fmt, exportHidden);
    try {
      if (typeof fetch === 'function') {
        const head = await fetch(url, { method: 'HEAD', credentials: 'same-origin' });
        if (head && head.ok) {
          saveUrl(url);                      /* 文件名由 Content-Disposition 决定 */
          setExportOpen(false);
          say('已开始下载 ' + filename);
          return;
        }
      }
    } catch { /* 预检失败 → 走本地回落 */ }
    try {
      const out = exportText(fmt, exportHidden);
      const blobUrl = URL.createObjectURL(new Blob([out.content], {
        type: fmt === 'mm' ? 'application/xml' : 'text/markdown'
      }));
      saveUrl(blobUrl, out.filename);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      setExportOpen(false);
      say('已开始下载 ' + out.filename + '（本地生成）');
    } catch (e) {
      say('导出失败：' + (e && e.message ? e.message : String(e)));
    }
  }, [exportFmt, exportHidden, exportText, routeUrl, saveUrl, say]);

  /* ---- 渲染 ---- */
  const nodes = showHidden ? laid.nodes : laid.nodes.filter((n) => !(n.kind === 'block' && n.block.hidden));
  const cell = nodes.map((n) => {
    if (n.kind === 'header') {
      return h('div', {
        key: n.id,
        className: 'sg-label' + (n.sessionId === sessionId ? ' sg-current' : ''),
        style: { left: n.x, top: n.y, minWidth: n.w, height: n.h },
        title: '点击切换到这个会话',
        onClick: () => openSession(n.sessionId)
      },
      h('span', { className: 'sg-sdot' }),
      h('span', { className: 'sg-st' }, n.title),
      h('span', { className: 'sg-sm' }, n.turnCount + ' 轮'));
    }
    if (n.kind === 'empty') {
      return h('div', {
        key: n.id, className: 'sg-node sg-empty',
        style: { left: n.x, top: n.y, width: n.w, minHeight: n.h }
      }, h('span', null, '空子会话 · 尚未提问'));
    }
    const b = n.block;
    const cls = 'sg-node'
      + (b.current ? ' sg-current' : '')
      + (selected === n.id ? ' sg-selected' : '')
      + (b.hidden && showHidden ? ' sg-hidden' : '');
    const badges = [];
    if (b.toolCalls) badges.push(h('span', { key: 't', className: 'sg-badge' }, '⚙ ' + b.toolCalls));
    if (b.deliverables) badges.push(h('span', { key: 'd', className: 'sg-badge' }, '⧉ ' + b.deliverables));
    return h('div', {
      key: n.id,
      className: cls,
      'data-sg-node': n.id,
      tabIndex: 0,
      role: 'button',
      'aria-label': '第 ' + b.turn + ' 轮：' + b.prompt,
      style: { left: n.x, top: n.y, width: n.w, minHeight: n.h },
      onDoubleClick: (e) => { e.stopPropagation(); doFork(b.sessionId, b.turn); },
      onKeyDown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); setSelected(n.id); } }
    },
    h('div', { className: 'sg-hd' },
      h('span', { className: 'sg-turn' }, '第 ' + b.turn + ' 轮'),
      h('span', { className: 'sg-dot' + (b.status === 'open' ? ' sg-open' : b.status === 'failed' ? ' sg-failed' : '') }),
      h('span', { className: 'sg-sp' }),
      badges),
    h('div', { className: 'sg-ask' + (digest(b.prompt) ? '' : ' sg-empty') },
      b.alias ? '✎ ' + b.alias : (clip(digest(b.prompt), 110) || '（该轮提问尚未载入）')),
    h('div', { className: 'sg-ans' }, clip(digest(b.response, 'first-paragraph'), 220) || '（该轮回答尚未载入）'));
  });

  /* 三种边不只靠颜色区分（§5.2）：线型不同，箭头也分实心与空心 */
  const edgeList = graph.error ? [] : graph.edges;
  const edges = edgeList.map((e) => {
    const d = edgePath(e, nodeMap);
    if (!d) return null;
    const cls = e.kind === 'link' ? 'sg-e-link'
      : e.kind === 'reference' ? 'sg-e-ref' : 'sg-e-branch';
    return h('path', {
      key: e.id,
      className: cls + (e.broken ? ' sg-e-broken' : ''),
      d,
      'data-sg-edge': e.id,
      markerEnd: e.kind === 'branch' || e.kind === 'link'
        ? 'url(#sg-arrow-solid)' : 'url(#sg-arrow-hollow)'
    });
  }).filter(Boolean);

  /* 标签落在边中点；过长由 CSS 截断，title 给完整文本（FR-9） */
  const edgeLabels = edgeList.map((e) => {
    if (!e.label) return null;
    const p = edgeMidpoint(e, nodeMap);
    if (!p) return null;
    return h('div', {
      key: 'el:' + e.id,
      className: 'sg-elabel' + (e.kind === 'reference' ? ' sg-elabel-ref' : '')
        + (e.broken ? ' sg-elabel-broken' : ''),
      style: { left: p.x, top: p.y },
      title: e.label,
      onClick: (ev) => { ev.stopPropagation(); setSelectedEdge(e.id); }
    }, e.label);
  }).filter(Boolean);

  /* 断裂的边指向已不存在的块：几何上画不出来，但**不能装作没这回事** */
  const brokenCount = edgeList.filter((e) => e.broken).length;

  /* 空态说人话（FR-13）：不暴露状态码，只告诉用户现在能看到什么、可以做什么 */
  const body = graph.error
    ? h('div', { className: 'sg-err' },
        '图谱没能装配起来。',
        h('br'),
        '可以把当前视图切到「对话」再切回来重试；若一直如此，请反馈这条信息：' + graph.error.message)
    : !laid.nodes.length
      ? h('div', { className: 'sg-emptybox' },
          '这个家族里还没有可显示的轮次。',
          h('br'), h('br'),
          '发出第一条消息之后，图谱里就会出现第一个块。')
      : null;

  /* 内容由宿主侧读取；读取失败时当前会话仍有骨架，只是没有问答文本 */
  const contentHint = (!routeOk && !graph.error && laid.nodes.length)
    ? h('div', { className: 'sg-hint sg-hint-warn' },
        '暂时读不到会话内容，只显示了轮次骨架。切到「对话」再切回来可重试。')
    : null;

  /* 改动没存上：说清楚原因，但**不回滚**用户刚做的操作 */
  const saveHint = saveError
    ? h('div', { className: 'sg-hint sg-hint-warn' }, saveError + '（改动仍在本页生效）')
    : null;

  const detail = selected ? buildDetail() : h('div', { className: 'sg-emptybox' },
    '家族 ' + (graph.error ? 0 : graph.stats.sessions) + ' 个会话 · ' +
    (graph.error ? 0 : graph.stats.blocks) + ' 个块',
    h('br'), h('br'),
    '点一个块看它的提问与回答；双击块从那里分叉。');

  function buildDetail() {
    const n = nodeMap.get(selected);
    if (!n || n.kind !== 'block') return null;
    const b = n.block;
    const open = b.status === 'open';
    const total = graph.error ? 0 : graph.blocks.filter((x) => x.sessionId === b.sessionId).length;
    return [
      /* 固定区：头部 */
      h('div', { key: 'hd', className: 'sg-side-hd' },
        h('span', { className: 'sg-t' }, '第 ' + b.turn + ' 轮'),
        h('span', { className: 'sg-s' }, b.sessionTitle),
        h('button', { className: 'sg-x', onClick: () => setSelected(null) }, '✕')),
      /* 固定区：元信息 —— 无论正文多长都看得见 */
      h('div', { key: 'meta', className: 'sg-side-meta' },
        h('div', { className: 'sg-lb' }, '元信息'),
        h('div', { className: 'sg-meta' },
          h('span', { className: 'sg-k' }, '会话'), h('span', { className: 'sg-v' }, b.sessionTitle),
          h('span', { className: 'sg-k' }, '轮次'), h('span', { className: 'sg-v' },
            b.turn + (total ? ' / 共 ' + total + ' 轮' : '')),
          h('span', { className: 'sg-k' }, '状态'), h('span', { className: 'sg-v' },
            open ? '进行中' : b.status === 'failed' ? '失败' : '已完成'),
          h('span', { className: 'sg-k' }, '工具调用'), h('span', { className: 'sg-v' }, String(b.toolCalls)),
          h('span', { className: 'sg-k' }, '交付物'), h('span', { className: 'sg-v' },
            b.deliverables ? String(b.deliverables) : '—'))),
      /* 固定区：操作 —— 越长的正文越不该把按钮顶出去 */
      h('div', { key: 'acts', className: 'sg-side-acts' },
        h('button', {
          className: 'sg-act sg-primary', disabled: open,
          title: open ? '该轮尚未结束' : '也可以直接双击块',
          onClick: () => doFork(b.sessionId, b.turn)
        }, '⑂ 从这里分叉'),
        h('button', {
          className: 'sg-act',
          onClick: () => {
            const next = { ...hidden, [b.id]: !hidden[b.id] };
            setHidden(next);
            setShowHidden(true);
            persist({ hidden: next });
          }
        }, hidden[b.id] ? '⊘ 取消隐藏' : '⊘ 隐藏此块'),
        h('button', {
          className: 'sg-act',
          onClick: () => openSession(b.sessionId)
        }, '◻ 切换到该会话')),
      /* 唯一滚动的区域：正文 */
      h('div', { key: 'bd', className: 'sg-side-bd' },
        h('div', { className: 'sg-sec' },
          h('div', { className: 'sg-lb' }, '提问'),
          b.prompt ? markdownBlock(b.prompt, 'q') : h('div', { className: 'sg-tx' }, '（未载入）')),
        h('div', { className: 'sg-sec' },
          h('div', { className: 'sg-lb' }, '回答'),
          b.response ? markdownBlock(b.response, 'a') : h('div', { className: 'sg-tx' }, '（未载入）')))
    ];
  }

  return h('div', { className: 'sg-root' },
    h('style', null, CSS),
    h('div', {
      className: 'sg-canvas-wrap' + (panning ? ' sg-panning' : ''),
      ref: hostRef, tabIndex: 0, onKeyDown, onWheel, onMouseDown: onDown
    },
      h('div', {
        className: 'sg-world',
        style: { transform: 'translate(' + view.panX + 'px,' + view.panY + 'px) scale(' + view.scale + ')' }
      },
      h('svg', { width: Math.max(1200, (laid.bounds ? laid.bounds.maxX + 160 : 1200)),
                 height: Math.max(760, (laid.bounds ? laid.bounds.maxY + 120 : 760)) },
      h('defs', null,
        h('marker', {
          id: 'sg-arrow-solid', viewBox: '0 0 10 10', refX: 9, refY: 5,
          markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse'
        }, h('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--dsw-alias-label-dimmed)' })),
        h('marker', {
          id: 'sg-arrow-hollow', viewBox: '0 0 10 10', refX: 9, refY: 5,
          markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse'
        }, h('path', {
          d: 'M0,0 L10,5 L0,10 z',
          fill: 'var(--dsw-alias-bg-layer-1)',
          stroke: 'var(--dsw-alias-label-caption)',
          strokeWidth: 1.6
        }))),
      edges),
      cell,
      edgeLabels),
      h('div', { className: 'sg-tools' },
        h('button', { className: 'sg-btn', onClick: fit }, '适应视图 F'),
        h('button', {
          className: 'sg-btn' + (showHidden ? ' sg-on' : ''),
          onClick: () => setShowHidden(!showHidden)
        }, '显示已隐藏'),
        h('button', {
          className: 'sg-btn' + (collapseOthers ? ' sg-on' : ''),
          onClick: () => setCollapseOthers(!collapseOthers)
        }, '折叠其他会话'),
        h('button', { className: 'sg-btn', onClick: () => setExportOpen(true) }, '↧ 导出'),
        (!writable || incompatible)
          ? h('span', {
            className: 'sg-ro',
            title: incompatible
              ? '存档由更新的版本写入，本版本不会覆盖它'
              : '存储不可用，改动不会被保存'
          }, incompatible ? '存档版本不兼容 · 只读' : '只读')
          : null,
        h('span', { className: 'sg-zoom' }, Math.round(view.scale * 100) + '%')),
      h('div', { className: 'sg-hint' },
        '滚轮缩放 · 拖空白平移 · 单击块看详情 · 双击块分叉 · 方向键移动 · F 适应视图'),
      contentHint,
      saveHint,
      body),
    h('aside', { className: 'sg-side' }, detail),
    /* 模态与浮层挂在**视图根节点**上，而不是画布容器里 ——
       否则遮罩只盖住画布，右侧详情面板还露在外面，看着像没做完。 */
    exportOpen ? exportDialog() : null,
    toast ? h('div', {
      style: {
        position: 'absolute', left: '50%', bottom: '14px', transform: 'translateX(-50%)',
        background: 'var(--dsw-alias-toast-bg)', color: 'var(--dsw-alias-toast-label)',
        padding: '9px 14px', borderRadius: '8px', fontSize: '12.5px', zIndex: 40
      }
    }, toast) : null);

  function exportDialog() {
    let preview = '';
    let filename = '';
    let errorText = '';
    try {
      const out = exportText(exportFmt, exportHidden);
      preview = out.content;
      filename = out.filename;
    } catch (e) {
      errorText = e && e.message ? e.message : String(e);
    }
    const skipped = (graph.error ? 0 : graph.stats.hiddenSkipped);
    return h('div', { className: 'sg-mask', onClick: (e) => { if (e.target === e.currentTarget) setExportOpen(false); } },
      h('div', { className: 'sg-dlg' },
        h('div', { className: 'sg-dlg-hd' },
          h('span', { className: 'sg-t' }, '导出会话图谱'),
          h('span', { className: 'sg-s' }, filename),
          h('button', { className: 'sg-x', onClick: () => setExportOpen(false) }, '✕')),
        h('div', { className: 'sg-dlg-bd' },
          h('div', { className: 'sg-row' },
            h('span', { className: 'sg-lb' }, '格式'),
            h('div', { className: 'sg-seg' },
              h('button', { 'aria-pressed': exportFmt === 'mm' ? 'true' : 'false', onClick: () => setExportFmt('mm') },
                'FreeMind .mm'),
              h('button', { 'aria-pressed': exportFmt === 'md' ? 'true' : 'false', onClick: () => setExportFmt('md') },
                'Markdown .md')),
            h('span', { className: 'sg-s' },
              exportFmt === 'mm' ? '可导入 XMind / MindManager / Freeplane' : '可导入 XMind / Obsidian')) ,
          h('div', { className: 'sg-row' },
            h('span', { className: 'sg-lb' }, '范围'),
            h('label', { className: 'sg-chk' },
              h('input', {
                type: 'checkbox', checked: exportHidden,
                onChange: (e) => setExportHidden(!!e.target.checked)
              }), '包含已隐藏的块'),
            skipped && !exportHidden
              ? h('span', { className: 'sg-s' }, '有 ' + skipped + ' 个块因被隐藏而未导出')
              : null),
          h('div', { className: 'sg-row' },
            h('span', { className: 'sg-lb' }, '预览'),
            h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { className: 'sg-prev' }, preview))),
          errorText ? h('div', { className: 'sg-err' }, '生成失败：' + errorText) : null),
        h('div', { className: 'sg-dlg-ft' },
          h('span', { className: 'sg-hi' },
            '块内用「问」「答」两段区分用户提问与助手回答；分叉会话挂在它的分叉源块之下。'),
          h('button', {
            className: 'sg-bigbtn',
            onClick: () => {
              try {
                const out = exportText(exportFmt, exportHidden);
                if (navigator && navigator.clipboard) navigator.clipboard.writeText(out.content);
                say('已复制到剪贴板');
              } catch { say('复制失败，可手动选中预览区'); }
            }
          }, '复制'),
          h('button', { className: 'sg-bigbtn sg-primary', onClick: doDownload }, '下载文件'))));
  }
}

/* ------------------------------------------------------------ 插件入口 */

function apply(ctx) {
  /* 视图数据层：只做纯折叠，不订阅会话事件、不轮询、不写 DOM */
  ctx.uiConversation.views.register({
    target: TARGET,
    create: () => {
      const builder = {
        snapshot: { timeline: null },
        replace(state) { return builder.accept(state); },
        apply(state) { return builder.accept(state); },
        accept(state) {
          const timeline = state && state.timeline ? state.timeline : null;
          if (builder.snapshot.timeline === timeline) return builder.snapshot;
          builder.snapshot = { timeline };
          return builder.snapshot;
        }
      };
      return builder;
    }
  });

  /* 视图槽位。产物注册在 effect 作用域内，卸载即移除。 */
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: TARGET,
    order: VIEW_ORDER,
    label: () => '图谱',
    inject: (sessionId) => {
      let target = null;
      try {
        target = ctx.uiConversation.binding(sessionId).target(TARGET);
      } catch {
        /* 会话暂时不可绑定：视图退化为空态，不抛到槽位渲染里 */
      }
      return { sessionId, ctx, target, sessions: ctx.sessions };
    }
  }, GraphView));
}

return { inject: ['slots', 'sessions', 'uiSession', 'uiConversation'], apply };
  }
});
