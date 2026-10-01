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
export const TIERS = {
  dense: 800,
  skeleton: 3000
};

/** 布局超过这个毫秒数就回落简化布局并提示（NFR-1） */
export const SLOW_LAYOUT_MS = 300;

/**
 * 按块数选档。
 * @param {number} blockCount
 * @returns {'full'|'dense'|'skeleton'}
 */
export function tierOf(blockCount) {
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
export function tierFeatures(tier) {
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
export function sessionsWithBlocks(sessions, tier, currentId, expanded) {
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
export function timedLayout(run, now) {
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
