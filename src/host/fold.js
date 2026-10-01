/**
 * 会话图谱 · Host 侧折叠
 *
 * 纯函数：把会话事件流折成轮次记录，并从「继承事件数」反推分叉源轮次。
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
/** 只压空白，**不**剥尖括号 —— 提问与回答里出现 <div> 这类代码是常态 */
const squash = (v) => str(v).replace(/\s+/g, ' ').trim();

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
  if (typeof payload === 'string') return squash(payload);
  if (typeof payload !== 'object') return '';

  const direct = payload.text ?? payload.prompt ?? payload.content;
  if (typeof direct === 'string') return squash(direct);

  const blocks = Array.isArray(direct) ? direct
    : Array.isArray(payload.message && payload.message.content) ? payload.message.content
      : Array.isArray(payload.blocks) ? payload.blocks
        : null;
  if (blocks) {
    return squash(blocks.map((b) => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      /* 只认文本块：图片、工具调用块没有可读文本 */
      if (b.type !== undefined && b.type !== 'text') return '';
      return str(b.text ?? b.value ?? b.content ?? '');
    }).join(' '));
  }
  if (payload.message && typeof payload.message === 'object') return textOf(payload.message);
  return '';
}

/**
 * 事件流 → 轮次记录。
 *
 * 轮次边界用 `turn/start` 与 `turn/end`；
 * 提问取该轮首条人类消息，回答取该轮最后一条带文本的助手消息（与轮次大纲一致）。
 * 没有 `turn/end` 的轮次保持 `open`，`endSeq` 为 null —— 它不可分叉。
 *
 * @param {Array<object>} events 按 seq 升序的会话事件
 * @returns {Array<object>} 轮次记录
 */
export function foldTurns(events) {
  const turns = [];
  let cur = null;

  /* endSeq 为 null 表示这一轮没有被 turn/end 闭合。
     绝不能用「最后一个事件序号」充数——那会伪造出一个分叉边界。 */
  const flush = (endSeq) => {
    if (!cur) return;
    cur.endSeq = numOrNull(endSeq);
    cur.status = cur.endSeq === null ? 'open' : 'done';
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

export { squash as squashText };
