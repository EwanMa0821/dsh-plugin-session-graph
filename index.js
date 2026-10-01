/**
 * 会话图谱 · Host 侧
 *
 * 只做一件事：贡献一个 Fetch 路由，让浏览器把「家族数据」与「导出文件」取走。
 * 通道照搬产品既有的会话日志导出实现（见 README「实现说明」）：
 *   - GET  返回完整响应
 *   - HEAD 取消响应体，只回状态与响应头（浏览器用它做下载预检）
 *   - 参数非法 → 400；依赖服务缺失 → 503
 *
 * 本文件只依赖 src/ 下的纯逻辑，不 import 任何 @deepseek-ai/* 包，
 * 因此首装不需要任何依赖与构建脚本。
 */

import { normalizeSessions, buildGraph, clip, familyOf, sessionOfId } from './src/core/model.js';
import { render } from './src/core/export.js';
import { stateToClient, LIMITS } from './src/core/state.js';
import { foldTurns, linkForks } from './src/host/fold.js';
import { openStore, findOrphanRecords, DOMAIN_NAME } from './src/host/store.js';

export const name = 'dsh-plugin-session-graph';

/* 故意**不**在插件级声明 inject：
   如果这里声明 ['connection'] 而该服务没能出现，整个插件会永远停在 pending，
   模块不会被加载、路由也不会注册，浏览器侧只能看到一个 404，完全无从判断。
   改成 apply 里用 ctx.inject([...], cb) 等它——插件本体先挂载，服务到位再注册路由。 */

const ROUTE = '/api/session.graph-export';
const FORMATS = new Set(['json', 'mm', 'md']);

/* ------------------------------------------------------------ 服务取用 */

/** 与产品自身一致：优先用 ctx.get(name)，再退回属性访问 */
function service(ctx, key) {
  if (!ctx) return undefined;
  if (typeof ctx.get === 'function') {
    try {
      const v = ctx.get(key);
      if (v !== undefined) return v;
    } catch { /* 该服务尚未挂载 */ }
  }
  return ctx[key];
}

function text(body, status) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  });
}

/* --------------------------------------------------------- 数据读取 */

/**
 * 读取会话列表的**元信息**，不碰事件流。
 *
 * 会话元信息优先取 header（`parentSession` / `inheritedEventCount` 都在那里）。
 * 标题这里只留 header 里的旧值，真正的标题由 resolveTitles 单独折叠 ——
 * 宿主 header 里**没有** title 字段（见那里的注释）。
 *
 * 超过会话数上限抛 **400**：`sessions=` 是客户端可控输入，属于"请求不合法"，
 * 不是"服务不可用"。原先这个 Error 没有 .status，被 respondRead 兜成 503，
 * 于是一个纯粹的输入错误被说成了服务错误，浏览器侧还会照着 5xx 去重试/报障。
 */
export async function readSessionMeta(ctx, ids, limits) {
  const store = service(ctx, 'sessions');
  const live = store && typeof store.list === 'function' ? (store.list() || []) : [];

  const raw = [];
  live.forEach((s) => {
    const header = (s && s.header) || {};
    const id = String(header.id ?? (s && s.id) ?? '');
    if (!id) return;
    raw.push({
      id,
      title: String(header.title ?? (s && s.title) ?? id),
      /* 血缘字段两种形状都认：真正挂上来的会话给的是 `header.parentSession`，
         而会话列表项（summary）给的是 `parentId` —— 只认前者会让整棵血缘在 Host 侧断掉。 */
      parentId: header.parentSession ?? header.parentSessionId
        ?? (s && s.parentId) ?? (s && s.parentSessionId) ?? null,
      inheritedEventCount: header.inheritedEventCount ?? (s && s.inheritedEventCount) ?? null,
      /* 自己是不是被播种出来的（分叉出来的会话）。**必须带着它**：源会话日志里也有
         `session/end-seed`（标出它被分叉的切点），而源会话自己没有继承任何内容 ——
         分不清这两者，源会话的轮次就会被误判成继承的、整轮从图上消失。 */
      isSeeded: header.isSeeded === true || (s && s.isSeeded === true),
      /* 冷会话不在 list() 里；调用方可通过 ids 显式点名 */
      session: s
    });
  });

  /* 客户端用 ids 补齐它目录里有、但当前不活跃的会话 */
  const known = new Set(raw.map((r) => r.id));
  (ids || []).forEach((id) => {
    if (!id || known.has(id)) return;
    known.add(id);
    raw.push({ id, title: id, parentId: null, inheritedEventCount: null, isSeeded: false, session: null });
  });

  if (limits && limits.maxSessions && raw.length > limits.maxSessions) {
    throw Object.assign(new Error(`会话数超过上限 ${limits.maxSessions}`), { status: 400 });
  }

  return raw;
}

