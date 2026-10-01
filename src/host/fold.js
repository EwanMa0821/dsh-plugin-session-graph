/**
 * 会话图谱 · Host 侧折叠
 *
 * 纯函数：把会话事件流折成轮次记录，标出分叉带过来的**继承前缀**，
 * 并从「继承事件数」反推分叉源轮次。
 * 事件载荷的确切形状未经运行时核实（见 README「验证边界」），
 * 因此这里一律**防御性读取**：字段缺失就不填，绝不抛错。
 */

const str = (v) => (v === undefined || v === null ? '' : String(v));
/* 注意 Number(null) === 0：显式的 null/undefined/空串必须判成"没有值"，
   否则"这一轮没有结束边界"会被读成"在 0 号事件结束"，进而伪造出可分叉的边界。 */
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/**
 * 规整正文：**保留换行**。正文是 Markdown，表格、代码块、列表全靠换行成立。
 * 也不剥尖括号 —— 提问与回答里出现 `<div>` 这类代码是常态。
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
 * 该条 `user/message` 是否由人类发起。
 *
 * 权威判定来自 `@deepseek-ai/dsh-session-turn-outline`：
 *     if (event.data.source.kind !== "user") return state;
 * 也就是 `source` 是一个**带 kind 的对象**，不是字符串。
 * 早先这里对对象做 `String(...)`，得到 "[object Object]"，于是一条提问都取不到。
 */
export function isHumanTurn(payload) {
  if (!payload || typeof payload !== 'object') return true;
  const src = payload.source ?? payload.origin ?? payload.role ?? payload.author;
  if (src === undefined || src === null) return true;

  const word = (v) => {
    const s = str(v).trim().toLowerCase();
    return s === 'user' || s === 'human';
  };
  if (typeof src === 'object') {
    const kind = src.kind ?? src.type ?? src.role ?? src.name;
    /* 对象里没有可判定的字段时保持宽容：宁可多取一条提问，也不要全空 */
    return kind === undefined || kind === null ? true : word(kind);
  }
  return word(src);
}

/** 从各种可能的载荷形状里取出一段可读文本 */
export function textOf(payload) {
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'string') return tidy(payload);
  if (typeof payload !== 'object') return '';

  const direct = payload.text ?? payload.prompt ?? payload.content;
  if (typeof direct === 'string') return tidy(direct);

  const blocks = Array.isArray(direct) ? direct
    : Array.isArray(payload.message && payload.message.content) ? payload.message.content
      : Array.isArray(payload.blocks) ? payload.blocks
        : null;
  if (blocks) {
    /* 文本块之间留空行：它们本来就是不同段落，压成一行会毁掉 Markdown 结构 */
    return tidy(blocks.map((b) => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      /* 只认文本块：图片、工具调用块没有可读文本 */
      if (b.type !== undefined && b.type !== 'text') return '';
      return str(b.text ?? b.value ?? b.content ?? '');
    }).filter(Boolean).join('\n\n'));
  }
  if (payload.message && typeof payload.message === 'object') return textOf(payload.message);
  return '';
}

/**
 * 继承前缀的收尾序号（FR-8）。
 *
 * 分叉时 DSH 把父会话的事件前缀**真的写进子会话日志**，继承部分结束时补一条
 * `session/end-seed`（形状见 `test/fixtures/session-shapes.json`：`{type, seq, time, data}`，
 * `data` 是空对象 —— 边界只能读 `seq`）。这条事件就是"自有内容从这里开始"的权威边界。
 *
 * **前提：这条会话自己是被播种出来的（`isSeeded`）。** 同一条事件在**源会话**的日志里
 * 也会出现 —— 那是"我从这里被复制走"的切点，源会话自己并没有继承任何内容。
 * 把两者混为一谈，源会话自己的轮次就会被判成继承的、整轮从图里消失，而现象与
 * "这个会话本来就空"一模一样（实测踩到过：分叉之后，**父会话整轮不见了**）。
 * 所以 `isSeeded` 不是 true 时**一律不判**。
 *
 * `inheritedEventCount` 是另一条线索（header 里有、日志里没有时用它兜底）：它是继承的
 * **事件条数**，所以闭区间切点 = 条数 − 1，与 `forkTurnFromChild` 同一口径。
 * 两条线索都没有时返回 null —— 判不出来就**不标**，不能凭空把用户的轮次当成继承的。
 *
 * 一条会话里出现多条 `session/end-seed` 时取**最早**那条：后面那些（它自己后来又被
 * 分叉出去时留下的）不影响它继承前缀的长度。
 *
 * @param {Array<object>} events 按 seq 升序的会话事件
 * @param {{inheritedEventCount?: number|null, isSeeded?: boolean}} [options]
 * @returns {number|null} 继承前缀的最后一个序号；判不出来时为 null
 */
export function seedBoundaryOf(events, options) {
  const o = options || {};
  if (o.isSeeded !== true) return null;

  let seq = null;
  (events || []).forEach((ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (str(ev.type) !== 'session/end-seed') return;
    const s = numOrNull(ev.seq);
    if (s !== null && (seq === null || s < seq)) seq = s;
  });
  if (seq !== null) return seq;

  const count = numOrNull(o.inheritedEventCount);
  return count === null || count <= 0 ? null : count - 1;
}

/** 这一轮是否落在继承前缀里：按起点判，起点缺失时退到终点 */
const isInheritedTurn = (turn, boundary) => {
  if (boundary === null) return false;
  const start = numOrNull(turn.startSeq);
  if (start !== null) return start <= boundary;
  const end = numOrNull(turn.endSeq);
  return end !== null && end <= boundary;
};

