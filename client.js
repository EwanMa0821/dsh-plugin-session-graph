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

/**
 * 从块 id / 空节点 id / 会话头 id 里取出所属会话 id。
 *
 * 直接 `split(':')[0]` 在 `header:<sid>` 上会得到字面量 `"header"`。
 * 引用边常常指向**整个会话**（引用式新建出来的会话还没有轮次），
 * 所以要认得出这种形态，否则导出时那条引用会被静默丢掉。
 */
function sessionOfId(id) {
  const s = str(id);
  if (s.indexOf('header:') === 0) return s.slice(7);
  const i = s.indexOf(':');
  return i < 0 ? s : s.slice(0, i);
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
 * 找出所有「彼此为父」的环成员。
 *
 * 从每个会话沿父链上溯，撞回走过的节点就说明这里有环，把环上那一段收下。
 * 环里的父子关系是自相矛盾的（谁都到不了顶），既不能当普通后代丢在一边，
 * 也不能随便挑一个当根 —— 挑中的那个会变成"上位"，另一个降成子会话，
 * 而它们本来就是互指的。挂在环下面的后代不算环成员：那些能正常从环展开。
 */
function ringMembersOf(sessions, byId) {
  const members = new Set();
  sessions.forEach((s) => {
    const path = [];
    const at = new Map();
    let cur = s.id;
    while (cur && byId.has(cur)) {
      if (at.has(cur)) {
        for (let i = at.get(cur); i < path.length; i += 1) members.add(path[i]);
        break;
      }
      if (members.has(cur)) break;      /* 再往上还是同一个环，不必重走 */
      at.set(cur, path.length);
      path.push(cur);
      const parent = byId.get(cur).parentId;
      cur = parent && byId.has(parent) ? parent : null;
    }
  });
  return members;
}

/**
 * 家族范围（FR-3）。
 *
 * 从 currentId 沿 parentId 上溯到无法继续的祖先，再向下展开全部后代。
 * 孤儿（父不在列表）降级为根；血缘成环时把环成员作为根渲染——**绝不丢节点、绝不无限递归**。
 *
 * 这里返回的 order 就是 buildGraph 的唯一范围，所以「提示里说已作为根显示、
 * 实际上却没进 order」等于把这些会话从图、统计、导出里一起抹掉：
 * 提示必须与范围一致，说显示就真的进 order。
 *
 * @returns {{ rootId: string|null, order: string[], notes: string[], roots: string[] }}
 */
function familyOf(sessions, currentId) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  if (!byId.has(currentId)) {
    return { rootId: null, order: [], notes: ['当前会话不在会话列表中'], roots: [] };
  }

  /* 上溯：只沿真实存在于列表里的父链走，撞回走过的节点就是成环，停 */
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

  /* 根候选 = 正统血缘根 + 孤儿 + 环成员。顺序固定（血缘根在最前），
     家族范围才不会随遍历顺序抖动。 */
  const rootIds = [];
  const addRoot = (id) => { if (id && !rootIds.includes(id)) rootIds.push(id); };
  addRoot(rootId);
  /* 孤儿：父会话不在列表里，血缘断了，但它自己就是这一支的根。
     早先只给提示、不纳入 order —— 提示说"已作为根显示"，其实什么都没显示。 */
  sessions.forEach((s) => { if (s.parentId && !byId.has(s.parentId)) addRoot(s.id); });
  /* 成环：环成员谁也到不了顶，全部当根。
     早先的 `chain.length > byId.size` 判定永远不会触发（chain 里去重过），
     于是这类会话从图、统计、导出里一起消失且毫无提示。 */
  const ringers = ringMembersOf(sessions, byId);
  ringers.forEach(addRoot);

  /* 下拓：从每个根深度优先展开后代，visited 兜住环，绝不重复展开 */
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
  rootIds.forEach(walk);

  const notes = [];
  sessions.forEach((s) => {
    if (s.parentId && !byId.has(s.parentId)) notes.push(`会话「${s.title}」的父会话已不可见，已作为根显示`);
  });
  if (ringers.size) {
    const names = sessions.filter((s) => ringers.has(s.id)).map((s) => `「${s.title}」`);
    notes.push(`血缘存在环（${names.join('、')}），环上会话已作为根显示`);
  }

  return { rootId, order, notes, roots: rootIds };
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

  /* 引用式会话不在血缘家族里，但被引用连线拉进范围（FR-7）。
     终点可能是某个块（`sid:turn`），也可能是整个会话（`header:sid`）——
     引用式新建出来的会话还没有轮次，只能指向会话本身。 */
  links.forEach((l) => {
    if (!l || l.kind !== 'reference') return;
    const target = sessionOfId(l.to);
    if (byId.has(target)) scopedIds.add(target);
  });

  const scoped = sessions.filter((s) => scopedIds.has(s.id));

  /* order 必须带上被引用拉进来的会话。
     layout() 是按 order 建节点的：只把它们放进 sessions 而漏掉 order，
     结果就是"有数据、没有节点"—— 引用边连端点都找不到，永远画不出来（FR-7）。
     这些 id 单独暴露出来，是因为它们在导出里要**挂在源块之下**，
     不能再当独立根列一次，否则同一个会话出现两遍。 */
  const referencedIds = [...scopedIds].filter((id) => fam.order.indexOf(id) < 0);
  const order = [...fam.order, ...referencedIds];

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
  /* 已知节点：块，加上每个会话的**会话头**与**空节点**。
     引用式新建出来的会话没有轮次，引用边只能指向它的会话头；
     只认块 id 的话这类边会被误判成断裂。 */
  const knownNode = new Set(blocks.map((b) => b.id));
  scoped.forEach((s) => {
    knownNode.add(`header:${s.id}`);
    knownNode.add(emptyId(s.id));
  });
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

  /* FR-13：部分块数据不可读时该块降级、其余照常，图角报出条数。
     判定：提问与回答都读不出**且**这一轮已经结束 —— 还在进行中的轮次
     本来就只可能有提问，不能算"数据不完整"。 */
  const incomplete = blocks.filter((b) =>
    b.status !== 'open' && !str(b.prompt) && !str(b.response)).length;

  const stats = {
    sessions: scoped.length,
    blocks: blocks.length,
    hiddenSkipped,
    edges: edges.length,
    incomplete
  };

  return {
    version: GRAPH_VERSION,
    currentId,
    rootId: fam.rootId,
    order,
    referenced: referencedIds,
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
 *
 * FR-5：**已拖拽过的块坐标即权威**，自动布局只负责没有坐标的那些。
 * 这样拖走某一块不会牵动同会话的其它块，新轮次也会落在本会话最下方。
 * 传入的坐标里若有未知块 id，忽略即可（上层已经按现有块查找）。
 *
 * @param {object} graph buildGraph 的结果
 * @param {object} [opts] 覆盖 DEFAULT_LAYOUT，另可含 `positions`
 */
function layout(graph, opts) {
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
      const p = saved[b.id];
      const pinned = p && Number.isFinite(p.x) && Number.isFinite(p.y);
      nodes.push({
        id: b.id, kind: 'block', sessionId: sid,
        x: pinned ? p.x : x,
        y: pinned ? p.y : firstBlockY + i * o.pitch,
        w: o.blockWidth, h: o.blockHeight,
        /* moved 让界面能区分"用户摆过"与"自动落的位" */
        moved: !!pinned,
        block: b
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
 *
 * **只在块之间走**：需求写的就是「在相邻块之间移动选中」，会话头不是块 ——
 * 选中它右栏没有任何块级信息可给，只会让详情面板空掉。
 * @returns {string|null} 下一个节点 id；无处可去时返回 null
 */
function moveSelection(nodes, selectedId, key) {
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

/**
 * XML 1.0 的 Char 不允许的字符：C0 控制字符（\t \n \r 例外）与 U+FFFE/U+FFFF。
 *
 * 真实会话正文里带着 ANSI 转义（ESC = U+001B）与 NUL，只转义 & < > " ' 是拦不住它们的 ——
 * 结果是**整个 .mm 文件都不是合法 XML**（不是少一行，是解析器直接罢工）。
 * 所以这里直接丢掉，而不是换成实体：这些字符在思维导图里也没有任何可显示的含义。
 */
const XML_ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

const escXml = (v) => String(v === undefined || v === null ? '' : v)
  .replace(XML_ILLEGAL, '')
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

/**
 * 表格分隔行（`|---|---|`）在思维导图里只是噪声，丢掉。
 *
 * 必须**同时**含 `|` 才算分隔行：早先只按"字符全在 [\s:|-] 里且至少一个 -"判断，
 * 于是 `---`、`--` 这类 Markdown 水平线也被当成表格规则吃掉 —— 那是一行真内容。
 */
const isTableRule = (line) =>
  line.includes('|') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line);

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

/**
 * 去掉孤立代理码元。
 *
 * 截断救不了输入本身就畸形的标题（正文被截过、上游拼接出错等），
 * 而孤立代理会让 encodeURIComponent 抛 URIError —— 下载链接根本拼不出来。
 */
const stripLoneSurrogates = (s) => s
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
  .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1');

/**
 * 文件名安全化：路径非法字符替换、长度截断、空标题回落。
 *
 * 截断必须按**码点**，不能按 UTF-16 码元：`'x'.repeat(59) + '😀'` 这类标题
 * 切在 60 个码元上会留下半个代理对（0xD83D），随后 encodeURIComponent 抛 URIError。
 */
function safeFilename(title, fallback = 'session-graph') {
  const base = plain(title).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  return stripLoneSurrogates([...(base || fallback)].slice(0, 60).join(''));
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
      /* 终点可能是某个块（`sid:turn`），也可能是整个会话（`header:sid`）——
         引用式新建出来的会话还没有轮次，只能指向会话本身。 */
      .map((l) => sessionOfId(l.to))
      .filter((sid) => bySession.has(sid));

  /* 家族根：没有父、或父不在家族内的会话。
     被引用拉进来的会话不算根 —— 它们挂在源块之下（refsAt），
     否则同一个会话会在导出结果里出现两遍。 */
  const pulled = new Set(graph.referenced || []);
  const baseRoots = graph.order
    .map((id) => bySession.get(id))
    .filter((s) => s && !pulled.has(s.id) && (!s.parentId || !bySession.has(s.parentId)));

  const childrenOf = new Map();
  graph.sessions.forEach((s) => {
    if (!s.parentId) return;
    if (!childrenOf.has(s.parentId)) childrenOf.set(s.parentId, []);
    childrenOf.get(s.parentId).push(s.id);
  });

  /* 哪些会话真的会被画出来？从根往下走一遍：子会话全部会挂上，而**只有可见块的
     引用连线才拉得动会话** —— 源块被隐藏时 buildGraph 根本不生成那条引用边（FR-11）。
     早先没有这一步，只把"源块 id 命中"当唯一出口：源块一被隐藏，被引用的会话
     既不是根、也没有挂载点，于是一整个会话从 .mm/.md 里消失，连一句提示都没有。 */
  const live = new Set();
  const mark = (seed) => {
    const stack = seed.map((s) => s.id);
    while (stack.length) {
      const sid = stack.pop();
      if (!sid || live.has(sid) || !bySession.has(sid)) continue;
      live.add(sid);
      (childrenOf.get(sid) || []).forEach((id) => stack.push(id));
      blocksOf(sid).forEach((b) => refsAt(b.id).forEach((id) => stack.push(id)));
    }
  };
  mark(baseRoots);

  /* order 里的会话必须**恰好出现一次**：没被任何节点接住的（引用源块被隐藏、
     血缘成环谁也不是根）补成根，绝不静默丢节点。 */
  const extraRoots = graph.order
    .map((id) => bySession.get(id))
    .filter((s) => s && !live.has(s.id));
  mark(extraRoots);
  const roots = [...baseRoots, ...extraRoots];

  /* 同一个会话只能出现在一处：补出来的根与树内挂载可能指向同一个会话
     （成环、同一条引用被多块引用），渲染期用这个集合兜住"恰好一次"。 */
  const rendered = new Set();
  const enter = (sid) => {
    if (rendered.has(sid)) return false;
    rendered.add(sid);
    return true;
  };

  const skipped = [];
  const keptLinks = [];
  /* 只有真的会被输出的块才算"可见"。按 graph.blocks 判断会造出指向不存在节点的
     `<arrowlink DESTINATION>` —— 悬空目标在思维导图里是硬错误，不是少画一条线。 */
  const visible = new Set(graph.blocks.filter((b) => live.has(b.sessionId)).map((b) => b.id));
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

  return {
    roots, blocksOf, childrenAt, leftoverChildren, refsAt, keptLinks, linkFrom, skipped, enter,
    /* 被引用拉进来、却因源块不可见而只能当根的会话：导出里要给出诚实提示 */
    promotedRoots: extraRoots.filter((s) => pulled.has(s.id))
  };
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
    /* 同一个会话只画一次：补出来的根与树内挂载可能指向同一个会话（成环、重复引用） */
    if (!tree.enter(s.id)) return;
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
  /* 引用源块被隐藏时，被引用的会话只能当根 —— 这件事必须说出来，不能悄悄改变结构 */
  if (tree.promotedRoots.length) {
    note.push(`有 ${tree.promotedRoots.length} 个被引用的会话因源块不可见，已作为根导出。`);
  }
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
  /* 引用源块被隐藏时，被引用的会话只能当根 —— 这件事必须说出来，不能悄悄改变结构 */
  if (tree.promotedRoots.length) {
    out.push(`> 有 ${tree.promotedRoots.length} 个被引用的会话因源块不可见，已作为根导出。`, '');
  }

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
    /* 同一个会话只列一次：补出来的根与树内挂载可能指向同一个会话（成环、重复引用） */
    if (!tree.enter(s.id)) return;
    const mark = mode === 'ref' ? '🔗 引用' : '⑂ 分叉';
    const label = mode === 'ref' ? s.title.replace(/^引用[:：]\s*/, '') : s.title;
    out.push(`${ind(depth)}- **${mark} → ${label}**`);
    const mine = tree.blocksOf(s.id);
    if (!mine.length) out.push(`${ind(depth + 1)}- *空子会话 · 尚未提问*`);
    else mine.forEach((b) => blockItem(b, depth + 1));
    tree.leftoverChildren(s.id).forEach((c) => sessionItem(c, depth + 1, 'fork'));
  }

  tree.roots.forEach((s) => {
    /* 补根与树内挂载可能撞到同一个会话：先到先画，后到的跳过 */
    if (!tree.enter(s.id)) return;
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
 * 版本迁移。
 *
 * 为什么要这份脚手架：`sanitizeState` 遇到不认识的版本会返回 null，调用方据此
 * **拒绝应用**（宁可只读也不要猜）。这个方向对旧版本成立，但**升版本时就翻车**：
 * 所有老用户的存档会在同一刻变成"不认识"，界面集体转入只读，而且没有迁移路径 ——
 * 必须让用户删掉存档才能恢复。这不可接受。
 *
 * 所以规则改成三条：
 *   1. 版本相同 → 直接规整；
 *   2. 版本更旧 → 逐级跑迁移函数，再按当前版本规整（**写回时自然升级**，
 *      所以一条记录只要被碰过一次就自愈了）；
 *   3. 版本更新 → 仍返回 null（那是更新的插件写的，我们不该按旧形状改写它）。
 *
 * 升版本时的操作：把 `STATE_VERSION` 加一，并在下面的表里补一条
 * `旧版本 -> 迁移函数`。表里缺环时迁移会停住并按"不认识"处理，不会半途产出
 * 形状可疑的状态。
 *
 * @type {Record<number, (state: object) => object>}
 */
const STATE_MIGRATIONS = {
  /* 示例（首次真正升版本时删掉注释并补上）：
     1: (state) => ({ ...state, version: 2, 新增字段: [] }) */
};

/**
 * 把旧版本记录逐级迁移到当前版本。
 * @param {object} raw 外来记录
 * @returns {object|null} 迁移后的记录；链条不完整时返回 null
 */
function migrateState(raw) {
  let state = raw;
  let version = Number(state && state.version);
  if (!Number.isFinite(version)) return null;      /* 版本字段缺失/不是数字：不认识 */
  let guard = 0;
  while (version < STATE_VERSION) {
    const step = STATE_MIGRATIONS[version];
    if (typeof step !== 'function') return null;      /* 缺环：宁可只读，不要猜 */
    state = step(state);
    const next = Number(state && state.version);
    if (!(next > version)) return null;               /* 迁移函数没推进版本 = 写坏了 */
    version = next;
    if ((guard += 1) > 64) return null;               /* 防死循环 */
  }
  return state;
}

/**
 * 把任意外来记录规整成合法状态。
 * @returns {object|null} 版本不认识时返回 null（调用方据此拒绝应用，而不是猜）
 */
function sanitizeState(raw, now = 0) {
  if (!sxIsObject(raw)) return null;
  const version = Number(raw.version);
  /* 更新的版本不碰（可能是新版插件写的）；版本字段缺失/不是数字一律当不认识。
     注意下面全部读 `src` 而不是 `raw` —— 迁移可能改过字段形状。 */
  if (!Number.isFinite(version) || version > STATE_VERSION) return null;
  const src = version === STATE_VERSION ? raw : migrateState(raw);
  if (!sxIsObject(src)) return null;

  const viewport = sxIsObject(src.viewport)
    ? {
      zoom: sxClamp(src.viewport.zoom, 0.25, 2, 1),
      panX: sxClamp(src.viewport.panX, -1e6, 1e6, 0),
      panY: sxClamp(src.viewport.panY, -1e6, 1e6, 0)
    }
    : null;

  return {
    version: STATE_VERSION,
    links: (Array.isArray(src.links) ? src.links : [])
      .slice(0, LIMITS.links).map((l) => sxSanitizeLink(l, now)).filter(Boolean),
    positions: sxCapObject(src.positions, LIMITS.positions, (v) => {
      if (!sxIsObject(v)) return null;
      const x = Number(v.x);
      const y = Number(v.y);
      return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : null;
    }),
    viewport,
    collapsedSessions: sxUniq(src.collapsedSessions, LIMITS.collapsedSessions),
    hiddenBlocks: sxUniq(src.hiddenBlocks, LIMITS.hiddenBlocks),
    alias: sxCapObject(src.alias, LIMITS.alias, (v) => {
      const text = sxStr(v).trim().slice(0, LIMITS.aliasLength);
      return text === '' ? null : text;
    }),
    updatedAt: Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : now
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
    /* 按 id 覆盖式合并：同一 id 视为更新，其它保留 —— 这样客户端可以只发变化的那几条。
       注意 label **以 patch 为准（缺键 = 清空）**：客户端表达"这条连线没有标签"就是
       把 label 键删掉（见 src/client/app.js 的 labelLink: `const { label: _drop, ...rest } = l`），
       而 `{ ...prev, ...l }` 会把"缺键"读成"保留旧值"，于是清空标签永远落不了盘 ——
       界面上删掉、刷新又回来。createdAt 仍保留首次写入的时间。 */
    const byId = new Map(base.links.map((l) => [l.id, l]));
    incoming.forEach((l) => {
      const prev = byId.get(l.id);
      if (!prev) { byId.set(l.id, l); return; }
      const merged = { ...prev, ...l, createdAt: prev.createdAt, updatedAt: now };
      if (!('label' in l)) delete merged.label;
      byId.set(l.id, merged);
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

/* ---- src/core/scale.js ---- */
/**
 * 会话图谱 · 规模降级（NFR-1）
 *
 * 目标规模是 ≤ 200 会话 / ≤ 5000 块，但界面得在超规模时**仍然可用**，
 * 所以按块数分档，越大的档省得越多。
 *
 * 与需求文档的一处**有意偏差**：文档写「> 800 由矢量元素切换为位图绘制」，
 * 这里没有实现位图绘制，改为丢弃块内正文与边标签。
 * 理由是位图绘制要重写整个渲染层，代价与收益不成比例，而且会一起丢掉
 * 文本选中与可访问性；而耗时的真正大头正是每块的富文本与每条边的标签。
 * 骨架档（> 3000）的行为与文档一致：只画分叉骨架 + 当前会话块，其余按需展开。
 *
 * 纯函数，无副作用。
 */

/** 分档阈值 */
const TIERS = {
  dense: 800,
  skeleton: 3000
};

/** 布局超过这个毫秒数就回落简化布局并提示（NFR-1） */
const SLOW_LAYOUT_MS = 300;

/**
 * 按块数选档。
 * @param {number} blockCount
 * @returns {'full'|'dense'|'skeleton'}
 */
function tierOf(blockCount) {
  const n = Number(blockCount);
  if (!Number.isFinite(n) || n <= TIERS.dense) return 'full';
  if (n <= TIERS.skeleton) return 'dense';
  return 'skeleton';
}

/**
 * 该档位下还能保留哪些渲染内容。
 *
 * - full     全部
 * - dense    丢掉块内正文与边标签（耗时大头），保留块、边与连线把手
 * - skeleton 再丢掉非当前会话的块，只留会话头与派生边
 */
function tierFeatures(tier) {
  switch (tier) {
    case 'dense':
      return { blockText: false, edgeLabels: false, skeletonOnly: false };
    case 'skeleton':
      return { blockText: false, edgeLabels: false, skeletonOnly: true };
    default:
      return { blockText: true, edgeLabels: true, skeletonOnly: false };
  }
}

/**
 * 该档位下**要画块**的会话集合。
 *
 * 骨架档只留当前会话（外加用户显式展开的）：其余会话只出**会话头**，
 * 派生边仍在，所以分叉骨架照样看得见。
 * 祖先会话不默认展开 —— 那正是最可能巨大的那一个，展开它就等于没降级。
 *
 * @param {Array<{id: string}>} sessions
 * @param {'full'|'dense'|'skeleton'} tier
 * @param {string} currentId
 * @param {Iterable<string>} [expanded] 用户显式展开的会话
 * @returns {Set<string>|null} null 表示不限（全画）
 */
function sessionsWithBlocks(sessions, tier, currentId, expanded) {
  if (!tierFeatures(tier).skeletonOnly) return null;
  const byId = new Map((sessions || []).map((s) => [s.id, s]));
  const ids = new Set();
  if (currentId && byId.has(currentId)) ids.add(currentId);
  for (const id of expanded || []) if (byId.has(id)) ids.add(id);
  return ids;
}

/**
 * 量化一次布局耗时。慢于阈值时给出回落信号，由界面提示用户（NFR-1）。
 *
 * @param {() => any} run
 * @param {(ms: number) => void} [now] 注入时钟，便于测试
 * @returns {{ result: any, ms: number, slow: boolean }}
 */
function timedLayout(run, now) {
  const clock = typeof now === 'function' ? now : defaultNow;
  const t0 = clock();
  const result = run();
  const ms = Math.max(0, clock() - t0);
  return { result, ms, slow: ms > SLOW_LAYOUT_MS };
}

function defaultNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/* ---- src/core/i18n.js ---- */
/**
 * 会话图谱 · 界面文案（NFR-3）
 *
 * 全部文案集中在这里，`zh` / `en` 成对出现。
 * 取值走宿主的本地化服务（`ctx.locale.resolveText`），它按当前语言解析、
 * **缺键回退英文** —— 正是 NFR-3 的第三条要求。
 * 为了在没有宿主服务时也能工作（测试、降级），这里同样实现了同一套回退链。
 *
 * 字典集中放还有个副作用：可以写测试断言**每个键都有 zh 与 en 且非空**，
 * 这是散落在各处改文案时拿不到的保证。
 *
 * 纯函数，无副作用。
 */

/** 界面文案字典。`{name}` 是插值占位符。 */
const UI = {
  'view.title': { zh: '图谱', en: 'Graph' },

  /* ---- 工具条 ---- */
  'toolbar.fit': { zh: '适应视图 F', en: 'Fit view (F)' },
  'toolbar.showHidden': { zh: '显示已隐藏', en: 'Show hidden' },
  'toolbar.collapseOthers': { zh: '折叠其他会话', en: 'Collapse other sessions' },
  'toolbar.export': { zh: '↧ 导出', en: '↧ Export' },
  'toolbar.undo': { zh: '↶ 撤销', en: '↶ Undo' },
  'toolbar.undoTip': { zh: '撤销上一步（Ctrl+Z）', en: 'Undo the last change (Ctrl+Z)' },
  'toolbar.nothingToUndo': { zh: '没有可撤销的操作', en: 'Nothing to undo' },

  /* ---- 提示条 ---- */
  'hint.idle': {
    zh: '滚轮缩放 · 拖空白平移 · 单击块看详情 · 双击块分叉 · 拖块右下圆点连线 · F 适应视图',
    en: 'Scroll to zoom · drag empty space to pan · click a block for details · double-click to fork · drag the corner dot to link · F to fit'
  },
  'hint.linkingDrag': {
    zh: '拖到另一个块并松手建立连线 · 松在空白处取消 · Esc 取消',
    en: 'Drop on another block to link · release on empty space to cancel · Esc to cancel'
  },
  'hint.linkingClick': {
    zh: '点击另一个块完成连线 · Esc 取消',
    en: 'Click another block to finish the link · Esc to cancel'
  },
  'hint.saveFailedSuffix': { zh: '（改动仍在本页生效）', en: ' (your change still applies on this page)' },
  'hint.partialContent': {
    zh: '暂时读不到会话内容，只显示了轮次骨架。切到「对话」再切回来可重试。',
    en: 'Session content is temporarily unreadable; only the turn skeleton is shown. Switch to Chat and back to retry.'
  },

  /* ---- 只读 / 存储 ---- */
  'ro.readonly': { zh: '只读', en: 'Read-only' },
  'ro.incompatible': { zh: '存档版本不兼容 · 只读', en: 'Incompatible save format · read-only' },
  'ro.incompatibleTip': {
    zh: '存档由更新的版本写入，本版本不会覆盖它',
    en: 'The save was written by a newer version; this version will not overwrite it'
  },
  'ro.noStorage': { zh: '存储不可用，改动不会被保存', en: 'Storage unavailable; changes will not be saved' },
  'ro.writeFailedIncompatible': {
    zh: '存档由更新的版本写入，本次改动未保存',
    en: 'The save was written by a newer version; this change was not saved'
  },
  'ro.writeFailed': { zh: '改动未能保存', en: 'Could not save the change' },

  /* ---- 连线 ---- */
  'link.self': { zh: '不能把一个块连到它自己', en: 'A block cannot be linked to itself' },
  'link.handleTip': { zh: '拖到另一个块建立连线', en: 'Drag onto another block to link' },
  'link.labelPlaceholder': { zh: '标签（可留空）', en: 'Label (optional)' },
  'link.created': { zh: '已新建引用式会话', en: 'Reference session created' },
  'link.kindManual': { zh: '手动连线', en: 'Manual link' },
  'link.kindReference': { zh: '引用连线', en: 'Reference link' },
  'link.sectionTitle': { zh: '连线', en: 'Link' },
  'link.from': { zh: '起点', en: 'From' },
  'link.to': { zh: '终点', en: 'To' },
  'link.status': { zh: '状态', en: 'Status' },
  'link.endpointGone': { zh: '端点已不存在', en: 'Endpoint no longer exists' },
  'link.delete': { zh: '✕ 删除这条连线', en: '✕ Delete this link' },
  'link.label': { zh: '标签', en: 'Label' },
  'link.noLabel': { zh: '（无标签）', en: '(no label)' },
  'link.labelHelp': {
    zh: '留空即无标签。同一对块之间可以有多条连线。',
    en: 'Leave empty for no label. Multiple links between the same pair of blocks are allowed.'
  },
  'link.gone': { zh: '这条连线已经不在了。', en: 'This link no longer exists.' },
  'link.missing': { zh: '（已不存在）', en: ' (no longer exists)' },

  /* ---- 分叉 ---- */
  'fork.openTurn': { zh: '该轮尚未结束，不能从这里分叉', en: 'This turn has not finished; cannot fork from here' },
  'fork.noBoundary': {
    zh: '这一轮没有可用的分叉边界，可能尚未载入',
    en: 'No usable fork boundary for this turn; it may not be loaded yet'
  },
  'fork.noneAvailable': { zh: '没有可用的已完成轮次', en: 'No completed turn available' },
  'fork.sourceUnavailable': { zh: '源会话不可用，请刷新图谱', en: 'The source session is unavailable; refresh the graph' },
  'fork.failed': { zh: '分叉失败：{msg}', en: 'Fork failed: {msg}' },
  'fork.done': { zh: '已从第 {turn} 轮分叉', en: 'Forked from turn {turn}' },
  'fork.action': { zh: '⑂ 从这里分叉', en: '⑂ Fork from here' },
  'fork.hint': { zh: '也可以直接双击块', en: 'You can also double-click the block' },
  'fork.turnOpen': { zh: '该轮尚未结束', en: 'This turn is still running' },

  /* ---- 块与详情 ---- */
  'block.turn': { zh: '第 {turn} 轮', en: 'Turn {turn}' },
  'block.turnOf': { zh: '第 {turn} 轮 · {title}', en: 'Turn {turn} · {title}' },
  'block.ariaLabel': { zh: '第 {turn} 轮：{prompt}', en: 'Turn {turn}: {prompt}' },
  'block.noPrompt': { zh: '（该轮提问尚未载入）', en: '(prompt not loaded)' },
  'block.noResponse': { zh: '（该轮回答尚未载入）', en: '(response not loaded)' },
  'block.thin': { zh: '（这一轮的内容读不出来）', en: '(this turn’s content is unreadable)' },
  /* 还在取数时**不许说"读不出来"**：那是在指控数据丢失，而数据只是还在路上。
     用中性的载入文案，取数回来自然消失。 */
  'block.loading': { zh: '载入中…', en: 'Loading…' },
  /* 详情面板的展开/折叠（与原生 harness 侧栏一致的交互） */
  'side.collapse': { zh: '收起详情', en: 'Collapse details' },
  'side.expand': { zh: '详情', en: 'Details' },
  'block.thinResponse': {
    zh: '元数据仍在，可正常连线与分叉',
    en: 'Metadata is intact; linking and forking still work'
  },
  'block.loadFull': { zh: '点击载入这一轮的完整内容', en: 'Click to load this turn in full' },
  'block.prompt': { zh: '提问', en: 'Prompt' },
  'block.response': { zh: '回答', en: 'Response' },
  'block.notLoaded': { zh: '（未载入）', en: '(not loaded)' },
  'block.emptyChild': { zh: '空子会话 · 尚未提问', en: 'Empty child session · no prompt yet' },

  'side.meta': { zh: '元信息', en: 'Details' },
  'side.session': { zh: '会话', en: 'Session' },
  'side.turn': { zh: '轮次', en: 'Turn' },
  'side.turnOfTotal': { zh: '{turn} / 共 {total} 轮', en: '{turn} of {total}' },
  'side.status': { zh: '状态', en: 'Status' },
  'side.statusOpen': { zh: '进行中', en: 'Running' },
  'side.statusFailed': { zh: '失败', en: 'Failed' },
  'side.statusDone': { zh: '已完成', en: 'Completed' },
  'side.toolCalls': { zh: '工具调用', en: 'Tool calls' },
  'side.deliverables': { zh: '交付物', en: 'Deliverables' },
  'side.switch': { zh: '◻ 切换到该会话', en: '◻ Switch to this session' },
  'side.empty': {
    zh: '家族 {sessions} 个会话 · {blocks} 个块',
    en: '{sessions} sessions · {blocks} blocks in this family'
  },
  'side.emptyHint': {
    zh: '点一个块看它的提问与回答；双击块从那里分叉。',
    en: 'Click a block to see its prompt and response; double-click to fork from it.'
  },

  /* ---- 操作 ---- */
  'act.rename': { zh: '✎ 重命名', en: '✎ Rename' },
  'act.hide': { zh: '⊘ 隐藏此块', en: '⊘ Hide this block' },
  'act.unhide': { zh: '⊘ 取消隐藏', en: '⊘ Unhide' },
  'act.connect': { zh: '→ 连接到…', en: '→ Connect to…' },
  'act.locate': { zh: '⌖ 在对话视图中定位该轮', en: '⌖ Locate this turn in Chat' },
  'act.newRef': { zh: '⧉ 新建引用式会话', en: '⧉ New reference session' },
  'act.renameTitle': { zh: '重命名', en: 'Rename' },
  'act.renamePlaceholder': { zh: '新名称（留空恢复自动标题）', en: 'New name (leave empty to restore the automatic title)' },
  'act.renameHelp': {
    zh: '别名优先于自动标题，图谱上带 ✎ 前缀。',
    en: 'The alias takes precedence over the automatic title and is marked with ✎ in the graph.'
  },

  /* ---- 会话头 ---- */
  'head.switchTip': { zh: '点击切换到这个会话', en: 'Click to switch to this session' },
  'head.archivedTip': { zh: '该会话已归档，无法切换', en: 'This session is archived and cannot be opened' },
  'head.archived': { zh: '该会话已归档，无法切换', en: 'This session is archived and cannot be opened' },
  'head.expand': { zh: '就地展开这个会话的块', en: 'Expand this session’s blocks in place' },
  'head.collapse': { zh: '收起这个会话的块', en: 'Collapse this session’s blocks' },
  'head.turnCount': { zh: '{n} 轮', en: '{n} turns' },

  /* ---- 图角状态 ---- */
  'corner.skeleton': {
    zh: '{n} 个块尚未载入 · 点击块即可载入',
    en: '{n} blocks not loaded yet · click a block to load it'
  },
  'corner.incomplete': { zh: '{n} 个块数据不完整', en: '{n} blocks have incomplete data' },
  'corner.broken': { zh: '{n} 条连线指向已不存在的块', en: '{n} links point to blocks that no longer exist' },
  /* 降级留痕：宿主形状对不上时插件会退一步继续，这里把"退过"说出来 */
  'corner.degraded': {
    zh: '降级 {n} 项 · 最近：{why}',
    en: '{n} degraded · latest: {why}'
  },

  /* ---- 状态面板 ---- */
  'state.errorTitle': { zh: '图谱没能装配起来', en: 'The graph could not be assembled' },
  'state.errorHelp': {
    zh: '图谱以外的功能不受影响。若反复失败，请把下面这行一并反馈：',
    en: 'Everything outside the graph still works. If this keeps happening, please report the line below:'
  },
  'state.retry': { zh: '↻ 重试', en: '↻ Retry' },
  'state.assembling': { zh: '正在装配图谱…', en: 'Assembling the graph…' },
  'state.emptyTitle': { zh: '这个家族里还没有可显示的轮次', en: 'No turns to show in this family yet' },
  'state.emptyHelp': {
    zh: '发出第一条消息之后，图谱里就会出现第一个块。',
    en: 'Once you send the first message, the first block appears here.'
  },
  'state.goChat': { zh: '去对话视图开始提问', en: 'Go to Chat and ask something' },

  /* ---- 规模降级 ---- */
  'scale.dense': {
    zh: '块较多：为保持流畅已省略块内正文与边标签',
    en: 'Many blocks: block text and edge labels are omitted to keep things smooth'
  },
  'scale.skeleton': {
    zh: '块非常多：只画分叉骨架与当前会话，点会话头的 ▸ 展开其它会话',
    en: 'Very many blocks: only the fork skeleton and the current session are drawn; click ▸ on a session header to expand it'
  },
  'scale.slowLayout': { zh: '布局耗时超出预算，已回落简化布局', en: 'Layout exceeded its budget; fell back to a simplified layout' },

  /* ---- 引用式新建会话 ---- */
  'ref.noCreate': { zh: '当前宿主没有暴露新建会话的能力', en: 'This host does not expose session creation' },
  'ref.noWorkspace': { zh: '找不到这个会话所属的工作区，无法新建', en: 'Could not find the workspace for this session' },
  'ref.createFailed': { zh: '新建会话失败：{msg}', en: 'Could not create the session: {msg}' },
  'ref.noId': { zh: '新建会话失败：宿主没有返回会话 id', en: 'Could not create the session: the host returned no id' },
  'ref.navFailed': { zh: '引用式会话已建立，但没能自动切过去', en: 'The reference session was created, but could not be opened automatically' },

  /* ---- 跨会话跳转 ---- */
  'nav.noSwitch': { zh: '当前宿主没有暴露切换会话的能力', en: 'This host does not expose session switching' },
  'nav.switchFailed': { zh: '切换会话失败：{msg}', en: 'Could not switch sessions: {msg}' },
  'nav.noView': { zh: '当前宿主没有暴露切换视图的能力', en: 'This host does not expose view switching' },
  'nav.located': {
    zh: '已切到对话视图；本版本无法自动滚动，请找第 {turn} 轮',
    en: 'Switched to Chat; this version cannot scroll automatically — look for turn {turn}'
  },

  /* ---- 导出 ---- */
  'export.title': { zh: '导出会话图谱', en: 'Export the session graph' },
  'export.format': { zh: '格式', en: 'Format' },
  'export.mmHint': { zh: '可导入 XMind / MindManager / Freeplane', en: 'Imports into XMind / MindManager / Freeplane' },
  'export.mdHint': { zh: '可导入 XMind / Obsidian', en: 'Imports into XMind / Obsidian' },
  'export.scope': { zh: '范围', en: 'Scope' },
  'export.includeHidden': { zh: '包含已隐藏的块', en: 'Include hidden blocks' },
  'export.preview': { zh: '预览', en: 'Preview' },
  'export.generateFailed': { zh: '生成失败：{msg}', en: 'Could not generate: {msg}' },
  'export.help': {
    zh: '块内用「问」「答」两段区分用户提问与助手回答；分叉会话挂在它的分叉源块之下。',
    en: 'Inside each block, Q and A sections separate the prompt from the response; forked sessions hang under their fork source block.'
  },
  'export.download': { zh: '下载文件', en: 'Download' },
  'export.copied': { zh: '已复制到剪贴板', en: 'Copied to the clipboard' },
  'export.copyFailed': { zh: '复制失败，可手动选中预览区', en: 'Copy failed; select the preview manually' },
  'export.copy': { zh: '复制', en: 'Copy' },
  'export.copiedShort': { zh: '已复制', en: 'Copied' },
  'export.downloading': { zh: '已开始下载 {name}（本地生成）', en: 'Downloading {name} (generated locally)' },
  'export.failed': { zh: '导出失败：{msg}', en: 'Export failed: {msg}' },
  'export.hiddenNotExported': { zh: '有 {n} 个块因被隐藏而未导出', en: '{n} blocks were hidden and not exported' },

  /* ---- Markdown 渲染器标签 ---- */
  'md.code': { zh: '代码', en: 'Code' },
  'md.wrap': { zh: '自动换行', en: 'Wrap lines' },
  'md.unwrap': { zh: '不换行', en: 'No wrap' },
  'md.footnotes': { zh: '脚注', en: 'Footnotes' }
};

/** 缺省语言：字典缺键时回退到它（NFR-3 明确要求回退英文） */
const FALLBACK_LOCALE = 'en';

/** 语言标签归一：`zh-CN` → `zh`，与宿主 localeKey 的语义一致 */
function localeKey(locale) {
  return String(locale === undefined || locale === null ? '' : locale).toLowerCase();
}

/**
 * 当前语言的回退链：`zh-Hans-CN` → `zh-hans-cn, zh-hans, zh`。
 * 与宿主 `resolveText` 的 `fallbackChain` 同构。
 */
function fallbackChain(active) {
  const key = localeKey(active);
  if (!key) return [];
  const parts = key.split('-');
  const chain = [];
  for (let i = parts.length; i > 0; i -= 1) chain.push(parts.slice(0, i).join('-'));
  return chain;
}

/**
 * 取一条文案。
 *
 * 与宿主 `LocaleService.resolveText` 同一套语义：字符串原样返回，
 * 对象按回退链逐级向下，最后落到 `en`。
 *
 * @param {{zh?: string, en?: string}|string} text
 * @param {string} active 当前语言
 * @returns {string}
 */
function pick(text, active) {
  if (typeof text === 'string') return text;
  if (!text || typeof text !== 'object') return '';
  for (const loc of fallbackChain(active)) {
    const v = text[loc];
    if (typeof v === 'string' && v !== '') return v;
  }
  const en = text[FALLBACK_LOCALE];
  return typeof en === 'string' ? en : '';
}

/** `{name}` 插值；缺变量就原样留下占位符，方便一眼看出漏了什么 */
function interpolate(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (
    vars[k] === undefined || vars[k] === null ? m : String(vars[k])
  ));
}

/**
 * 造一个取值函数。
 *
 * @param {string} active 当前语言
 * @param {(text: any) => string} [resolver] 宿主的解析器；给了就用它，
 *        这样文案确实"经宿主客户端本地化服务提供"（NFR-3 第一条）
 * @param {object} [dict] 覆盖字典，便于测试
 * @returns {(key: string, vars?: object) => string}
 */
function makeT(active, resolver, dict) {
  const table = dict || UI;
  const resolve = typeof resolver === 'function' ? resolver : (text) => pick(text, active);
  return (key, vars) => {
    const raw = table[key];
    /* 认不出的键：回退英文后再直接吐键名，绝不返回 undefined 让界面出现空洞 */
    const text = raw === undefined ? key : resolve(raw);
    return interpolate(text, vars);
  };
}

/** 数字按当前语言排版（NFR-3 第三条）。Intl 不可用时退回普通字符串。 */
function formatNumber(value, active) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.NumberFormat === 'function') {
      return new Intl.NumberFormat(active || undefined).format(n);
    }
  } catch { /* 语言标签不被支持时按普通数字输出 */ }
  return String(n);
}

/** 供测试与构建脚本使用：把字典摊平成 `{zh: {...}, en: {...}}` */
function flatten(locales) {
  const out = {};
  (locales || ['zh', 'en']).forEach((loc) => { out[loc] = {}; });
  Object.keys(UI).forEach((key) => {
    (locales || ['zh', 'en']).forEach((loc) => {
      const v = UI[key][loc];
      if (typeof v === 'string') out[loc][key] = v;
    });
  });
  return out;
}

/* ============================================================
   会话图谱 · 客户端应用
   本文件由 scripts/build-client.mjs 原样追加到生成的 client.js 中，
   运行在 __ModuleLoader__ 的 factory 作用域里，因此可以直接使用
   上面已经内联的核心函数（buildGraph / layout / render ...）。

   约束（NFR-2）：只用 --dsw-* 主题变量；除 react 与宿主的 primitives 基础件外
   不 require 别的包；不向 document.body 追加；样式以 React 元素渲染，随组件卸载移除。
   ============================================================ */

/* 视图切走会卸载组件；选中块放在模块级 Map 里，重挂载时恢复（验收 13） */
const lastSelection = new Map();
/* 折叠状态同理（验收：离开再回来保留折叠状态） */
const lastCollapsed = new Map();

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
/** MarkdownText 的标签也要走本地化（NFR-3），所以按 t 现造 */
function markdownLabels(t) {
  return {
    code: {
      copyLabel: t('export.copy'),
      copiedLabel: t('export.copiedShort'),
      toolbarLabels: { codeLabel: t('md.code'), wrapLabel: t('md.wrap'), unwrapLabel: t('md.unwrap') }
    },
    footnotes: t('md.footnotes')
  };
}

/** 宿主的本地化解析器；服务缺席时返回 null，由 makeT 退到本地字典 */
function localeResolver(ctx) {
  const svc = ctx && ctx.locale;
  return svc && typeof svc.resolveText === 'function' ? (text) => svc.resolveText(text) : null;
}

/** 当前语言。槽位 label 由宿主在模块作用域调用，拿不到组件订阅的快照，所以现读一次 */
function activeLocaleOf(ctx) {
  try {
    const svc = ctx && ctx.locale;
    const snap = svc && typeof svc.getSnapshot === 'function' ? svc.getSnapshot() : null;
    if (snap && typeof snap.active === 'string' && snap.active) return snap.active;
  } catch { /* 取不到就用默认语言 */ }
  return 'zh';
}

/**
 * 视图标签。**必须是模块作用域可用的函数**。
 *
 * 宿主取标签时直接调用这个 thunk：`viewTabs()` → `resolveSlotLabel(label)` → `label()`，
 * 而它对函数标签**没有任何兜底**（`typeof label === "function" ? label() : label`）。
 * 调用时机也跟组件无关：注册槽位时、**切换会话时**（`activateView` 里又取一次 viewTabs）、
 * 换语言时都会跑。
 *
 * 早先这里写成 `() => t('view.title')`，而 `t` 只活在 GraphView 组件作用域里 ——
 * 于是宿主一取标签就抛 `ReferenceError: t is not defined`，`activateView` 直接失败：
 * 会话切不动，输入框也跟着废掉。一个标签把整个对话界面带崩，就是这么来的。
 * 所以这里**按当前语言现取**：优先走宿主解析器，缺服务时用本地字典（语义与组件内一致）。
 */
function viewLabel(ctx) {
  return makeT(activeLocaleOf(ctx), localeResolver(ctx))('view.title');
}

/**
 * 读一个**可选**服务，读不到就返回 undefined。
 *
 * cordis 对没有声明在 `inject` 里的服务，**属性访问会直接抛**：
 * `cannot get property "workspaces" without inject`。这条例外一抛就把整个视图变白屏
 * （宿主会把抛错的组件卸掉，标签却照常显示，看起来只是"没内容"）。
 * 所以可选能力一律走 `ctx.get(name)`，并且**连 get 本身也守**——
 * 查不到或它抛错都只是"没有这个能力"，绝不该带走整个视图。
 */
function optionalService(ctx, name) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return undefined;
    return ctx.get(name);
  } catch (error) {
    degrade('可选服务读取失败：' + name, error);
    return undefined;
  }
}

/** 正文渲染：优先用宿主的渲染器，缺失时退回纯文本 */
function markdownBlock(text, key, labels) {
  if (!MarkdownText) return h('div', { key, className: 'sg-tx' }, text);
  return h('div', { key, className: 'sg-md' },
    h(MarkdownText, { text, labels, variant: 'compact' }));
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
/* 视图根铺满整个对话根，**包括输入框所占的那一条**。输入框的 z-index 更高，
   所以这里必须给它让位：padding-bottom 让画布与侧栏一起收在输入框之上
   （只给侧栏正文留白是不够的 —— 侧栏最后一段会被压住，正是"看不到对话内容"的成因）。 */
.sg-root{position:absolute;inset:0;box-sizing:border-box;padding-bottom:var(--sg-composer-reserve, 104px);display:flex;font-family:inherit;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);user-select:none;-webkit-user-select:none}
.sg-canvas-wrap{flex:1;min-width:0;position:relative;overflow:hidden;user-select:none;-webkit-user-select:none;
  cursor:grab;
  background-image:radial-gradient(var(--dsw-alias-border-l2) 1px,transparent 1px);background-size:22px 22px}
.sg-canvas-wrap.sg-panning{cursor:grabbing}
.sg-canvas-wrap.sg-linking{cursor:crosshair}
/* 归档会话：看得到、点不动，悬停说明原因（FR-14） */
.sg-label.sg-unavailable{opacity:.45;cursor:not-allowed}
/* 数据读不出来的块：降级显示，但仍可选中/连线/分叉（FR-13） */
.sg-node.sg-node-thin{border-style:dashed}
/* 取数还没落定：虚线示意"还在来"，文案是"载入中" —— 绝不画成"读不出来"那种假坏 */
.sg-node.sg-node-wait{border-style:dashed;border-color:var(--dsw-alias-border-l2)}
.sg-node.sg-node-wait .sg-ask{color:var(--dsw-alias-label-tertiary)}
/* 尚未载入的骨架块（FR-4）：点一下就把这一轮要回来 */
.sg-node.sg-node-skel{border-style:dashed;background:var(--dsw-alias-bg-base)}
.sg-node.sg-node-skel .sg-ans{color:var(--dsw-alias-state-business-primary)}
.sg-node.sg-node-thin .sg-ask{color:var(--dsw-alias-label-caption)}
/* 图角的状态说明（FR-13） */
.sg-corner{position:absolute;right:10px;bottom:8px;z-index:6;pointer-events:none;
  padding:3px 9px;border-radius:7px;font-size:11.5px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-caption);
  border:.5px solid var(--dsw-alias-border-l3);display:flex;gap:8px;align-items:center}
/* 降级那一段要能悬停看全文，所以单独把指针事件放回来（整块仍是 none，
   免得角标盖住下面的连线交互） */
.sg-corner-diag{pointer-events:auto;color:var(--dsw-alias-label-warning,#b26a00);cursor:help}
/* 空态 / 加载态 / 错误态 */
.sg-state{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:7;
  display:flex;flex-direction:column;gap:9px;align-items:flex-start;
  max-width:400px;padding:18px 20px;border-radius:12px;text-align:left;
  background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel)}
.sg-state-t{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sg-state-d{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.sg-state-code{font-size:11.5px;word-break:break-all;padding:6px 8px;border-radius:6px;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-caption);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sg-state-act{align-self:flex-start}
.sg-skel{background:transparent;box-shadow:none;align-items:center;width:220px}
.sg-skel-line{height:11px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);
  animation:sg-pulse 1.4s ease-in-out infinite}
@keyframes sg-pulse{0%,100%{opacity:.35}50%{opacity:.75}}
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
/* 骨架档下会话头右侧的就地展开入口（NFR-1） */
.sg-expand{flex:0 0 auto;width:15px;text-align:center;border-radius:4px;cursor:pointer;
  color:var(--dsw-alias-label-caption);font-size:11px}
.sg-expand:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 连线把手：悬停或选中时才显形，平时不打扰 */
.sg-handle{position:absolute;right:-6px;bottom:-6px;width:12px;height:12px;border-radius:50%;
  background:var(--dsw-alias-bg-layer-1);border:1.5px solid var(--dsw-alias-state-business-primary);
  cursor:crosshair;opacity:0;transition:opacity .12s;z-index:2}
.sg-node:hover .sg-handle,.sg-node.sg-selected .sg-handle{opacity:1}
.sg-node .sg-handle:hover{background:var(--dsw-alias-state-business-primary)}
/* 拖拽中的预览线 */
.sg-e-preview{fill:none;stroke:var(--dsw-alias-state-business-primary);stroke-width:1.6;
  stroke-dasharray:5 4;pointer-events:none}
/* 连线标签的输入浮层 */
.sg-linkdraft{position:absolute;z-index:30;display:flex;gap:6px;padding:6px;
  border-radius:9px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel)}
.sg-linkdraft-in{height:28px;width:180px;padding:0 9px;border-radius:7px;font:inherit;font-size:12.5px;
  border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary)}
.sg-linkdraft-in:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.sg-linkdraft-in.sg-wide{width:100%}
.sg-linkdraft-in.sg-rename-in{width:100%}
.sg-act.sg-danger{color:var(--dsw-alias-state-error-primary)}
.sg-act.sg-danger:hover{background:var(--dsw-alias-state-error-tertiary)}
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
/* 宽度对齐原型（prototype/session-graph-interactive.html 里是 width:330px / flex:0 0 330px）。
   **不要在 flex 简写里写数学函数**：一旦「flex:0 0 min(...)」被判定非法，整条声明作废
   并退回 flex-basis:auto —— 侧栏就按内容撑开（实测占掉大半屏，看起来跟没改一样）。
   所以用最保守的三个长写属性：定宽 330px、窄窗口 max-width 兜底、最小可用宽度。
   另：这段是模板字符串，注释里**不能出现反引号**，否则会提前闭合（构建期护栏见 build-client）。 */
.sg-side{flex:0 0 330px;max-width:46vw;min-width:240px;border-left:.5px solid var(--dsw-alias-border-l1);display:flex;
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
/* 唯一滚动的区域。输入框让位由 .sg-root 的 padding-bottom 统一负责（画布与侧栏一起让开），
   这里不再单独留白，否则侧栏底部会白出一大块。 */
/* 详情面板的**阅读优先**顺序：头部/元信息在最上（固定），正文（提问/回答）占满剩余高度，
   操作按钮压到最后一行。DOM 顺序仍是"固定区在前、滚动区在后"（切会话时元信息不该被正文挤走），
   这里只改视觉顺序 —— 所以用 flex order，而不是搬 JSX。 */
.sg-side-bd{flex:1;overflow-y:auto;padding:12px 15px 16px;min-height:0;order:1}
.sg-side-acts{order:2}
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

/**
 * 降级留痕。
 *
 * 宿主服务的形状不在我们手里，很多路径只能"退一步继续"（订阅不上就只用首帧、
 * 时间线读不动就当没有本地轮次）。但**退让必须留痕**：这个插件几次线上级故障的
 * 共同特征就是"看起来什么都没发生"—— 白屏、没有标签、取不到数，全是无声的。
 *
 * 所以每次降级记一条（有界环形缓冲），角标上给数字与最近一条原因。
 * 不写日志文件、不弹窗、不改变主流程 —— 但下一次出问题时，一张截图就能说清
 * "哪一步退让了"。
 */
const DIAG_LIMIT = 20;
const diagStore = (() => {
  let list = [];
  const listeners = new Set();
  return {
    getSnapshot: () => list,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    add(reason, error) {
      const detail = error && (error.message || String(error));
      const entry = { reason, detail: detail ? String(detail).slice(0, 200) : '', at: Date.now() };
      /* 同一个原因连着来就更新最后一条，别让重复把缓冲冲掉 */
      const last = list[list.length - 1];
      if (last && last.reason === reason) list = [...list.slice(0, -1), entry];
      else list = [...list, entry].slice(-DIAG_LIMIT);
      listeners.forEach((fn) => { try { fn(); } catch { /* 监听者自己炸了不该带走记录 */ } });
    }
  };
})();

/**
 * 量出输入框占掉的高度，让视图根把这一条让出来。
 *
 * 视图根铺满整个对话根，**包括输入框所占的那一条**；输入框 z-index 更高，
 * 所以详情面板的正文与底部按钮会被它压住（用户报的"内容还是会被遮挡"）。
 * 写死一个高度不行：输入框随窗口宽度、工具栏与统计行变化。这里直接量
 * "视图根底部 − 输入框顶部"，并把结果写进 CSS 变量。
 *
 * 找不到输入框就保留 CSS 里的兜底值 —— 宁可多留一点，也不要压住内容。
 */
function measureComposer(rootEl) {
  try {
    const doc = rootEl && rootEl.ownerDocument;
    if (!doc || typeof doc.querySelector !== 'function') return;
    const seat = doc.querySelector('[data-conversation-composer-overlay], [class*="composerSeat"]');
    if (!seat || typeof seat.getBoundingClientRect !== 'function') return;
    const overlap = Math.round(rootEl.getBoundingClientRect().bottom - seat.getBoundingClientRect().top);
    const reserve = Math.max(0, Math.min(overlap, 400));
    rootEl.style.setProperty('--sg-composer-reserve', reserve + 'px');
  } catch { /* 量不到就用兜底值，不影响渲染 */ }
}

/** 记一条降级：给角标留痕，也给控制台留一条 warn（不打断用户） */function degrade(reason, error) {
  diagStore.add(reason, error);
  try { console.warn('[session-graph] 降级：' + reason, error || ''); } catch { /* 控制台不可用 */ }
}

/**
 * 跑一段可能抛的代码：抛了就记一条降级并返回兜底值。
 * 用它替代"空 catch" —— 行为一样，但留下痕迹。
 */
function attempt(reason, fn, fallback) {
  try {
    return fn();
  } catch (error) {
    degrade(reason, error);
    return fallback;
  }
}

/**
 * 订阅一个快照源。只依赖 `{ getSnapshot, subscribe }` 这两个方法。
 *
 * **订阅与退订都必须自己守异常。** 它们是 effect 里的同步调用：一旦宿主某个服务
 * （`locale` / `sessions.list` / `workspaces.list` / 视图 target）的 `subscribe`
 * 抛错，React 会把这个组件整个卸掉 —— 表现就是**视图区纯白**，
 * 而标签（另一个纯 thunk）照常显示，看起来"只是没内容"。渲染期的兜底接不住它。
 */
function useSource(source) {
  const [value, setValue] = React.useState(() => attempt(
    '快照首帧读取失败',
    () => (source && source.getSnapshot ? source.getSnapshot() : undefined),
    undefined));
  React.useEffect(() => {
    if (!source || typeof source.subscribe !== 'function') return undefined;
    let alive = true;
    const pull = () => { if (alive) setValue(attempt('快照读取失败', () => source.getSnapshot(), undefined)); };
    pull();
    let off;
    try {
      off = source.subscribe(pull);
    } catch (error) {
      /* 订阅不上就只用首帧快照，绝不因此白屏 —— 但必须留痕 */
      degrade('订阅快照源失败', error);
      return undefined;
    }
    return () => {
      alive = false;
      attempt('退订快照源失败', () => { if (typeof off === 'function') off(); }, undefined);
    };
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
      /* 逐项守卫：这里是在**猜**宿主服务的形状，猜到的可能是需要上下文的函数 ——
         它抛错会让整片视图变白屏，代价太大。 */
      try {
        const v = typeof sessions[key] === 'function' ? sessions[key]() : sessions[key];
        if (typeof v === 'string' && v) return v;
      } catch (error) { degrade('会话服务形状探测失败', error); }
    }
  }
  const list = listOf(snapshot);
  const marked = list.find((s) => s && (s.current === true || s.active === true));
  if (marked) return marked.id || marked.sessionId;
  return list.length === 1 ? (list[0].id || list[0].sessionId) : '';
}

/** 归属某个会话的工作区 id；拿不到就回落第一个 */
function workspaceIdOf(ctx, sessionId) {
  try {
    /* 可选服务：走 optionalService，别用 ctx.workspaces 属性访问（未 inject 会抛） */
    const svc = optionalService(ctx, 'workspaces');
    const snap = svc && svc.list && svc.list.getSnapshot();
    const items = snap && Array.isArray(snap.items) ? snap.items : [];
    const hit = items.find((it) => Array.isArray(it.sessionIds) && it.sessionIds.includes(sessionId));
    return (hit && hit.workspaceId) || (items[0] && items[0].workspaceId) || '';
  } catch (error) {
    degrade('工作区读取失败', error);
    return '';
  }
}

/* ------------------------------------------------------------ 主组件 */

function GraphView(props) {
  const { ctx, target, sessions } = props || {};
  const listSnapshot = useSource(sessions && sessions.list);
  /* 降级记录也要订阅：角标显示"降级了几项"，出问题时截图即可定位 */
  const diagSnapshot = useSource(diagStore);
  /* 归档会话在图谱里仍会出现，但**点不动**（FR-14：目标不可用要禁用并说明原因）。
     `workspaces` 是可选服务，只能走 ctx.get —— 属性访问在未 inject 时会抛，
     而这一抛会让宿主把整个视图卸掉（白屏）。 */
  const workspacesSvc = optionalService(ctx, 'workspaces');
  const wsSnapshot = useSource(workspacesSvc && workspacesSvc.list);
  const archivedIds = React.useMemo(
    () => new Set((wsSnapshot && Array.isArray(wsSnapshot.archivedSessionIds))
      ? wsSnapshot.archivedSessionIds : []),
    [wsSnapshot]
  );
  const sessionId = resolveSessionId(props, listSnapshot);
  /* 语言（NFR-3）：走宿主的本地化服务；它认 {zh,en} 内联对象并按回退链解析。
     服务不可用时用本地字典，语义与宿主 resolveText 一致（缺键回退英文）。 */
  const localeSnap = useSource(ctx && ctx.locale);
  const activeLocale = (localeSnap && localeSnap.active) || 'zh';
  const t = React.useMemo(
    () => makeT(activeLocale, localeResolver(ctx)),
    [ctx, activeLocale]
  );
  /** 数字按当前语言排版（NFR-3 第三条） */
  const fmtNum = React.useCallback(
    (n) => formatNumber(n, activeLocale),
    [activeLocale]
  );
  const mdLabels = React.useMemo(() => markdownLabels(t), [t]);

  const [selected, setSelected] = React.useState(() => lastSelection.get(sessionId) || null);
  /* 切到别的视图会卸载本组件，选中块要活过重挂载（验收 13）。
     放模块级 Map 而不是存档：需求只要求跨视图切换保留，不要求跨刷新；
     而且这是"当前在看什么"，不是需要跨设备同步的图谱数据。 */
  React.useEffect(() => {
    if (sessionId) lastSelection.set(sessionId, selected);
  }, [sessionId, selected]);
  const [hidden, setHidden] = React.useState({});
  const [alias, setAlias] = React.useState({});
  const [links, setLinks] = React.useState([]);
  /* 用户摆过的坐标（FR-5：已拖拽过的块坐标即权威） */
  const [positions, setPositions] = React.useState({});
  /* 正在拖动中的块：{ id, x, y }，只在本地生效，松手才落盘 */
  const [draggingBlock, setDraggingBlock] = React.useState(null);
  /* 骨架档下用户显式展开的会话（NFR-1：其余按需展开） */  const [expandedSessions, setExpandedSessions] = React.useState([]);
  /* 用户显式折叠的会话（FR-11）。这是**自有数据**，要落盘（§5.2 的 collapsedSessions），
     否则切走再回来折叠状态就没了（验收：离开再回来保留折叠状态）。 */
  const [collapsedSessions, setCollapsedSessions] = React.useState(
    () => (sessionId && lastCollapsed.get(sessionId)) || []
  );
  /* 折叠状态也要活过组件重挂载（切视图会卸载），与选中块同一处理 */
  React.useEffect(() => {
    if (sessionId) lastCollapsed.set(sessionId, collapsedSessions);
  }, [sessionId, collapsedSessions]);
  /* 正在编辑的连线标签：{ id, value }。**编辑期间不落盘** ——
     原先每敲一个字符就 remember() + persist() 一次，撤销变成"退回一个字符"，
     而且 50 步历史会被一次输入冲光。改名输入框早就是这样先攒后提交的。 */
  const [labelDraft, setLabelDraft] = React.useState(null);
  const isExpanded = React.useCallback(
    (sid) => expandedSessions.indexOf(sid) >= 0,
    [expandedSessions]
  );
  /* 平移画布之后浏览器仍会补一个 click（mouseup 之后必到），落在会话头上就会顺带切会话。
     用这个 ref 把"拖出来的那一次 click"吃掉：按下时清、拖动了才置位。 */
  const suppressClickRef = React.useRef(false);
  /* 上一次布局耗时，供慢布局提示用 */
  const lastLayoutMsRef = React.useRef(0);
  /* 跨会话定位的待办：切完会话后还要切视图（FR-14） */
  const pendingLocateRef = React.useRef(null);
  const [selectedEdge, setSelectedEdge] = React.useState(null);
  /* 正在改名的块：{ id, value } */
  const [renaming, setRenaming] = React.useState(null);
  /* 持久化：存档读回来之后才允许写，避免首帧的空状态把存档冲掉 */
  const [writable, setWritable] = React.useState(true);
  const [incompatible, setIncompatible] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');
  const [loaded, setLoaded] = React.useState(false);
  const [showHidden, setShowHidden] = React.useState(false);
  const [collapseOthers, setCollapseOthers] = React.useState(false);
  const [view, setView] = React.useState({ scale: 1, panX: 24, panY: 20, fitted: false });
  const [exportOpen, setExportOpen] = React.useState(false);
  /* 详情面板可折叠（与原生 harness 的侧栏一致）：收起后画布占满，工具条上留一个开回来的入口 */
  const [sideOpen, setSideOpen] = React.useState(true);
  const [exportFmt, setExportFmt] = React.useState('mm');
  const [exportHidden, setExportHidden] = React.useState(false);
  const [toast, setToast] = React.useState('');
  /* 只留一个"路由是否可用"的布尔量，给空态说人话用；不对外暴露状态码 */
  const [routeOk, setRouteOk] = React.useState(true);
  const hostRef = React.useRef(null);
  const [size, setSize] = React.useState({ w: 900, h: 600 });

  const graphSnapshot = useSource(target);

  /* 视口尺寸：跟随容器，切换视图后回来仍正确。
     effect 里抛出的异常**不会**被渲染兜底捕获 —— React 会直接把组件卸掉，
     界面又变回白屏。所以这里的每一段 DOM 副作用都自己吞异常。 */
  React.useEffect(() => {
    try {
      const el = hostRef.current;
      if (!el || typeof ResizeObserver === 'undefined') return undefined;
      const ro = new ResizeObserver(() => {
        setSize({ w: el.clientWidth || 900, h: el.clientHeight || 600 });
        /* 输入框让位要**量**，不能猜：输入框的高度随窗口、工具栏、统计行变化，
           写死一个值不是被压住、就是白留一块。量出"视图根底部到输入框顶部"的距离。 */
        measureComposer(el);
      });
      ro.observe(el);
      setSize({ w: el.clientWidth || 900, h: el.clientHeight || 600 });
      measureComposer(el);
      return () => ro.disconnect();
    } catch (error) {
      degrade('视口尺寸测量失败', error);
      return undefined;                    /* 量不到尺寸就用默认视口，视图照常画 */
    }
  }, []);

  /* React 把 onWheel 注册成**被动**监听（facebook/react#19654），
     所以 onWheel 里那句 preventDefault 其实是空操作：滚轮会一边缩放、
     一边把外层容器滚走。这里补一个非被动的原生监听，只负责掐掉默认滚动；
     缩放逻辑仍由 React 的 onWheel 做，两处不重复执行缩放。 */
  React.useEffect(() => {
    try {
      const el = hostRef.current;
      if (!el || typeof el.addEventListener !== 'function') return undefined;
      const stopScroll = (ev) => { if (typeof ev.preventDefault === 'function') ev.preventDefault(); };
      el.addEventListener('wheel', stopScroll, { passive: false });
      return () => {
        if (typeof el.removeEventListener === 'function') el.removeEventListener('wheel', stopScroll);
      };
    } catch (error) {
      degrade('滚轮监听挂载失败', error);
      return undefined;                    /* 挂不上就退回 React 的被动监听，不因此白屏 */
    }
  }, []);

  /* 每次数据变化重建图模型。
     会话规范化本身也可能炸（宿主给的列表快照结构不对），
     它不能直接抛 —— FR-13 要求异常不得抛出视图之外，否则整页白屏。
     所以把规范化与建模放进同一个守卫，错误一律走错误态。 */
  const norm = React.useMemo(() => {
    try {
      return { sessions: normalizeSessions(listOf(listSnapshot)), error: null };
    } catch (e) {
      return { sessions: [], error: e };
    }
  }, [listSnapshot]);
  const sessionsNorm = norm.sessions;
  const sessionKey = sessionsNorm.map((s) => s.id).join(',');
  /* `sessions=` 只报**家族内**的会话。
     它的用途是把 Host 活跃列表里没有的家族成员补进来（例如已归档的父会话），
     而不是"请把整个目录都读一遍" —— 报全量会让 Host 侧"按家族收敛取数"的优化失效，
     点一个骨架块又变成重读整库（实测 40 会话 × 50 轮时会回传 1.8 MB）。 */
  const familyKey = React.useMemo(() => {
    if (!sessionId) return '';
    try {
      const order = familyOf(sessionsNorm, sessionId).order;
      return order.length ? order.join(',') : sessionKey;
    } catch (error) {
      degrade('家族计算失败', error);
      return sessionKey;                     /* 家族算不出来时退回全量，宁可慢不要漏 */
    }
  }, [sessionsNorm, sessionId, sessionKey]);
  const localTurns = React.useMemo(() => attempt(
    '本地时间线读取失败',
    () => turnsFromTimeline(graphSnapshot && graphSnapshot.timeline),
    []), [graphSnapshot]);

  /* 家族里其他会话的轮次要向 Host 取（本地的装配器时间线只覆盖当前会话）。
     取不到就退化成"只有当前会话有块"——家族骨架仍然完整。 */
  const [remote, setRemote] = React.useState(null);
  /* 重试计数：改一下就重跑取数 effect（FR-13 的「重试可恢复」） */
  const [reloadNonce, setReloadNonce] = React.useState(0);
  /* 超规模时被 Host 降级成骨架的块（FR-4）：只显示轮次号与提问预览 */
  const [skeletonIds, setSkeletonIds] = React.useState(() => new Set());
  /* 用户点过「载入」的轮次：下次取数点名要它们的完整数据（FR-4 的分页载入） */
  const [fullIds, setFullIds] = React.useState([]);
  /* 存档里的家族根 id 与视口，写回时要用 */
  const familyRef = React.useRef('');
  const savedViewportRef = React.useRef(null);
  /* 存档读回来之前禁止写：否则首帧的空状态会把已存的隐藏/别名冲掉 */
  const loadedRef = React.useRef(false);
  /* 还没落盘的键（攒在防抖里或请求在飞）。取数 effect 要用它，所以声明在 effect **之前**：
     它既在 effect 体里被调用，也在依赖数组里被求值，放后面会踩 TDZ。 */
  const pendingKeysRef = React.useRef(null);
  /** 取数回来时：还没落盘的键不能被存档覆盖（否则改动会"自己变回去"） */
  const freshFromServer = React.useCallback(
    (key) => !(pendingKeysRef.current && pendingKeysRef.current.has(key)),
    []
  );

  React.useEffect(() => {
    /* 没有可用的会话 id：不要停在"首次装配中"的骨架屏上等一辈子。
       原先这里直接 return，`loaded` 永远是 false，而空家族的骨架屏判定
       `!loaded && blocks === 0` 恒成立 —— 界面就一直转，什么都不会发生。 */
    if (!sessionId) { loadedRef.current = true; setLoaded(true); return undefined; }
    let alive = true;
    const url = '/api/session.graph-export'
      + '?format=json'
      + '&sessionId=' + encodeURIComponent(sessionId)
      + (familyKey ? '&sessions=' + encodeURIComponent(familyKey) : '')
        + (fullIds.length ? '&full=' + encodeURIComponent(fullIds.slice(-400).join(',')) : '');
    const carrier = typeof fetch === 'function' ? fetch : null;
    if (!carrier) { setRouteOk(false); setLoaded(true); return undefined; }
    /* `fetch` 本身也可能**同步**抛（URL 构造失败、被策略拦住等）。effect 里同步抛出
       不会被渲染兜底接住，React 会把组件整个卸掉 —— 又是白屏。所以整段套一层。 */
    let pending;
    try {
      pending = carrier(url, { credentials: 'same-origin' });
    } catch (error) {
      degrade('取数请求构造失败', error);
      setRouteOk(false);
      loadedRef.current = true;
      setLoaded(true);
      return undefined;
    }
    pending
      .then((r) => {
        if (!alive) return null;
        setRouteOk(!!(r && r.ok));
        return r && r.ok ? r.json() : null;
      })
      .then((data) => {
        if (!alive) return;
        if (!data) { setLoaded(true); loadedRef.current = true; return; }
        if (data.turns) setRemote(data.turns);
        /* 哪些块被降级成骨架，由 Host 的权威块表说了算（FR-4） */
        setSkeletonIds(new Set((Array.isArray(data.blocks) ? data.blocks : [])
          .filter((b) => b && b.skeleton)
          .map((b) => b.id)));
        if (typeof data.rootId === 'string') familyRef.current = data.rootId;
        /* 存档是基线，界面上的改动在此之上叠加。
           但**还没落盘的键**（攒在防抖里或请求在飞）不能被存档覆盖 ——
           否则"点了隐藏 → 顺手点个骨架块触发取数"就会把改动还原回去。 */
        const saved = data.state || null;
        if (freshFromServer('hiddenBlocks')) setHidden(saved && saved.hidden ? saved.hidden : {});
        if (freshFromServer('alias')) setAlias(saved && saved.alias ? saved.alias : {});
        if (freshFromServer('links')) setLinks(saved && saved.links ? saved.links : []);
        if (freshFromServer('positions')) setPositions(saved && saved.positions ? saved.positions : {});
        if (freshFromServer('collapsedSessions')) {
          setCollapsedSessions((saved && Array.isArray(saved.collapsedSessions)) ? saved.collapsedSessions : []);
        }
        setWritable(data.writable !== false);
        setIncompatible(!!data.incompatible);
        savedViewportRef.current = (saved && saved.viewport) || null;
        loadedRef.current = true;
        setLoaded(true);
      })
      .catch((error) => {
        if (!alive) return;
        degrade('取数失败', error);
        setRouteOk(false);
        loadedRef.current = true;
        setLoaded(true);
      });
    return () => { alive = false; };
  }, [sessionId, familyKey, reloadNonce, fullIds, freshFromServer]);

  /* 重试：清掉旧状态并重新取数（FR-13 验收 3「重试可恢复」） */
  const retry = React.useCallback(() => {
    setSaveError('');
    setRemote(null);
    setLoaded(false);
    loadedRef.current = false;
    setReloadNonce((n) => n + 1);
  }, []);

  /** 点名载入某一轮：下次取数把它的完整数据要回来（FR-4 的分页载入） */
  const loadTurn = React.useCallback((id) => {
    setFullIds((list) => (list.indexOf(id) >= 0 ? list : [...list, id]));
  }, []);

  /* 写回：交互写入按帧合并后节流提交（§5.3 的写入策略）。
     四条硬约束，前三条都是踩过的坑：

     1. **同一时刻只能有一个 POST 在飞。** Host 侧是"读-改-写"，两个请求并发时
        后一个会拿着旧状态覆盖前一个 —— 实测会整片丢掉 hiddenBlocks。
     2. **removeLinkIds 要取并集。** 原先用对象展开合并，后一次删除会把前一次的 id
        覆盖掉；而 links 在 Host 侧是按 id 合并的，被覆盖掉的那条连线于是在存档里"复活"。
     3. **记下哪些键还没落盘。** 取数是异步的，回来时若无条件用存档覆盖内存状态，
        刚做的改动会在一次取数后自己变回去。
     4. 报错文案要跟着语言走：原先 `t` 被 useCallback([]) 关在初次渲染的闭包里，
        换语言后写失败提示仍是旧语言。 */
  const writableRef = React.useRef(true);
  writableRef.current = writable;
  const tRef = React.useRef(t);
  tRef.current = t;
  const pendingRef = React.useRef(null);
  const timerRef = React.useRef(null);
  const inFlightRef = React.useRef(false);

  /** 合并两次增量：键覆盖，removeLinkIds 取并集 */
  const mergePayload = (prev, payload) => {
    const out = { ...(prev || {}), ...payload };
    if (prev && Array.isArray(prev.removeLinkIds) && Array.isArray(payload.removeLinkIds)) {
      out.removeLinkIds = [...new Set([...prev.removeLinkIds, ...payload.removeLinkIds])];
    }
    return out;
  };

  /** 发一批增量（串行：有请求在飞就先不发，等它落地再发） */
  const sendPending = React.useCallback(() => {
    if (inFlightRef.current) return;
    const body = pendingRef.current;
    pendingRef.current = null;
    if (!body || !familyRef.current || typeof fetch !== 'function') return;
    inFlightRef.current = true;
    /* 这一批涉及的键：**请求落地前一直算"脏"**，期间取数回来不能拿存档覆盖它们。
       只清这一批 —— 飞行期间新攒的键要留着。 */
    const sentKeys = pendingKeysRef.current ? [...pendingKeysRef.current] : [];
    const settle = () => {
      inFlightRef.current = false;
      if (pendingKeysRef.current) sentKeys.forEach((k) => pendingKeysRef.current.delete(k));
      /* 飞行期间又攒了增量：接着发，仍然串行 */
      if (pendingRef.current && !timerRef.current) sendPending();
    };
    fetch('/api/session.graph-export', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ familyRootId: familyRef.current, patch: body })
    }).then((r) => {
      if (r && r.ok) { setSaveError(''); return; }
      /* 提交失败：保留内存状态并标记未保存，而不是回滚用户刚做的操作 */
      setSaveError(r && r.status === 409
        ? tRef.current('ro.writeFailedIncompatible')
        : tRef.current('ro.writeFailed'));
      if (r && r.status === 409) setIncompatible(true);
    }).catch(() => setSaveError(tRef.current('ro.writeFailed'))).finally(settle);
  }, []);

  const persist = React.useCallback((patch) => {
    if (!loadedRef.current || !writableRef.current) return;
    const payload = clientPatchToState(patch);
    if (!Object.keys(payload).length) return;
    pendingRef.current = mergePayload(pendingRef.current, payload);
    const keys = pendingKeysRef.current || (pendingKeysRef.current = new Set());
    Object.keys(payload).forEach((k) => keys.add(k));
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => { timerRef.current = null; sendPending(); }, 400);
  }, [sendPending]);

  const clearPending = React.useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    pendingRef.current = null;
    pendingKeysRef.current = null;
  }, []);
  React.useEffect(() => () => clearPending(), [clearPending]);

  const turnsBySession = React.useMemo(() => {
    const out = { ...(remote || {}) };
    if (!sessionId || !localTurns.length) return out;
    /* 逐字段合并，而不是整条覆盖。
       本地时间线更新更快，但它的轮次记录里**没有问答文本**（文本在 data 这个 Map 里，
       按插件定义键存放），远程读的是原始事件、文本是齐的——
       整条覆盖会把文本抹成空。 */
    try {
      const byTurn = new Map((Array.isArray(out[sessionId]) ? out[sessionId] : []).map((t) => [t.turn, t]));
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
    } catch (error) {
      /* 远程载荷形状意外时保留原样，不让它把视图带成白屏 */
      degrade('远程轮次合并失败', error);
    }
    return out;
  }, [remote, localTurns, sessionId]);

  const graph = React.useMemo(() => {
    if (norm.error) return { error: norm.error };
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
  }, [norm, sessionsNorm, turnsBySession, sessionId, hidden, alias, links, showHidden]);

  const laid = React.useMemo(() => {
    if (!graph || graph.error) {
      lastLayoutMsRef.current = 0;
      return { nodes: [], headers: new Map(), bounds: null, opts: DEFAULT_LAYOUT };
    }
    try {
      /* 传进已摆过的坐标：布局只负责没有坐标的那些（FR-5） */
      const timed = timedLayout(() => layout(graph, { positions }));
      lastLayoutMsRef.current = timed.ms;
      return timed.result;
    } catch {
      lastLayoutMsRef.current = 0;
      return { nodes: [], headers: new Map(), bounds: null, opts: DEFAULT_LAYOUT };
    }
  }, [graph, positions]);

  /* 规模降级（NFR-1）：按块数选档，越大的档省得越多 */
  const tier = graph && !graph.error ? tierOf(graph.stats.blocks) : 'full';
  const feats = tierFeatures(tier);
  /* 档位允许画块的会话；null 表示不限 */
  const tierSessions = graph && !graph.error
    ? sessionsWithBlocks(graph.sessions, tier, sessionId, expandedSessions)
    : null;
  /* 会话折叠（FR-5 / FR-11）：折叠非当前会话的块，只留会话头与指向它的派生边。
     两个来源 —— 工具条的「折叠其他会话」是临时密度开关（像「显示已隐藏」一样不入存档），
     会话头上的 ▾ 是用户对单个会话的显式折叠（入存档，切走再回来还在）。
     当前会话永不折叠：正在跟的那条线不该被藏起来。 */
  const collapseAllOthers = collapseOthers || collapsedSessions.length > 0;
  const blockSessions = (() => {
    if (!graph || graph.error) return null;
    if (!tierSessions && !collapseAllOthers) return null;
    const out = new Set(tierSessions || graph.sessions.map((s) => s.id));
    if (collapseOthers) {
      for (const s of graph.sessions) {
        if (s.id !== sessionId && !isExpanded(s.id)) out.delete(s.id);
      }
    }
    for (const id of collapsedSessions) {
      if (id !== sessionId) out.delete(id);
    }
    out.add(sessionId);
    return out;
  })();

  /* 布局慢过预算就提示（NFR-1 的第三条阈值） */
  const [slowLayout, setSlowLayout] = React.useState(false);
  React.useEffect(() => {
    setSlowLayout(lastLayoutMsRef.current > SLOW_LAYOUT_MS);
  }, [laid]);

  /* 拖动中的块就地覆盖坐标：连线跟着走，松手才落盘 */
  const shownNodes = React.useMemo(() => {
    if (!draggingBlock) return laid.nodes;
    return laid.nodes.map((n) => (n.id === draggingBlock.id
      ? { ...n, x: draggingBlock.x, y: draggingBlock.y } : n));
  }, [laid, draggingBlock]);

  const nodeMap = React.useMemo(() => new Map(shownNodes.map((n) => [n.id, n])), [shownNodes]);

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
  /* 连线模式（FR-9）：drag = 从把手拖出，click = 面板里点了「连接到…」再点目标 */
  const [linking, setLinking] = React.useState(null);
  /* 刚建好的连线，等用户给标签 */
  const [linkDraft, setLinkDraft] = React.useState(null);

  /** 屏幕坐标 → 世界坐标（预览线要用） */
  const toWorld = React.useCallback((ev) => {
    const r = hostRef.current ? hostRef.current.getBoundingClientRect() : { left: 0, top: 0 };
    return {
      x: (ev.clientX - r.left - view.panX) / view.scale,
      y: (ev.clientY - r.top - view.panY) / view.scale
    };
  }, [view]);

  /** 屏幕坐标 → 画布内坐标（浮层定位要用，不参与世界变换） */
  const toCanvas = React.useCallback((ev) => {
    const r = hostRef.current ? hostRef.current.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }, []);

  /* ------------------------------------------------------------ 撤销 */

  /* 快照式撤销：这几份自有数据就是全部可变状态，量也小，
     与其为每种操作写一个逆操作，不如存一份快照。上限 50 步。 */
  const historyRef = React.useRef([]);
  const [canUndo, setCanUndo] = React.useState(false);

  /** 在任何变更**之前**调用 */
  const remember = React.useCallback(() => {
    historyRef.current.push({ hidden, alias, links, positions, collapsedSessions });
    if (historyRef.current.length > 50) historyRef.current.shift();
    setCanUndo(true);
  }, [hidden, alias, links, positions, collapsedSessions]);

  /** 把界面与存档一起恢复到某个快照；多出来的连线要显式删掉 */
  const applySnapshot = React.useCallback((snap) => {
    const keep = new Set(snap.links.map((l) => l.id));
    const removeLinkIds = links.filter((l) => !keep.has(l.id)).map((l) => l.id);
    const nextPositions = snap.positions || {};
    const nextCollapsed = Array.isArray(snap.collapsedSessions) ? snap.collapsedSessions : [];
    setHidden(snap.hidden);
    setAlias(snap.alias);
    setLinks(snap.links);
    setPositions(nextPositions);
    setCollapsedSessions(nextCollapsed);
    persist({
      hidden: snap.hidden, alias: snap.alias, links: snap.links,
      positions: nextPositions, collapsedSessions: nextCollapsed, removeLinkIds
    });
  }, [links, persist]);

  const undo = React.useCallback(() => {
    const snap = historyRef.current.pop();
    setCanUndo(historyRef.current.length > 0);
    if (!snap) { say(t('toolbar.nothingToUndo')); return; }
    applySnapshot(snap);
  }, [applySnapshot, say]);

  /* ---- 会话折叠（FR-5 / FR-11）----
     放在撤销之后：它要用到 remember（TDZ，声明顺序不能反）。 */

  /** 这个会话的块现在是否被折叠了 */
  const isCollapsed = React.useCallback((sid) => {
    if (!sid || sid === sessionId) return false;
    return !!blockSessions && !blockSessions.has(sid);
  }, [blockSessions, sessionId]);

  /** 会话头 ▸/▾：展开 = 从折叠集合里拿掉并记进"显式展开"；折叠 = 反过来 */
  const toggleSession = React.useCallback((sid) => {
    if (!sid || sid === sessionId) return;
    const nowCollapsed = !!blockSessions && !blockSessions.has(sid);
    const nextCollapsed = nowCollapsed
      ? collapsedSessions.filter((x) => x !== sid)
      : (collapsedSessions.indexOf(sid) >= 0 ? collapsedSessions : [...collapsedSessions, sid]);
    remember();
    setExpandedSessions((list) => (nowCollapsed
      ? (list.indexOf(sid) >= 0 ? list : [...list, sid])
      : list.filter((x) => x !== sid)));
    setCollapsedSessions(nextCollapsed);
    persist({ collapsedSessions: nextCollapsed });
  }, [blockSessions, collapsedSessions, persist, remember, sessionId]);

  /** 建立一条手动连线（FR-9），随后弹出标签输入框 */
  const createLink = React.useCallback((from, to, at) => {
    if (!from || !to) return;
    if (from === to) { say(t('link.self')); return; }
    /* 同一对块之间允许多条（不同标签），所以 id 要唯一而不是由端点决定 */
    const id = `link:${from}->${to}:${Date.now().toString(36)}`;
    const next = [...links, { id, kind: 'link', from, to }];
    remember();
    setLinks(next);
    persist({ links: next });
    setLinkDraft({ id, value: '', x: at ? at.x : 0, y: at ? at.y : 0 });
  }, [links, persist, say, remember]);

  /** 写入某条连线的标签；空字符串即清除标签 */
  const labelLink = React.useCallback((id, value) => {
    const text = String(value === undefined || value === null ? '' : value).trim().slice(0, 120);
    const target = links.find((l) => l.id === id);
    /* 没改就不写：点进输入框又点走不该占一格撤销、也不该发一次 POST */
    if (target && String(target.label || '').trim() === text) return;
    const next = links.map((l) => {
      if (l.id !== id) return l;
      if (text === '') { const { label: _drop, ...rest } = l; return rest; }
      return { ...l, label: text };
    });
    remember();
    setLinks(next);
    persist({ links: next });
  }, [links, persist, remember]);

  /** 重命名（FR-11）：写入别名；留空即恢复自动标题 */
  const renameBlock = React.useCallback((id, value) => {
    const text = String(value === undefined || value === null ? '' : value).trim().slice(0, 120);
    if (String(alias[id] || '').trim() === text) { setRenaming(null); return; }
    const next = { ...alias };
    if (text === '') delete next[id];
    else next[id] = text;
    remember();
    setAlias(next);
    persist({ alias: next });
    setRenaming(null);
  }, [alias, persist, remember]);

  /** 删除一条手动连线 */
  const removeLink = React.useCallback((id) => {
    const next = links.filter((l) => l.id !== id);
    remember();
    setLinks(next);
    persist({ links: next, removeLinkIds: [id] });
    setSelectedEdge(null);
  }, [links, persist, remember]);

  /**
   * 新建引用式会话（FR-7）：**不继承历史**的独立会话，用一条引用边把它与源块连起来。
   *
   * 新会话是**独立根**，不在源会话的血缘里，靠这条引用边被拉进图谱范围（§5.2）。
   * 失败时不留下孤立引用记录 —— 需求里点名的失败行为。
   */
  const createRefSession = React.useCallback(async (b) => {
    const api = ctx && ctx.sessions;
    if (!api || typeof api.create !== 'function') {
      say(t('ref.noCreate'));
      return;
    }
    const wsId = workspaceIdOf(ctx, b.sessionId);
    if (!wsId) {
      say(t('ref.noWorkspace'));
      return;
    }
    let newId;
    try {
      newId = await api.create({ workspaceId: wsId });
    } catch (e) {
      say(t('ref.createFailed', { msg: (e && e.message) || e }));
      return;
    }
    if (!newId || typeof newId !== 'string') {
      say(t('ref.noId'));
      return;
    }
    /* 先落引用边：即便随后导航失败，用户至少能在图上看到这条关系 */
    const label = b.alias || clip(digest(b.prompt), 24) || '';
    const id = `reference:${b.id}->${newId}:${Date.now().toString(36)}`;
    const next = [...links, {
      id, kind: 'reference', from: b.id, to: `header:${newId}`,
      ...(label ? { label } : {})
    }];
    remember();
    setLinks(next);
    persist({ links: next });
    if (ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === 'function') {
      try {
        ctx.uiWorkspace.openSession(newId);
      } catch {
        say(t('ref.navFailed'));
        return;
      }
    }
    say(t('link.created'));
  }, [ctx, links, persist, remember, say]);

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
    /* 工具条、边标签、标签输入框都不能被当成画布：
       这个处理函数会 preventDefault，落在输入框上会让它永远拿不到焦点。 */
    if (el.closest && el.closest('.sg-tools, .sg-elabel, .sg-linkdraft')) return;
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

    /* 从块右下角的把手拖出连线（FR-9） */
    const handleEl = el.closest ? el.closest('[data-sg-link-handle]') : null;
    if (handleEl) {
      const from = handleEl.getAttribute('data-sg-link-handle');
      if (from && nodeMap.has(from)) {
        const p = toWorld(ev);
        setLinking({ from, mode: 'drag', x: p.x, y: p.y });
        drag.current = null;
        return;
      }
    }

    /* 连线模式下点目标块即完成（FR-9 的第二条触发路径） */
    if (linking && linking.mode === 'click') {
      if (!hit) return;                      /* 点空白不取消，避免误触 */
      setLinking(null);
      if (hit === linking.from) { say(t('link.self')); return; }
      createLink(linking.from, hit, toCanvas(ev));
      return;
    }

    /* 在**按下**时选中，而不是等抬起：双击过程中手抖一两个像素很常见，
       若靠"没移动过"来决定选中，双击就会既不选中、又照样分叉 */
    if (hit) setSelected(hit);
    /* 骨架块点一下就点名载入（FR-4）；选中照样发生，两个动作不冲突 */
    const hitNode = hit ? nodeMap.get(hit) : null;
    if (hitNode && hitNode.kind === 'block' && skeletonIds.has(hit)
      && !digest(hitNode.block.response)) {
      loadTurn(hit);
    }
    const node = hit ? nodeMap.get(hit) : null;
    /* 新手势开始：上一次留下的"吃掉这次 click"标记要清掉 */
    suppressClickRef.current = false;
    /* 拖块 = 移动块，拖空白 = 平移（FR-5）。块上起手不再平移 ——
       那会让"想挪块"变成"整张图跑掉"。 */
    drag.current = node && node.kind === 'block'
      ? { kind: 'move', id: hit, sx: ev.clientX, sy: ev.clientY, ox: node.x, oy: node.y, moved: false, focus: hit }
      : { kind: 'pan', sx: ev.clientX, sy: ev.clientY, px: view.panX, py: view.panY, moved: false, id: hit };
    setPanning(true);
  }, [nodeMap, view, linking, createLink, say, toWorld, toCanvas, skeletonIds, loadTurn]);

  /* 全局监听只在挂载时注册一次。但它要用到每次渲染都可能变的值（连线状态、
     新建回调、节点表…），直接闭包会读到陈旧值；把最新值放进 ref，
     既不重复注册监听、又永远读到当前值。 */
  const latestRef = React.useRef({});
  latestRef.current = {
    linking, createLink, say, toWorld, toCanvas, nodeMap,
    draggingBlock, positions, view, remember, persist
  };

  React.useEffect(() => {
    const move = (ev) => {
      const L = latestRef.current;
      /* 拖拽连线中：预览线跟着指针走 */
      if (L.linking && L.linking.mode === 'drag') {
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        const p = L.toWorld(ev);
        setLinking((l) => (l && l.mode === 'drag' ? { ...l, x: p.x, y: p.y } : l));
        return;
      }
      const d = drag.current;
      if (!d) return;
      /* 拖拽期间持续拦默认行为：挡住原生的拖放、拖拽滚动与选区 */
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      const dx = ev.clientX - d.sx;
      const dy = ev.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.kind === 'move') {
        /* 坐标按当前缩放换算回世界坐标，块才会贴着指针走 */
        const k = L.view && L.view.scale ? L.view.scale : 1;
        setDraggingBlock({ id: d.id, x: Math.round(d.ox + dx / k), y: Math.round(d.oy + dy / k) });
        return;
      }
      if (d.kind === 'pan') {
        viewTouchedRef.current = true;
        setView((v) => ({ ...v, panX: d.px + dx, panY: d.py + dy, fitted: true }));
      }
    };
    const up = (ev) => {
      const L = latestRef.current;
      const d = drag.current;
      drag.current = null;
      setPanning(false);

      /* 松手才落盘（FR-5：松手后写入自有布局），拖动过程中只改本地坐标 */
      if (d && d.kind === 'move') {
        const live = L.draggingBlock;
        setDraggingBlock(null);
        if (d.moved && live && live.id === d.id) {
          const next = { ...L.positions, [d.id]: { x: live.x, y: live.y } };
          L.remember();
          setPositions(next);
          L.persist({ positions: next });
        }
        return;
      }

      /* 松手落在哪个块上就与它连线；落在空白处取消（FR-9） */
      if (L.linking && L.linking.mode === 'drag') {
        const el = ev && ev.target;
        const nodeEl = el && el.closest ? el.closest('[data-sg-node]') : null;
        const to = nodeEl ? nodeEl.getAttribute('data-sg-node') : null;
        const from = L.linking.from;
        setLinking(null);
        if (!to) return;                                    /* 落在空白处：取消 */
        if (to === from) { L.say(t('link.self')); return; }
        if (L.nodeMap.has(to)) L.createLink(from, to, L.toCanvas(ev));
        return;
      }

      /* 拖出来的平移不要顺带当成"点了一下会话头"：mouseup 之后浏览器必补一个 click */
      if (d && d.kind === 'pan' && d.moved) suppressClickRef.current = true;

      /* 空白处单击（且没拖动）才清选中；点在块上时选中已在按下时给过了 */
      if (d && !d.moved && !d.id) setSelected(null);
    };
    /* 拖到窗口外再松手也要收尾，否则拖拽状态会一直挂着 */
    const cancel = (ev) => {
      if (!ev || ev.key !== 'Escape') return;
      drag.current = null;
      setPanning(false);
      setLinking(null);
      setLinkDraft(null);
      setSelectedEdge(null);
      setRenaming(null);
    };
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
    /* Ctrl/Cmd+Z 撤销（FR-11：每个操作可撤销，可逐步回退） */
    if ((k === 'z' || k === 'Z') && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); undo(); return; }
    if (k === 'f' || k === 'F') { ev.preventDefault(); fit(); return; }
    if (k === 'Escape') { ev.preventDefault(); setExportOpen(false); setSelected(null); return; }
    if (k.indexOf('Arrow') === 0) {
      ev.preventDefault();
      const next = moveSelection(laid.nodes, selected, k);
      if (next) setSelected(next);
    }
  }, [fit, laid, selected, undo]);

  /* ---- 动作 ---- */
  const doFork = React.useCallback((sid, turn) => {
    if (!graph || graph.error) return;
    const block = graph.blocks.find((b) => b.sessionId === sid && b.turn === turn);
    if (block && block.status === 'open') { say(t('fork.openTurn')); return; }
    const atSeq = block ? block.endSeq : null;
    if (atSeq === null || atSeq === undefined) { say(t('fork.noBoundary')); return; }
    const titles = graph.sessions.map((s) => s.title);
    const src = graph.sessions.find((s) => s.id === sid);
    const childTitle = src ? uniqueTitle(src.title, titles) : undefined;
    const done = () => say(t('fork.done', { turn }) + (childTitle ? ' → ' + childTitle : ''));
    const failed = (err) => {
      const code = err && err.rpcError ? err.rpcError.code : '';
      if (code === 'session/fork-unavailable') say(t('fork.noneAvailable'));
      else if (code === 'session/not-found') say(t('fork.sourceUnavailable'));
      else say(t('fork.failed', { msg: err && err.message ? err.message : String(err) }));
    };
    try {
      const p = ctx.sessions.fork({ sessionId: sid, atSeq, increaseTitle: true, onCreated: () => undefined });
      /* 失败时**不能先报成功**：原先无论结果如何都立刻弹"已分叉"，
         分叉被拒绝时用户会同时看到成功与失败两条互相矛盾的提示。 */
      if (p && typeof p.then === 'function') p.then(done, failed);
      else done();
    } catch (e) {
      failed(e);
    }
  }, [ctx, graph, say]);

  const openSession = React.useCallback((sid) => {
    if (!sid || sid === sessionId) return;
    /* FR-14：目标不可用时不跳转，并说明原因 */
    if (archivedIds.has(sid)) { say(t('head.archived')); return; }
    /* 优先用宿主的标准导航：侧栏、标题栏、面包屑都会跟着变 */
    const nav = ctx && ctx.uiWorkspace;
    if (nav && typeof nav.openSession === 'function') {
      try {
        nav.openSession(sid);
      } catch (e) {
        say(t('nav.switchFailed', { msg: (e && e.message) || e }));
      }
      return;
    }
    if (typeof props.onOpenSession === 'function') { props.onOpenSession(sid); return; }
    say(t('nav.noSwitch'));
  }, [ctx, props, say, sessionId, archivedIds]);

  /**
   * 在对话视图中定位该轮（FR-14）。
   *
   * 能做到：切到目标会话、切到对话视图。
   * **做不到：滚动到指定的那一轮。** 宿主没有公开的"滚动到某轮"入口 ——
   * 视图切换请求里的 `focus` 只有轨迹视图会读，对话视图不认。
   * 所以这里不传 focus（传了也是被静默忽略，等于造一个假入口），
   * 改为明确告诉用户该去找第几轮。
   */
  const locateInConversation = React.useCallback((b) => {
    if (!b) return;
    const note = t('nav.located', { turn: b.turn });
    if (b.sessionId !== sessionId) {
      /* 换会话要重新挂载视图，切视图得等挂载后再做 */
      pendingLocateRef.current = { sessionId: b.sessionId, note };
      openSession(b.sessionId);
      return;
    }
    if (typeof props.openView !== 'function') { say(t('nav.noView')); return; }
    props.openView('transcript-view');
    say(note);
  }, [props, sessionId, openSession, say]);

  /* 跨会话定位的第二步：目标会话的视图挂出来之后再切视图 */
  React.useEffect(() => {
    const p = pendingLocateRef.current;
    if (!p || p.sessionId !== sessionId) return;
    pendingLocateRef.current = null;
    if (typeof props.openView !== 'function') return;
    props.openView('transcript-view');
    say(p.note);
  }, [sessionId, props, say]);

  /* 导出：生成内容 → 不挂到 body 的 anchor 触发下载。
     顺带把"因隐藏而跳过的块数"带出来：对话框原来读的是画布那张图的 stats，
     而画布可能开着「显示已隐藏」，于是提示条会说"一个都没跳过"，与真正导出的文件不符。 */
  const exportText = React.useCallback((fmt, includeHidden) => {
    const g = buildGraph({
      sessions: sessionsNorm, turnsBySession, currentId: sessionId,
      hidden, alias, links, includeHidden
    });
    const out = render(g, fmt, { links, stamp: stamp(new Date()) });
    return { ...out, hiddenSkipped: g.stats.hiddenSkipped };
  }, [sessionsNorm, turnsBySession, sessionId, hidden, alias, links]);

  /* 导出（FR-15）：优先走 Host 路由——先 HEAD 预检，通过后交给浏览器下载管理器；
     路由不可用时回落到本地生成 + Blob，保证功能不因为接线问题而消失。
     **连线要一起发**：Host 侧只认存档，而连线可能还在 400ms 防抖里没落盘，
     只读模式下更是永远落不了盘 —— 那时导出的文件会一条连线都没有，与预览不符。 */
  const routeUrl = React.useCallback((fmt, includeHidden) => {
    return '/api/session.graph-export'
      + '?format=' + fmt
      + '&sessionId=' + encodeURIComponent(sessionId)
      + (familyKey ? '&sessions=' + encodeURIComponent(familyKey) : '')
      + (includeHidden ? '&includeHidden=true' : '')
      + (Object.keys(hidden).length ? '&hidden=' + encodeURIComponent(JSON.stringify(hidden)) : '')
      + (Object.keys(alias).length ? '&alias=' + encodeURIComponent(JSON.stringify(alias)) : '')
      + (links.length ? '&links=' + encodeURIComponent(JSON.stringify(links)) : '');
  }, [familyKey, sessionId, hidden, alias, links]);

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
      say(t('export.failed', { msg: e && e.message ? e.message : String(e) }));
      return;
    }
    const url = routeUrl(fmt, exportHidden);
    try {
      if (typeof fetch === 'function') {
        const head = await fetch(url, { method: 'HEAD', credentials: 'same-origin' });
        if (head && head.ok) {
          saveUrl(url);                      /* 文件名由 Content-Disposition 决定 */
          setExportOpen(false);
          say(t('export.downloading', { name: filename }));
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
      say(t('export.downloading', { name: out.filename }));
    } catch (e) {
      say(t('export.failed', { msg: e && e.message ? e.message : String(e) }));
    }
  }, [exportFmt, exportHidden, exportText, routeUrl, saveUrl, say, t]);

  /* ---- 渲染 ---- */
  /* 规模降级在这里生效：骨架档只画会话头 + 指定会话的块（NFR-1） */
  const nodes = shownNodes.filter((n) => {
    if (n.kind !== 'block') return true;                       /* 会话头与空节点始终在 */
    if (!showHidden && n.block.hidden) return false;
    if (blockSessions && !blockSessions.has(n.sessionId)) return false;
    return true;
  });
  const cell = nodes.map((n) => {
    if (n.kind === 'header') {
      const gone = archivedIds.has(n.sessionId);
      const collapsible = (feats.skeletonOnly || collapseOthers || collapsedSessions.length > 0)
        && n.sessionId !== sessionId && !!n.turnCount;
      return h('div', {
        key: n.id,
        className: 'sg-label' + (n.sessionId === sessionId ? ' sg-current' : '')
          + (gone ? ' sg-unavailable' : ''),
        style: { left: n.x, top: n.y, minWidth: n.w, height: n.h },
        title: gone ? t('head.archived') : t('head.switchTip'),
        'aria-disabled': gone ? 'true' : undefined,
        /* 拖会话头是平移画布（所有非块节点都走平移），松手时浏览器还会补一个 click。
           不平移过的才当"切换会话"，否则一拖就跳走 —— 块上早就这么防了，会话头漏了。 */
        onClick: gone ? undefined : () => {
          if (suppressClickRef.current) { suppressClickRef.current = false; return; }
          openSession(n.sessionId);
        }
      },
      h('span', { className: 'sg-sdot' }),
      h('span', { className: 'sg-st' }, n.title),
      h('span', { className: 'sg-sm' }, t('head.turnCount', { n: fmtNum(n.turnCount) })),
      /* 被折叠（骨架档或用户折叠）的会话：头上给一个就地展开的入口（NFR-1 / FR-11） */
      collapsible
        ? h('span', {
          className: 'sg-expand',
          title: isCollapsed(n.sessionId) ? t('head.expand') : t('head.collapse'),
          onClick: (ev) => { ev.stopPropagation(); toggleSession(n.sessionId); }
        }, isCollapsed(n.sessionId) ? '▸' : '▾')
        : null);
    }
    if (n.kind === 'empty') {
      return h('div', {
        key: n.id, className: 'sg-node sg-empty',
        style: { left: n.x, top: n.y, width: n.w, minHeight: n.h }
      }, h('span', null, t('block.emptyChild')));
    }
    const b = n.block;
    /* FR-13：部分块数据读不出来时**该块降级**，而不是整张图报错。
       判定与 stats.incomplete 一致：这一轮已结束，但提问与回答都没有文本。

       **但"还没排空取数"不等于"读不出来"**：切回图谱时视图会重新挂载，首帧只有
       本地时间线（有轮次号、没有正文），此时画告警态就是在指控数据丢失 ——
       用户看到的就是一闪而过的"假坏"。所以取数未落定（!loaded）时按**载入中**画，
       排空之后仍无正文，才是真的降级。 */
    const pending = !loaded;
    const thin = !pending && b.status !== 'open' && !digest(b.prompt) && !digest(b.response);
    const waiting = pending && b.status !== 'open' && !digest(b.prompt) && !digest(b.response);
    /* FR-4：超规模时 Host 把这个块降成了骨架 —— 有提问预览、没有回答。
       本地时间线若带着正文，合并之后就不再是骨架，那时按普通块画。 */
    const skel = !thin && skeletonIds.has(n.id) && !digest(b.response);
    const cls = 'sg-node'
      + (b.current ? ' sg-current' : '')
      + (selected === n.id ? ' sg-selected' : '')
      + (b.hidden && showHidden ? ' sg-hidden' : '')
      + (thin ? ' sg-node-thin' : '')
      + (waiting ? ' sg-node-wait' : '')
      + (skel ? ' sg-node-skel' : '');
    const badges = [];
    if (b.toolCalls) badges.push(h('span', { key: 't', className: 'sg-badge' }, '⚙ ' + b.toolCalls));
    if (b.deliverables) badges.push(h('span', { key: 'd', className: 'sg-badge' }, '⧉ ' + b.deliverables));
    return h('div', {
      key: n.id,
      className: cls,
      'data-sg-node': n.id,
      tabIndex: 0,
      role: 'button',
      'aria-label': t('block.ariaLabel', { turn: b.turn, prompt: clip(digest(b.prompt), 120) }),
      style: { left: n.x, top: n.y, width: n.w, minHeight: n.h },
      onDoubleClick: (e) => { e.stopPropagation(); doFork(b.sessionId, b.turn); },
      onKeyDown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); setSelected(n.id); } }
    },
    h('div', { className: 'sg-hd' },
      h('span', { className: 'sg-turn' }, t('block.turn', { turn: b.turn })),
      h('span', { className: 'sg-dot' + (b.status === 'open' ? ' sg-open' : b.status === 'failed' ? ' sg-failed' : '') }),
      h('span', { className: 'sg-sp' }),
      badges),
    h('div', { className: 'sg-ask' + (digest(b.prompt) ? '' : ' sg-empty') },
      b.alias ? '✎ ' + b.alias : (clip(digest(b.prompt), 110)
        || (waiting ? t('block.loading') : (thin ? t('block.thin') : t('block.noPrompt'))))),
    feats.blockText
      ? h('div', { className: 'sg-ans' }, clip(digest(b.response, 'first-paragraph'), 220)
        || (skel ? t('block.loadFull') : thin ? t('block.thinResponse') : t('block.noResponse')))
      : null,
    /* 连线把手：拖到另一个块即可建立手动边（FR-9）。悬停或选中时才显形。 */
    h('div', {
      className: 'sg-handle',
      'data-sg-link-handle': n.id,
      title: t('link.handleTip')
    }));
  });

  /* 三种边不只靠颜色区分（§5.2）：线型不同，箭头也分实心与空心。
     终点若没被画出来（骨架档或会话被折叠），按需求 FR-11 退到**它所属会话的会话头**；
     两端都画不出来就不画这条边 —— 否则会出现"从空白处拉到空白处"的线。
     边的起点本来就有会话头兜底（见 graph.js 的 edgePath）。 */
  const edgeList = (graph.error ? [] : graph.edges).map((e) => {
    if (nodeMap.has(e.to)) return e;
    if (e.kind === 'branch' && e.sessionId && nodeMap.has(`header:${e.sessionId}`)) {
      return { ...e, to: `header:${e.sessionId}` };
    }
    return e;
  });
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

  /* 标签落在边中点；过长由 CSS 截断，title 给完整文本（FR-9）。
     密集档起不画标签 —— 那是边渲染里最贵的一块（NFR-1）。 */
  const edgeLabels = feats.edgeLabels ? edgeList.map((e) => {
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
  }).filter(Boolean) : [];

  /* 拖拽连线中的预览线：从源块右中侧连到指针 */
  const previewEdge = (linking && linking.mode === 'drag' && Number.isFinite(linking.x))
    ? (() => {
      const a = nodeMap.get(linking.from);
      if (!a) return null;
      return h('path', {
        key: '__link-preview',
        className: 'sg-e-preview',
        d: curve(R(a), [linking.x, linking.y])
      });
    })()
    : null;

  /* 断裂的边指向已不存在的块：几何上画不出来，但**不能装作没这回事** */
  const brokenCount = edgeList.filter((e) => e.broken).length;

  /* 图角的状态说明（FR-13）：数据不完整、断裂连线都要报数 */
  const cornerNotes = [];
  if (!graph.error && skeletonIds.size > 0) {
    cornerNotes.push(t('corner.skeleton', { n: fmtNum(skeletonIds.size) }));
  }
  if (!graph.error && graph.stats.incomplete > 0) {
    cornerNotes.push(t('corner.incomplete', { n: fmtNum(graph.stats.incomplete) }));
  }
  if (brokenCount > 0) cornerNotes.push(t('corner.broken', { n: fmtNum(brokenCount) }));

  /* 降级留痕（见 degrade）：角标给数字与最近一条原因，悬停看全部。
     这一条的存在意义就是——下次出问题时**一张截图**就能说清哪一步退让了。 */
  const diagEntries = diagSnapshot;
  const diagNote = diagEntries.length
    ? h('span', {
        className: 'sg-corner-diag',
        title: diagEntries.map((d) => d.reason + (d.detail ? '：' + d.detail : '')).join('\n')
      }, t('corner.degraded', {
        n: fmtNum(diagEntries.length),
        why: diagEntries[diagEntries.length - 1].reason
      }))
    : null;

  const cornerNote = (cornerNotes.length || diagNote)
    ? h('div', { className: 'sg-corner' }, [...cornerNotes, diagNote].filter(Boolean))
    : null;

  /* 首次装配中：Host 还没回来、本地一个块也没有 → 骨架屏（FR-13）。
     注意不能拿 laid.nodes 是否为空来判断 —— 会话头也是节点，
     只要家族里有会话它就不空，骨架屏将永远不会出现。 */
  /* 注意：graph.stats 只在装配成功时存在，出错时**没有** stats —— 必须先判 error */
  const emptyFamily = !graph.error && graph.stats.blocks === 0;
  const assembling = !loaded && emptyFamily;

  /* 空态/加载态/错误态都要说人话：不暴露状态码，只讲现在能看到什么、可以做什么 */
  const body = graph.error
    ? h('div', { className: 'sg-state sg-state-err' },
        h('div', { className: 'sg-state-t' }, t('state.errorTitle')),
        h('div', { className: 'sg-state-d' },
          t('state.errorHelp')),
        h('div', { className: 'sg-state-code' },
          String((graph.error && graph.error.message) || graph.error)),
        h('button', { className: 'sg-btn sg-state-act', onClick: retry }, t('state.retry')))
    : assembling
      ? h('div', { className: 'sg-state sg-skel' },
          h('div', { className: 'sg-skel-line', style: { width: '46%' } }),
          h('div', { className: 'sg-skel-line', style: { width: '72%' } }),
          h('div', { className: 'sg-skel-line', style: { width: '58%' } }),
          h('div', { className: 'sg-state-d' }, t('state.assembling')))
      : emptyFamily
        ? h('div', { className: 'sg-state' },
            h('div', { className: 'sg-state-t' }, t('state.emptyTitle')),
            h('div', { className: 'sg-state-d' },
              t('state.emptyHelp')),
            typeof props.openView === 'function'
              ? h('button', {
                className: 'sg-btn sg-state-act',
                onClick: () => props.openView('transcript-view')
              }, t('state.goChat'))
              : null)
        : null;

  /* 刚建好的连线：就地弹出标签输入框（FR-9）。
     Enter 或失焦确认，Esc 取消；留空即无标签。 */
  const labelInput = linkDraft ? h('div', {
    className: 'sg-linkdraft',
    style: { left: Math.max(8, Math.min(linkDraft.x, (size.w || 900) - 240)), top: Math.max(8, linkDraft.y) }
  },
  h('input', {
    className: 'sg-linkdraft-in',
    autoFocus: true,
    maxLength: 120,
    placeholder: t('link.labelPlaceholder'),
    value: linkDraft.value,
    onChange: (e) => {
      const v = e.target.value;
      setLinkDraft((d) => (d ? { ...d, value: v } : d));
    },
    onKeyDown: (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { labelLink(linkDraft.id, linkDraft.value); setLinkDraft(null); }
      else if (e.key === 'Escape') { setLinkDraft(null); }
    },
    onBlur: () => { labelLink(linkDraft.id, linkDraft.value); setLinkDraft(null); }
  })) : null;

  /* 内容由宿主侧读取；读取失败时当前会话仍有骨架，只是没有问答文本 */
  const contentHint = (!routeOk && !graph.error && laid.nodes.length)
    ? h('div', { className: 'sg-hint sg-hint-warn' },
        t('hint.partialContent'))
    : null;

  /* 改动没存上：说清楚原因，但**不回滚**用户刚做的操作 */
  const saveHint = saveError
    ? h('div', { className: 'sg-hint sg-hint-warn' }, saveError + t('hint.saveFailedSuffix'))
    : null;

  /* 规模降级与慢布局都要**明说**，不能让用户以为功能坏了（NFR-1） */
  const scaleHint = (tier !== 'full' || slowLayout)
    ? h('div', { className: 'sg-hint sg-hint-warn' },
      [
        tier === 'dense' ? t('scale.dense') : null,
        tier === 'skeleton' ? t('scale.skeleton') : null,
        slowLayout ? t('scale.slowLayout') : null
      ].filter(Boolean).join('；'))
    : null;

  /* 选中项可能不是块（方向键会走到会话头、块也可能因折叠/骨架而没画出来）。
     那时若直接返回 null，右栏会**整片空白** —— 看着像界面坏了。
     统一退回空态说明，右侧永远有内容。 */
  const selectedNode = selected ? nodeMap.get(selected) : null;
  const selectedIsBlock = !!(selectedNode && selectedNode.kind === 'block');
  const detail = selectedEdge
    ? buildEdgeDetail()
    : (selectedIsBlock ? buildDetail() : h('div', { className: 'sg-emptybox' },
      t('side.empty', {
        sessions: fmtNum(graph.error ? 0 : graph.stats.sessions),
        blocks: fmtNum(graph.error ? 0 : graph.stats.blocks)
      }),
      h('br'), h('br'),
      t('side.emptyHint')));

  function buildEdgeDetail() {
    const e = edgeList.find((x) => x.id === selectedEdge);
    if (!e) return h('div', { className: 'sg-emptybox' }, t('link.gone'));
    const nameOf = (id) => {
      const n = nodeMap.get(id);
      if (!n) return id + t('link.missing');
      if (n.kind === 'header') return n.title;
      const b = n.block;
      return t('block.turnOf', { turn: b.turn, title: b.alias || clip(digest(b.prompt), 20) || b.sessionTitle });
    };
    return [
      h('div', { key: 'hd', className: 'sg-side-hd' },
        h('span', { className: 'sg-t' }, e.kind === 'reference' ? t('link.kindReference') : t('link.kindManual')),
        h('button', { className: 'sg-x', onClick: () => setSelectedEdge(null) }, '✕')),
      h('div', { key: 'meta', className: 'sg-side-meta' },
        h('div', { className: 'sg-lb' }, t('link.sectionTitle')),
        h('div', { className: 'sg-meta' },
          h('span', { className: 'sg-k' }, t('link.from')), h('span', { className: 'sg-v' }, nameOf(e.from)),
          h('span', { className: 'sg-k' }, t('link.to')), h('span', { className: 'sg-v' }, nameOf(e.to)),
          e.broken
            ? [h('span', { key: 'k', className: 'sg-k' }, t('link.status')),
              h('span', { key: 'v', className: 'sg-v' }, t('link.endpointGone'))]
            : null)),
      h('div', { key: 'acts', className: 'sg-side-acts' },
        h('button', {
          className: 'sg-act sg-danger',
          onClick: () => removeLink(e.id)
        }, t('link.delete'))),
      h('div', { key: 'bd', className: 'sg-side-bd' },
        h('div', { className: 'sg-sec' },
          h('div', { className: 'sg-lb' }, t('link.label')),
          h('input', {
            className: 'sg-linkdraft-in sg-wide',
            maxLength: 120,
            placeholder: t('link.noLabel'),
            /* 编辑期间只改草稿，回车/失焦才落盘：每敲一个字都写一次的话，
               撤销会变成"退回一个字符"，50 步历史也会被一次输入冲光。 */
            value: labelDraft && labelDraft.id === e.id ? labelDraft.value : (e.label || ''),
            onChange: (ev) => {
              const v = ev.target.value;
              setLabelDraft({ id: e.id, value: v });
            },
            onKeyDown: (ev) => {
              ev.stopPropagation();
              if (ev.key === 'Enter') { labelLink(e.id, labelDraft ? labelDraft.value : e.label || ''); setLabelDraft(null); }
              else if (ev.key === 'Escape') setLabelDraft(null);
            },
            onBlur: () => {
              labelLink(e.id, labelDraft && labelDraft.id === e.id ? labelDraft.value : (e.label || ''));
              setLabelDraft(null);
            }
          }),
          h('div', { className: 'sg-tx' }, t('link.labelHelp'))))
    ];
  }

  function buildDetail() {
    const n = nodeMap.get(selected);
    if (!n || n.kind !== 'block') return null;
    const b = n.block;
    const open = b.status === 'open';
    const total = graph.error ? 0 : graph.blocks.filter((x) => x.sessionId === b.sessionId).length;
    return [
      /* 固定区：头部 */
      h('div', { key: 'hd', className: 'sg-side-hd' },
        h('span', { className: 'sg-t' }, t('block.turn', { turn: b.turn })),
        h('span', { className: 'sg-s' }, b.sessionTitle),
        h('button', {
          className: 'sg-x',
          title: t('side.collapse'),
          onClick: () => setSideOpen(false)
        }, '»'),
        h('button', { className: 'sg-x', onClick: () => setSelected(null) }, '✕')),
      /* 固定区：元信息 —— 无论正文多长都看得见 */
      h('div', { key: 'meta', className: 'sg-side-meta' },
        renaming && renaming.id === b.id
          ? h('div', { className: 'sg-sec' },
            h('div', { className: 'sg-lb' }, t('act.renameTitle')),
            h('input', {
              className: 'sg-linkdraft-in sg-rename-in',
              autoFocus: true,
              maxLength: 120,
              placeholder: t('act.renamePlaceholder'),
              value: renaming.value,
              onChange: (ev) => {
                const v = ev.target.value;
                setRenaming((r) => (r ? { ...r, value: v } : r));
              },
              onKeyDown: (ev) => {
                ev.stopPropagation();
                if (ev.key === 'Enter') renameBlock(b.id, renaming.value);
                else if (ev.key === 'Escape') setRenaming(null);
              },
              onBlur: () => renameBlock(b.id, renaming.value)
            }),
            h('div', { className: 'sg-tx' }, t('act.renameHelp')))
          : null,
        h('div', { className: 'sg-lb' }, t('side.meta')),
        h('div', { className: 'sg-meta' },
          h('span', { className: 'sg-k' }, t('side.session')), h('span', { className: 'sg-v' }, b.sessionTitle),
          h('span', { className: 'sg-k' }, t('side.turn')), h('span', { className: 'sg-v' },
            total ? t('side.turnOfTotal', { turn: fmtNum(b.turn), total: fmtNum(total) }) : fmtNum(b.turn)),
          h('span', { className: 'sg-k' }, t('link.status')), h('span', { className: 'sg-v' },
            open ? t('side.statusOpen') : b.status === 'failed' ? t('side.statusFailed') : t('side.statusDone')),
          h('span', { className: 'sg-k' }, t('side.toolCalls')), h('span', { className: 'sg-v' }, String(b.toolCalls)),
          h('span', { className: 'sg-k' }, t('side.deliverables')), h('span', { className: 'sg-v' },
            b.deliverables ? String(b.deliverables) : '—'))),
      /* 固定区：操作 —— 越长的正文越不该把按钮顶出去 */
      h('div', { key: 'acts', className: 'sg-side-acts' },
        h('button', {
          className: 'sg-act sg-primary', disabled: open,
          title: open ? t('fork.turnOpen') : t('fork.hint'),
          onClick: () => doFork(b.sessionId, b.turn)
        }, t('fork.action')),
        h('button', {
          className: 'sg-act',
          onClick: () => setLinking({ from: b.id, mode: 'click' })
        }, t('act.connect')),
        h('button', {
          className: 'sg-act',
          onClick: () => locateInConversation(b)
        }, t('act.locate')),
        h('button', {
          className: 'sg-act',
          onClick: () => { void createRefSession(b); }
        }, t('act.newRef')),
        h('button', {
          className: 'sg-act',
          onClick: () => setRenaming({ id: b.id, value: alias[b.id] || '' })
        }, t('act.rename')),
        h('button', {
          className: 'sg-act',
          onClick: () => {
            const next = { ...hidden, [b.id]: !hidden[b.id] };
            remember();
            setHidden(next);
            /* 不要把「显示已隐藏」顺手打开：那会让"隐藏"看起来没生效。
               想看回来是另一个动作（工具条上的开关，FR-11）。 */
            persist({ hidden: next });
          }
        }, hidden[b.id] ? t('act.unhide') : t('act.hide')),
        h('button', {
          className: 'sg-act',
          onClick: () => openSession(b.sessionId)
        }, t('side.switch'))),
      /* 唯一滚动的区域：正文 */
      h('div', { key: 'bd', className: 'sg-side-bd' },
        h('div', { className: 'sg-sec' },
          h('div', { className: 'sg-lb' }, t('block.prompt')),
          b.prompt ? markdownBlock(b.prompt, 'q', mdLabels) : h('div', { className: 'sg-tx' }, t('block.notLoaded'))),
        h('div', { className: 'sg-sec' },
          h('div', { className: 'sg-lb' }, t('block.response')),
          b.response ? markdownBlock(b.response, 'a', mdLabels) : h('div', { className: 'sg-tx' }, t('block.notLoaded'))))
    ];
  }

  return h('div', { className: 'sg-root' },
    h('style', null, CSS),
    h('div', {
      className: 'sg-canvas-wrap' + (panning ? ' sg-panning' : '') + (linking ? ' sg-linking' : ''),
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
      edges,
      previewEdge),
      cell,
      edgeLabels),
      h('div', { className: 'sg-tools' },
        /* 详情面板收起后，这里是把它开回来的入口（与原生侧栏的展开一致） */
        (selected && !sideOpen)
          ? h('button', {
            className: 'sg-btn sg-on',
            title: t('side.expand'),
            onClick: () => setSideOpen(true)
          }, t('side.expand'))
          : null,
        h('button', { className: 'sg-btn', onClick: fit }, t('toolbar.fit')),
        h('button', {
          className: 'sg-btn' + (showHidden ? ' sg-on' : ''),
          onClick: () => setShowHidden(!showHidden)
        }, t('toolbar.showHidden')),
        h('button', {
          className: 'sg-btn' + (collapseOthers ? ' sg-on' : ''),
          onClick: () => setCollapseOthers(!collapseOthers)
        }, t('toolbar.collapseOthers')),
        h('button', { className: 'sg-btn', onClick: () => setExportOpen(true) }, t('toolbar.export')),
        h('button', {
          className: 'sg-btn',
          disabled: !canUndo,
          title: canUndo ? t('toolbar.undoTip') : t('toolbar.nothingToUndo'),
          onClick: undo
        }, t('toolbar.undo')),
        (!writable || incompatible)
          ? h('span', {
            className: 'sg-ro',
            title: incompatible
              ? t('ro.incompatibleTip')
              : t('ro.noStorage')
          }, incompatible ? t('ro.incompatible') : t('ro.readonly'))
          : null,
        h('span', { className: 'sg-zoom' }, Math.round(view.scale * 100) + '%')),
      /* 左下角的操作提示按用户要求去掉：它长期占着画布，而同样的信息在工具条与
         空态里都有。连线过程中的临时提示（linking）保留 —— 那是"正在做什么"的反馈，
         不是常驻说明。 */
      linking
        ? h('div', { className: 'sg-hint' },
          linking.mode === 'drag' ? t('hint.linkingDrag') : t('hint.linkingClick'))
        : null,
      contentHint,
      saveHint,
      scaleHint,
      cornerNote,
      labelInput,
      body),
    sideOpen ? h('aside', { className: 'sg-side' }, detail) : null,
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
    /* 跳过数必须来自**这次导出**那张图，而不是画布那张 ——
       画布可能开着「显示已隐藏」，那样提示条会说"没有跳过任何块"，
       可下载下来的文件里其实少了一批。 */
    let skipped = 0;
    try {
      const out = exportText(exportFmt, exportHidden);
      preview = out.content;
      filename = out.filename;
      skipped = out.hiddenSkipped || 0;
    } catch (e) {
      errorText = e && e.message ? e.message : String(e);
    }
    return h('div', { className: 'sg-mask', onClick: (e) => { if (e.target === e.currentTarget) setExportOpen(false); } },
      h('div', { className: 'sg-dlg' },
        h('div', { className: 'sg-dlg-hd' },
          h('span', { className: 'sg-t' }, t('export.title')),
          h('span', { className: 'sg-s' }, filename),
          h('button', { className: 'sg-x', onClick: () => setExportOpen(false) }, '✕')),
        h('div', { className: 'sg-dlg-bd' },
          h('div', { className: 'sg-row' },
            h('span', { className: 'sg-lb' }, t('export.format')),
            h('div', { className: 'sg-seg' },
              h('button', { 'aria-pressed': exportFmt === 'mm' ? 'true' : 'false', onClick: () => setExportFmt('mm') },
                'FreeMind .mm'),
              h('button', { 'aria-pressed': exportFmt === 'md' ? 'true' : 'false', onClick: () => setExportFmt('md') },
                'Markdown .md')),
            h('span', { className: 'sg-s' },
              exportFmt === 'mm' ? t('export.mmHint') : t('export.mdHint'))) ,
          h('div', { className: 'sg-row' },
            h('span', { className: 'sg-lb' }, t('export.scope')),
            h('label', { className: 'sg-chk' },
              h('input', {
                type: 'checkbox', checked: exportHidden,
                onChange: (e) => setExportHidden(!!e.target.checked)
              }), t('export.includeHidden')),
            skipped && !exportHidden
              ? h('span', { className: 'sg-s' }, t('export.hiddenNotExported', { n: fmtNum(skipped) }))
              : null),
          h('div', { className: 'sg-row' },
            h('span', { className: 'sg-lb' }, t('export.preview')),
            h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { className: 'sg-prev' }, preview))),
          errorText ? h('div', { className: 'sg-err' }, t('export.generateFailed', { msg: errorText })) : null),
        h('div', { className: 'sg-dlg-ft' },
          h('span', { className: 'sg-hi' },
            t('export.help')),
          h('button', {
            className: 'sg-bigbtn',
            onClick: () => {
              try {
                const out = exportText(exportFmt, exportHidden);
                if (navigator && navigator.clipboard) navigator.clipboard.writeText(out.content);
                say(t('export.copied'));
              } catch { say(t('export.copyFailed')); }
            }
          }, t('export.copy')),
          h('button', { className: 'sg-bigbtn sg-primary', onClick: doDownload }, t('export.download')))));
  }
}