/**
 * 哪些会话需要读事件流（NFR-2 的取数预算）。
 *
 * 修复前 `sessions.list()` 里每个会话都 observeSession 一遍：40 会话 × 50 轮时，
 * 连"点一个骨架块载入一轮"这种只要当前家族的请求也会打开 40 个观察句柄、
 * 回传 2000 条轮次明细（约 1.8 MB）—— 载入一个块却付了整库的代价。
 * 范围收紧成三块，其余会话**一个事件都不读**：
 *   1. 当前会话的家族（祖先 + 家族根的全部后代）—— 血缘、派生边与家族判定全靠它
 *   2. 调用方 `sessions=` 显式点名的会话 —— 冷会话（不在 list() 里）靠它补进来
 *   3. 被**引用连线**拉进来的会话 —— buildGraph 会把它们并进 scoped，
 *      不读轮次它们就成了"断裂的引用"，FR-7 的节点会直接消失
 *
 * 家族外的会话仍然留在元信息列表里：familyOf 判定根、孤儿与血环看的是整张列表，
 * 把它们剔掉会改变 notes 与家族根，等于用性能换了错的图。
 *
 * 范围只用 header 的 parentId 就能算（familyOf 是纯函数，这里只读不改），
 * 所以能在读事件**之前**定下来。没给 currentId（旧调用方）时范围就是全部，
 * 与修复前行为一致。
 *
 * @param {Array<object>} records readSessionMeta 的结果
 * @param {{currentId?: string, named?: string[], links?: Array<object>}} [options]
 * @returns {Set<string>}
 */
export function turnScopeOf(records, options) {
  const list = Array.isArray(records) ? records : [];
  const o = options || {};
  const all = new Set(list.map((r) => r.id));
  const currentId = o.currentId === undefined || o.currentId === null ? '' : String(o.currentId);
  if (!currentId || !all.has(currentId)) return all;

  const scope = new Set(familyOf(list, currentId).order);
  (o.named || []).forEach((id) => { if (all.has(id)) scope.add(id); });
  /* 连线在路由里统一是**客户端形态**（端点字符串 `sid:turn` / `header:sid`），
     所以这里和 buildGraph 用同一个 sessionOfId 取终点会话。 */
  (o.links || []).forEach((l) => {
    if (!l || l.kind !== 'reference') return;
    const target = sessionOfId(l.to);
    if (all.has(target)) scope.add(target);
  });
  return scope;
}

/**
 * 逐会话折叠标题，失败只回落、不打断整次取数。
 *
 * 宿主事实（`@deepseek-ai/dsh-session-query/lib/index.js` 的 readTitle）：
 * 会话 header 里**没有** title 字段，标题是 `session/title` 日志事件折出来的，
 * readTitle 是它唯一的入口（"latest title snapshot, or `undefined` when the log
 * has no title event"），源解析不了或日志读不动时它会**抛**。
 * 所以：
 *   - 有 readTitle → 只用它的返回值；返回空或抛错都回落会话 id
 *     （真实宿主上 header.title 恒为 undefined，旧的回落链其实等价于 id）
 *   - 没有 readTitle（旧宿主或替身）→ 保留修复前的 header.title 回落链，行为不变
 *
 * 只给**会出现在家族数据里**的会话折标题（家族 + 点名 + 被引用拉进来的）：
 * 家族外又没被点名的会话在 buildGraph 里会被过滤掉，为它们各折一次标题
 * 等于把刚省下来的事件读取又做一遍，上面那份取数预算就白省了。
 * readTitle 本身**不开观察句柄**（readTitle → readTitleSnapshot → corpus.projectMany，
 * 全程只是对内存快照做同步折叠），所以这里也不会多出一堆待释放的句柄。
 *
 * @param {object} query sessionQuery 服务
 * @param {Array<object>} records readSessionMeta 的结果（就地改 title）
 * @param {Set<string>} [scopeIds] 需要标题的会话；为空表示全部
 */
