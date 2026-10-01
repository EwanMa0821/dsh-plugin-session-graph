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

import { normalizeSessions, buildGraph } from './src/core/model.js';
import { render } from './src/core/export.js';
import { foldTurns, linkForks } from './src/host/fold.js';

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
 * 读取一组会话的元信息与轮次。
 *
 * 会话元信息优先取 header（`parentSession` / `inheritedEventCount` 都在那里）；
 * 轮次由 sessionQuery 的事件流折叠得到。
 * 任何一步读不到都只是**少一点数据**，不让整个请求失败。
 */
export async function readSessions(ctx, ids, limits) {
  const store = service(ctx, 'sessions');
  const query = service(ctx, 'sessionQuery');
  const live = store && typeof store.list === 'function' ? (store.list() || []) : [];

  const raw = [];
  live.forEach((s) => {
    const header = (s && s.header) || {};
    const id = String(header.id ?? (s && s.id) ?? '');
    if (!id) return;
    raw.push({
      id,
      title: String(header.title ?? (s && s.title) ?? id),
      parentId: header.parentSession ?? header.parentSessionId ?? null,
      inheritedEventCount: header.inheritedEventCount ?? (s && s.inheritedEventCount) ?? null,
      /* 冷会话不在 list() 里；调用方可通过 ids 显式点名 */
      session: s
    });
  });

  /* 客户端用 ids 补齐它目录里有、但当前不活跃的会话 */
  const known = new Set(raw.map((r) => r.id));
  (ids || []).forEach((id) => {
    if (!id || known.has(id)) return;
    known.add(id);
    raw.push({ id, title: id, parentId: null, inheritedEventCount: null, session: null });
  });

  if (limits && limits.maxSessions && raw.length > limits.maxSessions) {
    throw new Error(`会话数超过上限 ${limits.maxSessions}`);
  }

  const turnsBySession = {};
  /* 串行读取：observeSession 会打开一个观察句柄，并发打开没有好处 */
  for (const r of raw) {
    turnsBySession[r.id] = await readTurns(query, r);
  }

  const sessions = linkForks(
    normalizeSessions(raw.map((r) => ({
      id: r.id, title: r.title, parentId: r.parentId, sessionId: r.id
    }))).map((s) => {
      const src = raw.find((r) => r.id === s.id);
      return { ...s, inheritedEventCount: src ? src.inheritedEventCount : null };
    }),
    turnsBySession
  );

  return { sessions, turnsBySession };
}

/**
 * 读一个会话的事件流并折成轮次。
 *
 * `sessionQuery.observeSession()` 是**异步**的，返回一个可释放的观察句柄
 * （产品自身的会话日志导出就是 `await` 它、读 `.events`、再释放）。
 * 这里必须 await，否则拿到的是 Promise，`.events` 恒为 undefined，
 * 结果就是"路由 200 但每个会话 0 轮"。
 */
async function readTurns(query, rec) {
  if (!query || typeof query.observeSession !== 'function') return [];
  let observed;
  try {
    observed = await query.observeSession(rec.id);
  } catch {
    /* 会话不存在或不在查询索引里：留空，由上层决定怎么呈现 */
    return [];
  }
  try {
    const events = observed && Array.isArray(observed.events) ? observed.events
      : Array.isArray(observed) ? observed
        : null;
    return events ? foldTurns(events) : [];
  } finally {
    /* 观察句柄是资源，用完要还 */
    try {
      if (observed && typeof observed[Symbol.dispose] === 'function') observed[Symbol.dispose]();
    } catch { /* 释放失败不影响结果 */ }
  }
}

/* ------------------------------------------------------------ 请求处理 */

export async function buildPayload(ctx, params, limits) {
  const currentId = params.get('sessionId') || '';
  if (!currentId) throw Object.assign(new Error('缺少 sessionId'), { status: 400 });

  const format = (params.get('format') || 'json').toLowerCase();
  if (!FORMATS.has(format)) {
    throw Object.assign(new Error('format 只能是 json / mm / md'), { status: 400 });
  }
  const includeHidden = params.get('includeHidden') === 'true';
  const ids = (params.get('sessions') || '').split(',').map((s) => s.trim()).filter(Boolean);

  const { sessions, turnsBySession } = await readSessions(ctx, ids, limits);
  if (!sessions.some((s) => s.id === currentId)) {
    throw Object.assign(new Error('sessionId 不在可读会话中'), { status: 404 });
  }

  const graph = buildGraph({
    sessions, turnsBySession, currentId,
    includeHidden,
    hidden: parseMap(params.get('hidden')),
    alias: parseMap(params.get('alias'))
  });

  if (limits && limits.maxBlocks && graph.stats.blocks > limits.maxBlocks) {
    throw Object.assign(new Error(`块数超过上限 ${limits.maxBlocks}`), { status: 413 });
  }

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        version: graph.version,
        rootId: graph.rootId,
        currentId: graph.currentId,
        order: graph.order,
        notes: graph.notes,
        stats: graph.stats,
        sessions: graph.sessions,
        blocks: graph.blocks,
        edges: graph.edges,
        /* 各会话的轮次明细，供客户端给"其他会话"也画出块（FR-3） */
        turns: turnsBySession
      }),
      /* json 是给视图取数用的，不触发下载 */
      download: false
    };
  }

  const out = render(graph, format, {});
  return {
    contentType: format === 'mm' ? 'application/xml; charset=utf-8' : 'text/markdown; charset=utf-8',
    body: out.content,
    download: true,
    filename: out.filename
  };
}

function parseMap(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw Object.assign(new Error('hidden / alias 必须是 JSON 对象'), { status: 400 });
  }
}

/* --------------------------------------------------------------- 插件 */

export function apply(ctx, config) {
  const limits = {
    maxSessions: numberOr(config && config.maxSessions, 200),
    maxBlocks: numberOr(config && config.maxBlocks, 3000)
  };

  const register = (scoped) => {
    const conn = service(scoped, 'connection');
    if (!conn || !conn.fetch || typeof conn.fetch.register !== 'function') return;
    conn.fetch.register({
      path: ROUTE,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const response = await respond(ctx, request, limits);
        if (request.method === 'GET') return response;
        /* HEAD 是浏览器的下载预检：取消响应体，只回状态与响应头 */
        if (response.body && typeof response.body.cancel === 'function') {
          await response.body.cancel();
        }
        return new Response(null, { status: response.status, headers: response.headers });
      }
    });
  };

  /* 服务已就绪时同步注册；否则等它出现再注册，插件本体不会卡住 */
  if (typeof ctx.inject === 'function') ctx.inject(['connection'], register);
  else register(ctx);
}

async function respond(ctx, request, limits) {
  let result;
  try {
    result = await buildPayload(ctx, new URL(request.url).searchParams, limits);
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

function numberOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}
