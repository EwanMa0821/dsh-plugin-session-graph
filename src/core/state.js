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
import { idToRef, refToId } from './model.js';

export const STATE_VERSION = 1;

/** NFR-1：超限就截断，避免一条癫狂的记录把界面拖死 */
export const LIMITS = {
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

export function emptyState(now = 0) {
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
export { idToRef, refToId };

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
export const STATE_MIGRATIONS = {
  /* 示例（首次真正升版本时删掉注释并补上）：
     1: (state) => ({ ...state, version: 2, 新增字段: [] }) */
};

/**
 * 把旧版本记录逐级迁移到当前版本。
 * @param {object} raw 外来记录
 * @returns {object|null} 迁移后的记录；链条不完整时返回 null
 */
export function migrateState(raw) {
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
export function sanitizeState(raw, now = 0) {
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
export function mergePatch(state, patch, now = 0) {
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
export function stateToClient(state) {
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
export function clientPatchToState(patch) {
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
export function sessionsInState(state) {
  const s = sanitizeState(state, 0);
  if (!s) return [];
  const ids = new Set();
  s.links.forEach((l) => { ids.add(l.from.sessionId); ids.add(l.to.sessionId); });
  s.hiddenBlocks.forEach((id) => { const r = idToRef(id); if (r) ids.add(r.sessionId); });
  Object.keys(s.alias).forEach((id) => { const r = idToRef(id); if (r) ids.add(r.sessionId); });
  s.collapsedSessions.forEach((id) => ids.add(id));
  return [...ids];
}