export async function resolveTitles(query, records, scopeIds) {
  const list = Array.isArray(records) ? records : [];
  if (!query || typeof query.readTitle !== 'function') return list;
  for (const r of list) {
    if (scopeIds && !scopeIds.has(r.id)) continue;
    try {
      const raw = await query.readTitle(r.id);
      /* 本版宿主返回的是折叠好的**标题字符串**
         （dsh-session-query/lib/index.js：`return (await this.readTitleSnapshot(...)).title`），
         而 api-catalog 把签名写成了 `Promise<SessionTitleSnapshot | undefined>`。
         两种形状都认：字符串直接用，对象取它的 title。取不到就回落 id ——
         无论如何都不能把 "[object Object]" 当成标题写进导出文件。 */
      const text = typeof raw === 'string' ? raw.trim()
        : (raw && typeof raw === 'object' && typeof raw.title === 'string' ? raw.title.trim() : '');
      r.title = text === '' ? r.id : text;
    } catch {
      /* 标题只是锦上添花：读不到就用会话 id，绝不让整次取数失败 */
      r.title = r.id;
    }
  }
  return list;
}

/**
 * 按范围读各会话的事件流并折成轮次。
 *
 * 串行读取：observeSession 会打开一个观察句柄，并发打开没有好处。
 * 范围外的会话**连键都不建** —— 有了键，下游就会把"从没读过"当成"读过了、只是没内容"。
 *
 * @param {Map<string, string>} [unread] 收集"没读到轮次"的会话 id → 原因
 */
export async function readTurnsBySession(query, records, scopeIds, unread) {
  const out = {};
  for (const r of (Array.isArray(records) ? records : [])) {
    if (scopeIds && !scopeIds.has(r.id)) continue;
    out[r.id] = await readTurns(query, r, unread);
  }
  return out;
}

/** 元信息 + 轮次 → buildGraph 的输入（补上由 inheritedEventCount 推导的 forkAtTurn） */
function assembleSessions(raw, turnsBySession) {
  const byId = new Map(raw.map((r) => [r.id, r]));
  return linkForks(
    normalizeSessions(raw.map((r) => ({
      id: r.id, title: r.title, parentId: r.parentId, sessionId: r.id
    }))).map((s) => {
      const src = byId.get(s.id);
      return { ...s, inheritedEventCount: src ? src.inheritedEventCount : null };
    }),
    turnsBySession
  );
}

/**
 * 读取一组会话的元信息与轮次（整体读取）。
 *
 * 不带 options 时与修复前一致：列表里的会话全读。buildPayload 走的是分步调用 ——
 * 它必须先用元信息算出家族根、读完存档拿到连线，才能确定要读哪些会话的轮次。
 *
 * @param {object} ctx
 * @param {string[]} ids 调用方显式点名的会话
 * @param {object} limits
 * @param {{currentId?: string, named?: string[], links?: Array<object>}|string} [options]
 */
export async function readSessions(ctx, ids, limits, options) {
  const opts = typeof options === 'string' ? { currentId: options } : (options || {});
  const raw = await readSessionMeta(ctx, ids, limits);
  const scope = turnScopeOf(raw, { ...opts, named: opts.named || ids });
  const query = service(ctx, 'sessionQuery');
  await resolveTitles(query, raw, scope);
  const turnsBySession = await readTurnsBySession(query, raw, scope);
  return { sessions: assembleSessions(raw, turnsBySession), turnsBySession };
}

