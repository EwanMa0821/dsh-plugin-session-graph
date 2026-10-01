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

import { STATE_VERSION, STATE_MIGRATIONS, emptyState, sanitizeState, mergePatch } from '../core/state.js';

/** 迁移表里登记过的旧版本（升序）。领域声明的 compatibleVersions 由它推导。 */
const MIGRATED_FROM = Object.keys(STATE_MIGRATIONS).map(Number).sort((a, b) => a - b);

/**
 * 领域名。**必须是 `[a-z][a-z0-9_]*`，不能有连字符。**
 *
 * 宿主对领域名/表名有硬约束（`@deepseek-ai/dsh-storage` 的 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`），
 * 由后端在 `kv.open()` 里校验（json 后端：`validateDescriptor` → `malformed-medium`）。
 * 而 `storageDomain.open(spec)` 只按结构读 spec、**不调用** `defineDomain`，
 * 所以名字写错不会在加载时炸，只会在打开存储时静默失败 —— 界面表现为"永远只读"。
 *
 * 这里原本叫 `session-graph`（带连字符），于是持久化从未生效过：
 * open 抛错 → `openStore` 返回 null → 每次写入都 503、每次读取都 `writable:false`。
 * 改名后记录布局不变（仍是 per-record，键仍是家族根会话 id），只是单元目录名变了。
 */
export const DOMAIN_NAME = 'session_graph';
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
  /* 声明"本版本还能读哪些旧版本的记录"。storageDomain 只按声明放行，
     真正的逐级迁移在 core/state.js 的 migrateState 里做。
     这里**跟着迁移表自动走**：没登记迁移时不下发这个键（行为与今天完全一致），
     一旦升版本并补了迁移，旧领域的记录就仍然打得开，而不是整片只读。 */
  ...(MIGRATED_FROM.length ? { compatibleVersions: MIGRATED_FROM } : {}),
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

  /* 每个家族一条写入链。
     write 是"读-改-写"：先读当前记录，合并补丁，再写回。两个请求并发时
     后一个会拿着**读到的旧状态**覆盖前一个 —— 实测两次 POST 同时到达时，
     先写的 hiddenBlocks 被整片抹掉（只剩后写的 alias）。
     客户端的串行化只能管住自己那一份，Host 侧必须自己排队。 */
  const chains = new Map();
  const enqueue = (key, job) => {
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.then(job, job);
    /* 链上只保留"已结算"的位置：前一个失败不影响后一个继续排队 */
    chains.set(key, run.then(() => {}, () => {}));
    return run;
  };

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
      return enqueue(key, async () => {
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
      });
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
 *
 * @param {object} storageDomain `ctx.storageDomain`
 * @param {() => number} [now]
 * @param {(error: any) => void} [onError] 可选上报口。降级是设计的一部分，
 *        但**失败原因不能一起消失** —— 只读却查不出为什么，正是上一版踩过的坑。
 */
export async function openStore(storageDomain, now, onError) {
  if (!storageDomain || typeof storageDomain.open !== 'function') return null;
  try {
    const domain = await storageDomain.open(DOMAIN_SPEC);
    return createStore(domain, now);
  } catch (error) {
    if (typeof onError === 'function') {
      try { onError(error); } catch { /* 上报失败不影响降级 */ }
    }
    return null;
  }
}