/**
 * 视图组件的兜底外壳。
 *
 * 宿主用 `renderSlot("conversation.view", props, { only: viewId })` 把 active view
 * 挂进对话根里，**组件一抛错，整片视图区就是纯白**：既看不到原因，也分不清是插件坏了
 * 还是宿主坏了（标签是另一个纯 thunk，所以照常显示 —— 界面看起来"只是没内容"）。
 *
 * 这里包一层 try/catch，把白屏换成一张**写明错误的卡片**，同时打 console.error。
 * 钩子仍然在 GraphView 内部按固定顺序执行，外壳只是调用它，不改变钩子语义。
 */
function SafeGraphView(props) {
  try {
    return GraphView(props);
  } catch (error) {
    try { console.error('[session-graph] 视图渲染失败：', error); } catch { /* 控制台不可用 */ }
    return h('div', { className: 'sg-root' },
      h('style', null, CSS),
      h('div', { className: 'sg-state sg-state-err' },
        h('div', { className: 'sg-state-t' }, '会话图谱渲染失败'),
        h('div', { className: 'sg-state-d' }, '这是插件的兜底界面；把下面这段发给我即可定位：'),
        h('div', { className: 'sg-state-code' },
          String((error && (error.stack || error.message)) || error).slice(0, 1500))));
  }
}