/**
 * 读一个会话的事件流并折成轮次。
 *
 * `sessionQuery.observeSession()` 是**异步**的，返回一个可释放的观察句柄
 * （产品自身的会话日志导出就是 `await` 它、读 `.events`、再释放）。
 * 这里必须 await，否则拿到的是 Promise，`.events` 恒为 undefined，
 * 结果就是"路由 200 但每个会话 0 轮"。
 *
 * `rec.inheritedEventCount` 一并交给折叠：子会话日志里的继承前缀（分叉带过来的
 * 父会话历史）要按它/按 `session/end-seed` 标出来，图谱才不会把继承的内容
 * 在子会话里重复画一遍（FR-8）。
 *
 * **读不到 ≠ 没有轮次。** 拿不到句柄、或句柄形状不对时，以前这里静默返回空数组，
 * 界面上那一格就变成「空子会话 · 尚未提问」—— 用户看到的是"我那一轮对话丢了"，
 * 而排查时一条线索都没有。现在把**原因**一起记进 `unread`，由上层回传给界面说明。
 *
 * @param {object} query sessionQuery 服务
 * @param {object} rec readSessionMeta 的记录
 * @param {Map<string, string>} [unread] 收集"没读到轮次"的会话 id → 原因
 */
async function readTurns(query, rec, unread) {
  const unreadNow = (reason) => {
    if (unread) unread.set(rec.id, reason);
    return [];
  };
  if (!query || typeof query.observeSession !== 'function') return unreadNow('宿主没有会话查询服务');
  let observed;
  try {
    observed = await query.observeSession(rec.id);
  } catch (error) {
    /* 会话不存在、不在查询索引里、日志正在被写……都落到这里。原因原样带上：
       只报"没读到"而不报"为什么"，下次还得再猜一轮。 */
    return unreadNow('观察会话失败：' + String((error && error.message) || error).slice(0, 160));
  }
  try {
    const events = observed && Array.isArray(observed.events) ? observed.events
      : Array.isArray(observed) ? observed
        : null;
    /* 句柄形状不对同样是"没读到"，不能当成"这个会话没有轮次" */
    if (!events) return unreadNow('观察句柄里没有 events');
    return foldTurns(events, {
      inheritedEventCount: rec.inheritedEventCount,
      isSeeded: rec.isSeeded
    });
  } finally {
    /* 观察句柄是资源，用完要还 */
    try {
      if (observed && typeof observed[Symbol.dispose] === 'function') observed[Symbol.dispose]();
    } catch { /* 释放失败不影响结果 */ }
  }
}

/* ---------------------------------------------------- 超规模降级（FR-4） */

/** 骨架块里保留多长的提问预览 —— 需求要「只显示轮次号与提问预览」 */
export const SKELETON_PREVIEW = 60;

/**
 * 超出块数预算时把一部分块降级成**骨架块**，而不是让整张图失败。
 *
 * 原先这里直接抛 413：一超限就什么都看不到，与 FR-4「未加载轮次显示为骨架块」
 * 和 FR-13「家族超规模 → 降级提示条」都相反。
 *
 * 骨架块保留轮次号、所属会话与**提问预览**（需求明确要求这两样），
 * 丢掉回答正文 —— 回答才是体积的大头。
 *
 * 优先级：当前会话 > 调用方点名的轮次（`full`）> 其余按图顺序。
 *
 * @param {Array} blocks 已装配的块
 * @param {number} budget 预算；为空表示不限制
 * @param {{currentId?: string, full?: Set<string>}} [opts]
 * @returns {{blocks: Array, keep: Set<string>, skeleton: number}}
 */
