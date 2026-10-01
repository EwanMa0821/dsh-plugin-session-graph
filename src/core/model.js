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

export const GRAPH_VERSION = 1;

/** 块 id。`sessionId:turn`，全流程唯一。 */
export const blockId = (sessionId, turn) => `${sessionId}:${turn}`;

/** 空子会话占位节点的 id（FR-8：子会话尚无自有轮次时的终点） */
export const emptyId = (sessionId) => `${sessionId}:empty`;

/**
 * 块 id ↔ 持久形态的 Ref（§5.2）。
 *
 * id 的约定归 model 管（`blockId` / `emptyId` 也在这里），
 * 所以解析也放这里 —— 持久层只是引用它，不该各写一份。
 */
export function idToRef(id) {
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
export function refToId(ref) {
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
export function sessionOfId(id) {
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
export const squash = (v) => str(v).replace(/\s+/g, ' ').trim();
/** 剥标记语言 + 压成单行。同样只用于标题、别名。 */
export const plain = (v) => squash(str(v).replace(/<[^>]*>/g, ''));

/**
 * 规整**正文**（提问、回答）。
 *
 * 关键在于**保留换行**：正文是 Markdown，表格、代码块、列表全靠换行成立。
 * 早先对正文也用了 squash，把所有换行折成空格，于是详情面板里退化成一大段
 * 裸露的 Markdown 源码，导出的表格也被压成了一行。
 */
export const tidy = (v) => str(v)
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
export function summarize(v) {
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
export function clip(v, n) {
  const s = squash(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * 子会话标题自增：源标题末尾括号数字 +1，半角与全角括号都支持（FR-6 / §3）。
 * 与产品既有「分支」动作的规则一致。
 */
export function increasedTitle(title) {
  const t = str(title);
  let m = /^(.*?)\s*\((\d+)\)$/.exec(t);
  if (m) return `${m[1]} (${Number(m[2]) + 1})`;
  m = /^(.*?)（(\d+)）$/.exec(t);
  if (m) return `${m[1]}（${Number(m[2]) + 1}）`;
  return `${t} (1)`;
}

/** 生成一个当前家族内不重名的子会话标题 */
export function uniqueTitle(title, existing) {
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
export function turnsFromTimeline(timeline) {
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
export function normalizeSessions(raw) {
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
export function familyOf(sessions, currentId) {
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
export function buildGraph(input) {
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