/* ------------------------------------------------------------ 插件入口 */

function apply(ctx) {
  /* 把字典登记进宿主的本地化服务（NFR-3 第一条：文案经宿主服务提供）。
     注册要落在 effect 作用域里并随插件卸载回收（NFR-4），
     与宿主自己的做法一致。登记失败不影响渲染 —— 取值时还有本地字典兜底。 */
  try {
    if (ctx.locale && typeof ctx.locale.register === 'function') {
      const registerDicts = () => { ctx.locale.register(NS, flatten()); };
      if (typeof ctx.effect === 'function') ctx.effect(registerDicts, 'session-graph: dictionaries');
      else registerDicts();
    }
  } catch (error) { degrade('字典注册失败', error); }

  /* 视图数据层：只做纯折叠，不订阅会话事件、不轮询、不写 DOM */
  ctx.uiConversation.views.register({
    target: TARGET,    create: () => {
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
    /* 宿主会在模块作用域直接调用它（切会话时也会），绝不能依赖组件内的 t —— 见 viewLabel */
    label: () => viewLabel(ctx),
    inject: (sessionId) => {
      let target = null;
      try {
        target = ctx.uiConversation.binding(sessionId).target(TARGET);
      } catch {
        /* 会话暂时不可绑定：视图退化为空态，不抛到槽位渲染里 */
      }
      return { sessionId, ctx, target, sessions: ctx.sessions };
    }
  }, SafeGraphView));
}

/* 服务依赖。**只列真正必需、且产品自身的视图插件也依赖的服务**：
   多列一个名字，一旦它没出现，整个插件就会永远停在 pending；而客户端 runner 是
   `await fiber.await()` 等插件落定的，卡住的不只是本插件（见 README「immediately」那条）。
   所以 `workspaces`（api-workspace-controller 的服务）不进这张表 —— 只有引用式新建会话
   会用到它，那里已经退化成"取不到就说明原因"，属于可选能力，不配当启动前提。
   `locale` 则与产品视图插件一致地列上：标签、Markdown 标签与数字排版都走它。 */
return { inject: ['slots', 'sessions', 'uiSession', 'uiConversation', 'uiWorkspace', 'locale'], apply };
  }
});