export function skeletonize(blocks, budget, opts) {
  const o = opts || {};
  const list = Array.isArray(blocks) ? blocks : [];
  if (!budget || budget <= 0 || list.length <= budget) {
    return { blocks: list, keep: new Set(list.map((b) => b.id)), skeleton: 0 };
  }
  const pinned = o.full instanceof Set ? o.full : new Set(o.full || []);

  /* 点名的块**一定要给**：用户是点着它才发起这次请求的。
     只调整优先级是不够的 —— 当前会话自己就把预算占满时，点名的块永远挤不进来，
     「点击骨架块载入」这个功能就等于不存在。点名数量在上游 parseIds 里封了顶。 */
  const keep = new Set(list.filter((b) => pinned.has(b.id)).map((b) => b.id));
  const room = Math.max(0, budget - keep.size);
  const rest = list
    .filter((b) => !keep.has(b.id))
    .map((b, i) => ({ b, i, r: b.sessionId === o.currentId ? 0 : 1 }))
    .sort((x, y) => (x.r - y.r) || (x.i - y.i));
  rest.slice(0, room).forEach((x) => keep.add(x.b.id));

  let skeleton = 0;
  const out = list.map((b) => {
    if (keep.has(b.id)) return b;
    skeleton += 1;
    return { ...b, prompt: clip(b.prompt, SKELETON_PREVIEW), response: '', skeleton: true };
  });
  return { blocks: out, keep, skeleton };
}

/**
 * 轮次明细也要一起降级。
 *
 * 客户端会用 `turns` 给家族里其它会话重建块；只降级 `blocks` 而不降级 `turns`，
 * 客户端一重建就把完整正文又拉回来了，等于没降。
 */
export function skeletonizeTurns(turnsBySession, keep) {
  const out = {};
  Object.keys(turnsBySession || {}).forEach((sid) => {
    const list = turnsBySession[sid];
    if (!Array.isArray(list)) { out[sid] = list; return; }
    out[sid] = list.map((t) => {
      const id = `${sid}:${t.turn}`;
      if (keep.has(id)) return t;
      return { ...t, prompt: clip(t.prompt, SKELETON_PREVIEW), response: '' };
    });
  });
  return out;
}

/* ------------------------------------------------------------ 请求处理 */

export async function buildPayload(ctx, params, limits, store) {
  const currentId = params.get('sessionId') || '';
  if (!currentId) throw Object.assign(new Error('缺少 sessionId'), { status: 400 });

  const format = (params.get('format') || 'json').toLowerCase();
  if (!FORMATS.has(format)) {
    throw Object.assign(new Error('format 只能是 json / mm / md'), { status: 400 });
  }
  const includeHidden = params.get('includeHidden') === 'true';
  const ids = (params.get('sessions') || '').split(',').map((s) => s.trim()).filter(Boolean);

  /* 先只取元信息：家族范围、家族根、存档记录都只需要 header，
     而"要读哪些会话的轮次"必须在读事件**之前**定下来 —— 否则又是一次全量读取。 */
  const raw = await readSessionMeta(ctx, ids, limits);
  if (!raw.some((r) => r.id === currentId)) {
    throw Object.assign(new Error('sessionId 不在可读会话中'), { status: 404 });
  }

  /* 持久化状态按**家族根**分片（§5.3）。家族的根在这里算：往上走到没有父会话为止。 */
  const familyRootId = rootOf(raw, currentId);
  const stored = store ? await store.read(familyRootId) : null;
  const saved = stored && stored.state ? stateToClient(stored.state) : null;

  /* 存档里的隐藏与别名是基线，请求参数是本次会话的覆盖 —— 两者合并后再建图，
     否则刷新之后界面会与存档对不上。 */
  const hidden = { ...(saved ? saved.hidden : {}), ...parseMap(params.get('hidden')) };
  const alias = { ...(saved ? saved.alias : {}), ...parseMap(params.get('alias')) };
  /* 连线同理由请求参数补齐（FR-15）：界面上的连线有 400ms 写回防抖，只读模式下更是
     永远不落盘 —— 只认存档的话，导出文件里一条手动连线都没有，而导出对话框的预览
     （客户端本地 render）里明明有。参数按 id 覆盖存档，导出的 .mm/.md 用合并结果。 */
  const links = mergeLinks(saved && saved.links, parseLinks(params.get('links')));
  /* 归档会话由客户端告知（只有它的 workspace 快照里有这份名单）：导出的文件要与画布同口径 */
  const archived = parseArchived(params.get('archived'));

  const query = service(ctx, 'sessionQuery');
  const scope = turnScopeOf(raw, { currentId, named: ids, links });
  await resolveTitles(query, raw, scope);
  /* 读不到的会话要单独回传：界面上那一格是"空会话"还是"没读到"，必须分得开 */
  const unread = new Map();
  const turnsBySession = await readTurnsBySession(query, raw, scope, unread);
  const sessions = assembleSessions(raw, turnsBySession);

  const graph = buildGraph({
    sessions, turnsBySession, currentId, includeHidden, hidden, alias, links, archived
  });

  /* 超预算不再抛错，而是降级成骨架块（FR-4） */
  const budget = limits && limits.maxBlocks ? limits.maxBlocks : 0;
  const skel = skeletonize(graph.blocks, budget, {
    currentId,
    full: parseIds(params.get('full'))
  });
  const skeleton = skel.skeleton;
  const turnsOut = skeleton ? skeletonizeTurns(turnsBySession, skel.keep) : turnsBySession;

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        version: graph.version,
        rootId: familyRootId,
        currentId: graph.currentId,
        order: graph.order,
        notes: graph.notes,
        stats: { ...graph.stats, blocks: skel.blocks.length, skeleton },
        sessions: graph.sessions,
        blocks: skel.blocks,
        edges: graph.edges,
        /* 各会话的轮次明细，供客户端给"其他会话"也画出块（FR-3） */
        turns: turnsOut,
        /* 这些会话的轮次**没读到**（不是"没有轮次"），并带上原因。界面据此说明、
           给重试入口；否则读失败与空会话长得一模一样，用户会以为自己的对话丢了（FR-13）。 */
        ...(unread.size ? { unread: [...unread].map(([id, reason]) => ({ id, reason })) } : {}),
        /* 持久化状态：客户端拿它初始化隐藏/别名/连线/布局；writable 为 false 时只读 */
        state: saved,
        writable: !!(store && stored && stored.writable),
        incompatible: !!(stored && stored.incompatible)
      }),
      /* json 是给视图取数用的，不触发下载 */
      download: false
    };
  }

  const out = render(graph, format, { links });
  return {
    contentType: format === 'mm' ? 'application/xml; charset=utf-8' : 'text/markdown; charset=utf-8',
    body: out.content,
    download: true,
    filename: out.filename
  };
}