/**
 * 事件流 → 轮次记录。
 *
 * 轮次边界用 `turn/start` 与 `turn/end`；
 * 提问取该轮首条人类消息，回答取该轮最后一条带文本的助手消息（与轮次大纲一致）。
 * 没有 `turn/end` 的轮次保持 `open`，`endSeq` 为 null —— 它不可分叉。
 *
 * 继承前缀里的轮次（分叉带过来的父会话历史）由 `session/end-seed` /
 * `inheritedEventCount` 判出，并**一律标上布尔值**（继承 `true`、自有 `false`）：
 * 它们在源会话里已经有一份块，图谱不再画第二遍（FR-8）。判不出边界时一个字段都不写，
 * 下游据此知道"这份数据没判过"，不会拿它当权威结论。
 * 注意**只有自己被播种出来的会话**才判（见 `seedBoundaryOf`）。
 *
 * @param {Array<object>} events 按 seq 升序的会话事件
 * @param {{inheritedEventCount?: number|null, isSeeded?: boolean}} [options]
 * @returns {Array<object>} 轮次记录
 */
export function foldTurns(events, options) {
  const turns = [];
  const boundary = seedBoundaryOf(events, options);
  let cur = null;

  /* endSeq 为 null 表示这一轮没有被 turn/end 闭合。
     绝不能用「最后一个事件序号」充数——那会伪造出一个分叉边界。 */
  const flush = (endSeq) => {
    if (!cur) return;
    cur.endSeq = numOrNull(endSeq);
    cur.status = cur.endSeq === null ? 'open' : 'done';
    /* 有边界就把话**说全**：继承的标 true，自有的标 false。
       只标 true 的话，下游拿到"没有标记"就分不清"这是自有轮次"还是
       "这份数据根本没判过边界" —— 于是只好再按序号猜一遍，两套判据一旦不一致
       （header 里的条数与日志里的 seed 事件对不上时就会），自有的轮次会被误藏。
       `false` 就是"宿主已经判过，它是自有的"。 */
    if (boundary !== null) cur.inherited = isInheritedTurn(cur, boundary);
    turns.push(cur);
    cur = null;
  };

  (events || []).forEach((ev) => {
    if (!ev || typeof ev !== 'object') return;
    const type = str(ev.type);
    const seq = numOrNull(ev.seq);
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {};

    if (type === 'turn/start') {
      flush(null);                           /* 上一轮缺 turn/end：按未闭合收尾 */
      cur = {
        turn: Number.isFinite(Number(data.turn)) ? Number(data.turn) : turns.length + 1,
        startSeq: seq,
        endSeq: null,
        prompt: '',
        response: '',
        status: 'open',
        toolCalls: 0,
        deliverables: 0
      };
      return;
    }
    if (!cur) return;

    if (type === 'user/message') {
      if (!cur.prompt && isHumanTurn(data)) cur.prompt = textOf(data);
      return;
    }
    if (type === 'assistant/message') {
      const t = textOf(data);
      if (t) cur.response = t;
      return;
    }
    if (type === 'tool/call') { cur.toolCalls += 1; return; }
    /* 交付物：宿主的已知事件类型表里就有 `deliverables/presented`
       （`@deepseek-ai/dsh-session` 的 KNOWN_SESSION_EVENT_TYPES），
       载荷形状照 `@deepseek-ai/dsh-client-ui-deliverables` 的 isPresentedData 是
       `{ turn, callId, files }` —— **没有**标量计数字段，所以和 tool/call 一样
       按"一条事件算一次交付"累加。以前这里只在轮次初始化时写过 0、从不累加，
       界面上的 ⧉ 徽标与「N 个交付物」因此恒为空。
       不去猜 files.length 之类的字段：猜错就是重新变回恒为 0。 */
    if (type === 'deliverables/presented') { cur.deliverables += 1; return; }
    if (type === 'turn/end') { flush(seq); }
  });

  flush(null);                               /* 末尾未闭合的轮次同样保持 open */
  return turns;
}

/**
 * 由「继承事件数」反推分叉源轮次（FR-8）。
 *
 * 子会话 header 的 `parentSession` 给出父会话，`inheritedEventCount` 是继承前缀的事件条数；
 * 分叉时的闭区间切点就是它减一。找出父会话中 `endSeq` 等于该切点的那一轮即可。
 *
 * @returns {number|null} 分叉源轮次号；对不上时返回 null（派生边会退回会话头）
 */
export function forkTurnFromChild(parentTurns, inheritedEventCount) {
  const count = numOrNull(inheritedEventCount);
  if (count === null || count <= 0) return null;
  const boundary = count - 1;
  const hit = (parentTurns || []).find((t) => numOrNull(t.endSeq) === boundary);
  return hit ? hit.turn : null;
}

/**
 * 把会话列表 + 各自的轮次组装成 buildGraph 需要的输入，
 * 并顺手补上由 inheritedEventCount 推导出来的 forkAtTurn。
 *
 * @param {Array<{id,title,parentId,inheritedEventCount}>} sessions
 * @param {Record<string, object[]>} turnsBySession
 */
export function linkForks(sessions, turnsBySession) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return sessions.map((s) => {
    if (s.forkAtTurn !== null && s.forkAtTurn !== undefined) return s;
    if (!s.parentId || !byId.has(s.parentId)) return s;
    const parentTurns = turnsBySession[s.parentId] || [];
    const turn = forkTurnFromChild(parentTurns, s.inheritedEventCount);
    return turn === null ? s : { ...s, forkAtTurn: turn };
  });
}

export { tidy as tidyText };
