/**
 * 会话图谱 · Host 持久化
 *
 * 载体是宿主的领域数据形式（`ctx.storageDomain`）：经过 schema 校验、
 * 每次写入都达到持久状态、并按序发出 `domain/changed` 的 KV 领域。
 *
 * 两条刻意的设计：
 *
 * 1. **spec 是字面对象，不 import 任何包。**
 *    `defineDomain` / `domainTable` 都只是恒等校验器，而 `open(spec)` 按结构读取字段、
 *    不做品牌校验。所以自己写出合法 spec 即可 —— 少一个 import 就少一条
 *    "模块加载失败 → 整半不挂载 → 路由 404"的静默失效路径。
 *
 * 2. **记录 schema 只做结构校验，不管版本。**
 *    版本判断交给 `sanitizeState`，未知版本由 `read` 报"不兼容"并**拒绝写入**，
 *    而不是让 open 失败或把用户的记录挪走。需求 §5.3 明确要求不猜测性解析。
 */

import { STATE_VERSION, emptyState, sanitizeState, mergePatch } from '../core/state.js';

export const DOMAIN_NAME = 'session-graph';
export const TABLE_NAME = 'families';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 结构校验；返回错误说明或 null */
function checkRecord(value) {
  if (!isObject(value)) return '记录必须是对象';
  if (!Number.isFinite(Number(value.version))) return '记录缺少数字 version';
  for (const key of ['links', 'hiddenBlocks', 'collapsedSessions']) {
    if (value[key] !== undefined && !Array.isArray(value[key])) return `${key} 必须是数组`;
  }
  for (const key of ['positions', 'alias']) {
    if (value[key] !== undefined && !isObject(value[key])) return `${key} 必须是对象`;
  }
  if (value.viewport !== undefined && value.viewport !== null && !isObject(value.viewport)) {
    return 'viewport 必须是对象或 null';
  }
  return null;
}

/**
 * 手写 schema。
 *
 * `storageDomain` 对 schema 只要求 `parse` 与 `safeParse` 两个方法，
 * 不必为了它把 zod 引进来 —— 这也是本插件能保持零运行时依赖的原因。
 */
export const familyRecordSchema = {
  parse(value) {
    const problem = checkRecord(value);
    if (problem) throw new Error(`非法记录：${problem}`);
    return value;
  },
  safeParse(value) {
    try {
      return { success: true, data: this.parse(value) };
    } catch (error) {
      return { success: false, error };
    }
  }
};

/** 领域声明：一族会话一条记录，键是家族根会话 id */
export const DOMAIN_SPEC = {
  name: DOMAIN_NAME,
  version: STATE_VERSION,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { [TABLE_NAME]: { valueSchema: familyRecordSchema } }
};

/**
 * 把打开的领域句柄包成图谱存储。
 *
 * @param {{table: (name: string) => object, close: () => Promise<void>}} domain
 * @param {() => number} now
 */
export function createStore(domain, now = () => Date.now()) {
  const table = () => domain.table(TABLE_NAME);

  return {
    /** 该族是否可写（记录版本不认识时为 false） */
    async read(familyId) {
      const key = String(familyId || '');
      if (key === '') return { state: null, incompatible: false, writable: true };
      let raw;
      try {
        raw = table().get(key);
      } catch {
        return { state: null, incompatible: false, writable: false };
      }
      if (raw === undefined) return { state: null, incompatible: false, writable: true };
      const state = sanitizeState(raw, now());
      /* 版本不认识：不猜测性解析，也**绝不用新状态覆盖它** */
      if (state === null) return { state: null, incompatible: true, writable: false };
      return { state, incompatible: false, writable: true };
    },

    async write(familyId, patch) {
      const key = String(familyId || '');
      if (key === '') throw new Error('缺少家族根会话 id');
      const current = await this.read(key);
      if (current.incompatible) {
        throw Object.assign(new Error('这条记录由更新的版本写入，本版本不会覆盖它'), {
          code: 'incompatible-version'
        });
      }
      const before = current.state || emptyState(now());
      const next = mergePatch(before, patch, now());
      await table().put(key, next);
      return next;
    },

    async remove(familyId) {
      const key = String(familyId || '');
      if (key === '') return false;
      try {
        return await table().delete(key);
      } catch {
        return false;
      }
    },

    close() {
      try {
        return domain.close();
      } catch {
        return Promise.resolve();
      }
    }
  };
}

/**
 * 打开存储；任何一步失败都只返回 null，绝不抛到调用方。
 *
 * §5.3：存储域不可用时图谱退化为**只读模式** —— 能看、能分叉，只是不能保存。
 */
export async function openStore(storageDomain, now) {
  if (!storageDomain || typeof storageDomain.open !== 'function') return null;
  try {
    const domain = await storageDomain.open(DOMAIN_SPEC);
    return createStore(domain, now);
  } catch {
    return null;
  }
}