/** 家族根：沿 parentId 一路向上；血环或断链时兜底为当前会话 */
export function rootOf(sessions, currentId) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const seen = new Set();
  let cur = byId.get(currentId);
  while (cur && cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
  }
  return cur ? cur.id : currentId;
}

/** 逗号分隔的块 id 列表 → Set（FR-4 的「点名载入」） */
function parseIds(value) {
  const s = typeof value === 'string' ? value : '';
  if (!s) return null;
  const ids = s.split(',').map((x) => x.trim()).filter(Boolean);
  return ids.length ? new Set(ids.slice(0, 400)) : null;
}

function parseMap(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw Object.assign(new Error('hidden / alias 必须是 JSON 对象'), { status: 400 });
  }
}

/**
 * `links=` 查询参数：界面上的连线（客户端内部形态
 * `{id, kind, from, to, label?}`，端点可能是 `sid:turn` 或 `header:sid`）。
 *
 * 只有"不是 JSON 数组"才算参数非法 —— 单条连线的字段残缺不该整单失败：
 * buildGraph 自己会丢掉 from/to 缺失或自环的条目，这里再做一遍校验只会重复规则。
 */
function parseLinks(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('links 必须是 JSON 数组'), { status: 400 });
  }
  if (!Array.isArray(parsed)) {
    throw Object.assign(new Error('links 必须是 JSON 数组'), { status: 400 });
  }
  /* 与存档同一条 NFR-1 上限：不让一个癫狂的查询串把图撑爆 */
  return parsed.slice(0, LIMITS.links);
}

/**
 * `archived=` 查询参数：已归档的会话 id 列表（JSON 数组）。
 *
 * 导出的 Host 侧渲染必须与画布**同一口径**：画布不画归档会话，文件里也不该多出卡片。
 * 归档信息只有客户端知道（它来自 workspace 快照），所以由它随请求带上。
 * 与 `links=` 同样口径：只有"不是 JSON 数组"才判参数非法。
 */
function parseArchived(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('archived 必须是 JSON 数组'), { status: 400 });
  }
  if (!Array.isArray(parsed)) {
    throw Object.assign(new Error('archived 必须是 JSON 数组'), { status: 400 });
  }
  return parsed.map((x) => String(x)).filter(Boolean).slice(0, LIMITS.links);
}

/**
 * 连线按 id 合并，**参数优先**（FR-15）。
 *
 * 存档顺序保持不变（界面上连线的次序不该因为一次导出而变），同 id 的用参数那条
 * 原地替换；参数里多出来的 id 按参数顺序追加。没有 id 的条目无法定位，只能追加 ——
 * 生成 id 是客户端的责任，宿主不替它编造稳定标识。
 */
function mergeLinks(saved, incoming) {
  const out = [];
  const at = new Map();
  const put = (l, override) => {
    if (!l || typeof l !== 'object' || Array.isArray(l)) return;
    const id = typeof l.id === 'string' && l.id !== '' ? l.id : null;
    if (id !== null && at.has(id)) {
      if (override) out[at.get(id)] = l;
      return;
    }
    if (id !== null) at.set(id, out.length);
    out.push(l);
  };
  (Array.isArray(saved) ? saved : []).forEach((l) => put(l, false));
  (Array.isArray(incoming) ? incoming : []).forEach((l) => put(l, true));
  return out.slice(0, LIMITS.links);
}

/* --------------------------------------------------------------- 插件 */

export function apply(ctx, config) {
  const limits = {
    maxSessions: numberOr(config && config.maxSessions, 200),
    maxBlocks: numberOr(config && config.maxBlocks, 3000)
  };

  /* 存储句柄放在闭包里，路由注册在前、存储打开在后。
     顺序很要紧：打开存储要走异步的领域设施，万一它挂住，路由就永远注册不上，
     浏览器侧只会看到一个 404 而无从判断。先让路由一定在位，再补上持久化。 */
  const holder = { store: null, ready: false };

  const register = (scoped) => {
    const conn = service(scoped, 'connection');
    if (!conn || !conn.fetch || typeof conn.fetch.register !== 'function') return;
    conn.fetch.register({
      path: ROUTE,
      methods: ['GET', 'HEAD', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const response = request.method === 'POST'
          ? await respondWrite(holder, request)
          : await respondRead(holder, ctx, request, limits);
        if (request.method !== 'HEAD') return response;
        /* HEAD 是浏览器的下载预检：取消响应体，只回状态与响应头 */
        if (response.body && typeof response.body.cancel === 'function') {
          await response.body.cancel();
        }
        return new Response(null, { status: response.status, headers: response.headers });
      }
    });
    /* 路由已在位，再去开存储；失败只是降级为只读，不影响上面这条注册。
       句柄的生命周期**归调用方**：宿主的领域设施不替消费者关闭它
       （`dsh-storage-domain` 明说 "the CALLER owns the returned handle"）。
       不关的后果不是"泄漏一点内存"这么轻：那个域在 json 后端里一直开着、
       名字也一直占着，插件重载/热更时再 open 会以 `already-open` 失败 ——
       又是一次静默只读。所以先把 disposer 挂上，再异步打开，两种先后顺序都收得住。 */
    let store = null;
    let disposed = false;
    const closeStore = () => {
      const opened = store;
      store = null;
      holder.store = null;
      if (opened && typeof opened.close === 'function') {
        try { void opened.close(); } catch { /* 关闭失败没有补救手段 */ }
      }
    };
    const logger = (scoped && scoped.logger) || (ctx && ctx.logger) || null;
    const onDispose = () => { disposed = true; closeStore(); };
    if (typeof scoped.effect === 'function') scoped.effect(() => onDispose);
    else if (typeof ctx.effect === 'function') ctx.effect(() => onDispose);

    void openStore(service(scoped, 'storageDomain'), undefined, (error) => {
      /* 打开失败以前是完全静默的：界面只会一直显示"只读"，没人知道为什么。
         把原因写进日志，这类问题下次不必再靠读宿主的正则才能定位。 */
      try {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`会话图谱：存储域 ${DOMAIN_NAME} 打不开，已降级为只读。原因：${String((error && error.message) || error)}`);
        }
      } catch { /* 日志不可用不影响主流程 */ }
    }).then((opened) => {
      /* 已经卸载了才等到结果：立刻还回去，别把域留在打开状态 */
      if (disposed) {
        if (opened && typeof opened.close === 'function') {
          try { void opened.close(); } catch { /* 同上 */ }
        }
        return;
      }
      store = opened;
      holder.store = opened;
      holder.ready = true;

      /* 存储会不会无声长大：报告可能再也读不到的家族记录数。
         **只报告，不删除** —— 冷会话（在磁盘上但没被打开）不在活跃列表里，
         照"不在活跃列表就删"会删掉仍然存在的会话的存档，而宿主目前没有可靠的
         "会话是否还在"探针（`readTitle` 返回 undefined 只表示日志里没有标题事件）。
         详见 src/host/store.js 的 findOrphanRecords。 */
      void findOrphanRecords(opened, { knownIds: liveSessionIds(ctx) })
        .then((scan) => {
          if (!scan.supported || scan.candidates.length === 0) return;
          try {
            if (logger && typeof logger.warn === 'function') {
              logger.warn(`会话图谱：存储里有 ${scan.candidates.length} 条家族记录（共 ${scan.total} 条）`
                + '对应的会话已不在活跃列表里且很久未更新。它们可能是冷会话的存档，'
                + '所以不会自动删除；如需清理请先确认这些会话确实已删除。');
            }
          } catch { /* 日志不可用不影响主流程 */ }
        })
        .catch(() => { /* 扫描失败只是少了提示，不影响任何功能 */ });
    });
  };

  /* 服务已就绪时同步注册；否则等它出现再注册，插件本体不会卡住 */
  if (typeof ctx.inject === 'function') ctx.inject(['connection'], register);
  else register(ctx);
}

/** 宿主活跃会话 id。**冷会话不在这里** —— 所以它只能用来"排除确定还活着的"，
 * 不能反过来推断某个会话已经消失（见 findOrphanRecords 的说明）。 */
function liveSessionIds(ctx) {
  try {
    const store = service(ctx, 'sessions');
    const list = store && typeof store.list === 'function' ? (store.list() || []) : [];
    return list
      .map((s) => String((s && s.header && s.header.id) ?? (s && s.id) ?? ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function respondRead(holder, ctx, request, limits) {
  let result;
  try {
    result = await buildPayload(ctx, new URL(request.url).searchParams, limits, holder.store);
  } catch (error) {
    return text(String((error && error.message) || error), (error && error.status) || 503);
  }
  const headers = { 'content-type': result.contentType };
  if (result.download && result.filename) {
    /* 文件名用 RFC 5987 的 filename*，中文标题才不会乱码 */
    headers['content-disposition'] =
      `attachment; filename="session-graph"; filename*=UTF-8''${encodeURIComponent(result.filename)}`;
  }
  return new Response(result.body, { status: 200, headers });
}

/**
 * 写入：客户端把界面偏好与手动连线以增量形式提交上来。
 *
 * 请求体：`{ familyRootId, patch }`。整体按 §5.3 的 schema 落进领域表。
 */
async function respondWrite(holder, request) {
  if (!holder.ready) {
    return json({ ok: false, writable: false, reason: '存储尚未就绪' }, 503);
  }
  if (!holder.store) {
    return json({ ok: false, writable: false, reason: '存储不可用，当前为只读模式' }, 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, reason: '请求体不是合法 JSON' }, 400);
  }
  const familyId = String((body && body.familyRootId) || '');
  if (familyId === '') return json({ ok: false, reason: '缺少 familyRootId' }, 400);
  try {
    const state = await holder.store.write(familyId, (body && body.patch) || {});
    return json({ ok: true, writable: true, state }, 200);
  } catch (error) {
    const code = error && error.code === 'incompatible-version' ? 409 : 503;
    return json({ ok: false, reason: String((error && error.message) || error) }, code);
  }
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function numberOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}
