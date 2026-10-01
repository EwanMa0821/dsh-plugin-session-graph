/* ============================================================
   会话图谱 · 客户端应用
   本文件由 scripts/build-client.mjs 原样追加到生成的 client.js 中，
   运行在 __ModuleLoader__ 的 factory 作用域里，因此可以直接使用
   上面已经内联的核心函数（buildGraph / layout / render ...）。

   约束（NFR-2）：只用 --dsw-* 主题变量；除 react 与宿主的 primitives 基础件外
   不 require 别的包；不向 document.body 追加；样式以 React 元素渲染，随组件卸载移除。
   ============================================================ */

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
.sg-root{position:absolute;inset:0;display:flex;font-family:inherit;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);user-select:none;-webkit-user-select:none}
.sg-canvas-wrap{flex:1;min-width:0;position:relative;overflow:hidden;user-select:none;-webkit-user-select:none;
  cursor:grab;
  background-image:radial-gradient(var(--dsw-alias-border-l2) 1px,transparent 1px);background-size:22px 22px}
.sg-canvas-wrap.sg-panning{cursor:grabbing}
.sg-canvas-wrap.sg-linking{cursor:crosshair}
/* 归档会话：看得到、点不动，悬停说明原因（FR-14） */
.sg-label.sg-unavailable{opacity:.45;cursor:not-allowed}
/* 数据读不出来的块：降级显示，但仍可选中/连线/分叉（FR-13） */
.sg-node.sg-node-thin{border-style:dashed}
/* 尚未载入的骨架块（FR-4）：点一下就把这一轮要回来 */
.sg-node.sg-node-skel{border-style:dashed;background:var(--dsw-alias-bg-base)}
.sg-node.sg-node-skel .sg-ans{color:var(--dsw-alias-state-business-primary)}
.sg-node.sg-node-thin .sg-ask{color:var(--dsw-alias-label-caption)}
/* 图角的状态说明（FR-13） */
.sg-corner{position:absolute;right:10px;bottom:8px;z-index:6;pointer-events:none;
  padding:3px 9px;border-radius:7px;font-size:11.5px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-caption);
  border:.5px solid var(--dsw-alias-border-l3)}
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
.sg-side{flex:0 0 clamp(320px, 26vw, 430px);border-left:.5px solid var(--dsw-alias-border-l1);display:flex;
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
/* 唯一滚动的区域 */
.sg-side-bd{flex:1;overflow-y:auto;padding:12px 15px 16px;min-height:0}
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

/** 订阅一个快照源。只依赖 { getSnapshot, subscribe } 这两个方法。 */
function useSource(source) {
  const [value, setValue] = React.useState(() => {
    try { return source && source.getSnapshot ? source.getSnapshot() : undefined; } catch { return undefined; }
  });
  React.useEffect(() => {
    if (!source || typeof source.subscribe !== 'function') return undefined;
    let alive = true;
    const pull = () => { if (alive) { try { setValue(source.getSnapshot()); } catch { /* 源暂时不可读 */ } } };
    pull();
    const off = source.subscribe(pull);
    return () => { alive = false; if (typeof off === 'function') off(); };
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
      const v = typeof sessions[key] === 'function' ? sessions[key]() : sessions[key];
      if (typeof v === 'string' && v) return v;
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
    const snap = ctx && ctx.workspaces && ctx.workspaces.list && ctx.workspaces.list.getSnapshot();
    const items = snap && Array.isArray(snap.items) ? snap.items : [];
    const hit = items.find((it) => Array.isArray(it.sessionIds) && it.sessionIds.includes(sessionId));
    return (hit && hit.workspaceId) || (items[0] && items[0].workspaceId) || '';
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------ 主组件 */

function GraphView(props) {
  const { ctx, target, sessions } = props || {};
  const listSnapshot = useSource(sessions && sessions.list);
  /* 归档会话在图谱里仍会出现，但**点不动**（FR-14：目标不可用要禁用并说明原因） */
  const wsSnapshot = useSource(ctx && ctx.workspaces && ctx.workspaces.list);
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
  const t = React.useMemo(() => {
    const svc = ctx && ctx.locale;
    const resolver = svc && typeof svc.resolveText === 'function'
      ? (text) => svc.resolveText(text)
      : null;
    return makeT(activeLocale, resolver);
  }, [ctx, activeLocale]);
  /** 数字按当前语言排版（NFR-3 第三条） */
  const fmtNum = React.useCallback(
    (n) => formatNumber(n, activeLocale),
    [activeLocale]
  );
  const mdLabels = React.useMemo(() => markdownLabels(t), [t]);

  const [selected, setSelected] = React.useState(null);
  const [hidden, setHidden] = React.useState({});
  const [alias, setAlias] = React.useState({});
  const [links, setLinks] = React.useState([]);
  /* 用户摆过的坐标（FR-5：已拖拽过的块坐标即权威） */
  const [positions, setPositions] = React.useState({});
  /* 正在拖动中的块：{ id, x, y }，只在本地生效，松手才落盘 */
  const [draggingBlock, setDraggingBlock] = React.useState(null);
  /* 骨架档下用户显式展开的会话（NFR-1：其余按需展开） */  const [expandedSessions, setExpandedSessions] = React.useState([]);
  const isExpanded = React.useCallback(
    (sid) => expandedSessions.indexOf(sid) >= 0,
    [expandedSessions]
  );
  const toggleExpanded = React.useCallback((sid) => {
    setExpandedSessions((list) => (list.indexOf(sid) >= 0
      ? list.filter((x) => x !== sid)
      : [...list, sid]));
  }, []);
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
  const [exportFmt, setExportFmt] = React.useState('mm');
  const [exportHidden, setExportHidden] = React.useState(false);
  const [toast, setToast] = React.useState('');
  /* 只留一个"路由是否可用"的布尔量，给空态说人话用；不对外暴露状态码 */
  const [routeOk, setRouteOk] = React.useState(true);
  const hostRef = React.useRef(null);
  const [size, setSize] = React.useState({ w: 900, h: 600 });

  const graphSnapshot = useSource(target);

  /* 视口尺寸：跟随容器，切换视图后回来仍正确 */
  React.useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth || 900, h: el.clientHeight || 600 });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth || 900, h: el.clientHeight || 600 });
    return () => ro.disconnect();
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
  const localTurns = React.useMemo(
    () => turnsFromTimeline(graphSnapshot && graphSnapshot.timeline),
    [graphSnapshot]
  );

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

  React.useEffect(() => {
    if (!sessionId) return undefined;
    let alive = true;
    const url = '/api/session.graph-export'
      + '?format=json'
      + '&sessionId=' + encodeURIComponent(sessionId)
      + (sessionKey ? '&sessions=' + encodeURIComponent(sessionKey) : '')
        + (fullIds.length ? '&full=' + encodeURIComponent(fullIds.slice(-400).join(',')) : '');
    const carrier = typeof fetch === 'function' ? fetch : null;
    if (!carrier) { setRouteOk(false); setLoaded(true); return undefined; }
    carrier(url, { credentials: 'same-origin' })
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
        /* 存档是基线，界面上的改动在此之上叠加 */
        const saved = data.state || null;
        setHidden(saved && saved.hidden ? saved.hidden : {});
        setAlias(saved && saved.alias ? saved.alias : {});
        setLinks(saved && saved.links ? saved.links : []);
        setPositions(saved && saved.positions ? saved.positions : {});
        setWritable(data.writable !== false);
        setIncompatible(!!data.incompatible);
        savedViewportRef.current = (saved && saved.viewport) || null;
        loadedRef.current = true;
        setLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        setRouteOk(false);
        loadedRef.current = true;
        setLoaded(true);
      });
    return () => { alive = false; };
  }, [sessionId, sessionKey, reloadNonce, fullIds]);

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

  /* 写回：交互写入按帧合并后节流提交（§5.3 的写入策略） */
  const writableRef = React.useRef(true);
  writableRef.current = writable;
  const pendingRef = React.useRef(null);
  const timerRef = React.useRef(null);
  const persist = React.useCallback((patch) => {
    if (!loadedRef.current || !writableRef.current) return;
    const payload = clientPatchToState(patch);
    if (!Object.keys(payload).length) return;
    pendingRef.current = { ...(pendingRef.current || {}), ...payload };
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const body = pendingRef.current;
      pendingRef.current = null;
      if (!body || !familyRef.current || typeof fetch !== 'function') return;
      fetch('/api/session.graph-export', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ familyRootId: familyRef.current, patch: body })
      }).then((r) => {
        if (r && r.ok) { setSaveError(''); return; }
        /* 提交失败：保留内存状态并标记未保存，而不是回滚用户刚做的操作 */
        setSaveError(r && r.status === 409 ? t('ro.writeFailedIncompatible') : t('ro.writeFailed'));
        if (r && r.status === 409) setIncompatible(true);
      }).catch(() => setSaveError(t('ro.writeFailed')));
    }, 400);
  }, []);

  const clearPending = React.useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    pendingRef.current = null;
  }, []);
  React.useEffect(() => () => clearPending(), [clearPending]);

  const turnsBySession = React.useMemo(() => {
    const out = { ...(remote || {}) };
    if (!sessionId || !localTurns.length) return out;
    /* 逐字段合并，而不是整条覆盖。
       本地时间线更新更快，但它的轮次记录里**没有问答文本**（文本在 data 这个 Map 里，
       按插件定义键存放），远程读的是原始事件、文本是齐的——
       整条覆盖会把文本抹成空。 */
    const byTurn = new Map((out[sessionId] || []).map((t) => [t.turn, t]));
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
  /* 骨架档下哪些会话的块要画；null 表示不限 */
  const blockSessions = graph && !graph.error
    ? sessionsWithBlocks(graph.sessions, tier, sessionId, expandedSessions)
    : null;
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

  /* 快照式撤销：这三份自有数据就是全部可变状态，量也小，
     与其为每种操作写一个逆操作，不如存一份快照。上限 50 步。 */
  const historyRef = React.useRef([]);
  const [canUndo, setCanUndo] = React.useState(false);

  /** 在任何变更**之前**调用 */
  const remember = React.useCallback(() => {
    historyRef.current.push({ hidden, alias, links, positions });
    if (historyRef.current.length > 50) historyRef.current.shift();
    setCanUndo(true);
  }, [hidden, alias, links, positions]);

  /** 把界面与存档一起恢复到某个快照；多出来的连线要显式删掉 */
  const applySnapshot = React.useCallback((snap) => {
    const keep = new Set(snap.links.map((l) => l.id));
    const removeLinkIds = links.filter((l) => !keep.has(l.id)).map((l) => l.id);
    const nextPositions = snap.positions || {};
    setHidden(snap.hidden);
    setAlias(snap.alias);
    setLinks(snap.links);
    setPositions(nextPositions);
    persist({
      hidden: snap.hidden, alias: snap.alias, links: snap.links,
      positions: nextPositions, removeLinkIds
    });
  }, [links, persist]);

  const undo = React.useCallback(() => {
    const snap = historyRef.current.pop();
    setCanUndo(historyRef.current.length > 0);
    if (!snap) { say(t('toolbar.nothingToUndo')); return; }
    applySnapshot(snap);
  }, [applySnapshot, say]);

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
    const block = graph.blocks.find((b) => b.sessionId === sid && b.turn === turn);
    if (block && block.status === 'open') { say(t('fork.openTurn')); return; }
    const atSeq = block ? block.endSeq : null;
    if (atSeq === null || atSeq === undefined) { say(t('fork.noBoundary')); return; }
    try {
      const titles = graph.sessions.map((s) => s.title);
      const src = graph.sessions.find((s) => s.id === sid);
      const childTitle = src ? uniqueTitle(src.title, titles) : undefined;
      const p = ctx.sessions.fork({ sessionId: sid, atSeq, increaseTitle: true, onCreated: () => undefined });
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          const code = err && err.rpcError ? err.rpcError.code : '';
          if (code === 'session/fork-unavailable') say(t('fork.noneAvailable'));
          else if (code === 'session/not-found') say(t('fork.sourceUnavailable'));
          else say(t('fork.failed', { msg: err && err.message ? err.message : String(err) }));
        });
      }
      say(t('fork.done', { turn }) + (childTitle ? ' → ' + childTitle : ''));
    } catch (e) {
      say(t('fork.failed', { msg: e && e.message ? e.message : String(e) }));
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

  /* 导出：生成内容 → 不挂到 body 的 anchor 触发下载 */
  const exportText = React.useCallback((fmt, includeHidden) => {
    const g = buildGraph({
      sessions: sessionsNorm, turnsBySession, currentId: sessionId,
      hidden, alias, links, includeHidden
    });
    return render(g, fmt, { links, stamp: stamp(new Date()) });
  }, [sessionsNorm, turnsBySession, sessionId, hidden, alias, links]);

  /* 导出（FR-15）：优先走 Host 路由——先 HEAD 预检，通过后交给浏览器下载管理器；
     路由不可用时回落到本地生成 + Blob，保证功能不因为接线问题而消失。 */
  const routeUrl = React.useCallback((fmt, includeHidden) => {
    const ids = sessionsNorm.map((s) => s.id).join(',');
    return '/api/session.graph-export'
      + '?format=' + fmt
      + '&sessionId=' + encodeURIComponent(sessionId)
      + (ids ? '&sessions=' + encodeURIComponent(ids) : '')
      + (includeHidden ? '&includeHidden=true' : '')
      + (Object.keys(hidden).length ? '&hidden=' + encodeURIComponent(JSON.stringify(hidden)) : '')
      + (Object.keys(alias).length ? '&alias=' + encodeURIComponent(JSON.stringify(alias)) : '');
  }, [sessionsNorm, sessionId, hidden, alias]);

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
      return h('div', {
        key: n.id,
        className: 'sg-label' + (n.sessionId === sessionId ? ' sg-current' : '')
          + (gone ? ' sg-unavailable' : ''),
        style: { left: n.x, top: n.y, minWidth: n.w, height: n.h },
        title: gone ? t('head.archived') : t('head.switchTip'),
        'aria-disabled': gone ? 'true' : undefined,
        onClick: gone ? undefined : () => openSession(n.sessionId)
      },
      h('span', { className: 'sg-sdot' }),
      h('span', { className: 'sg-st' }, n.title),
      h('span', { className: 'sg-sm' }, t('head.turnCount', { n: fmtNum(n.turnCount) })),
      /* 骨架档下非当前会话只出头；这里给一个就地展开的入口（NFR-1「按需展开」） */
      (feats.skeletonOnly && n.sessionId !== sessionId && n.turnCount)
        ? h('span', {
          className: 'sg-expand',
          title: isExpanded(n.sessionId) ? t('head.collapse') : t('head.expand'),
          onClick: (ev) => { ev.stopPropagation(); toggleExpanded(n.sessionId); }
        }, isExpanded(n.sessionId) ? '▾' : '▸')
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
       判定与 stats.incomplete 一致：这一轮已结束，但提问与回答都没有文本。 */
    const thin = b.status !== 'open' && !digest(b.prompt) && !digest(b.response);
    /* FR-4：超规模时 Host 把这个块降成了骨架 —— 有提问预览、没有回答。
       本地时间线若带着正文，合并之后就不再是骨架，那时按普通块画。 */
    const skel = !thin && skeletonIds.has(n.id) && !digest(b.response);
    const cls = 'sg-node'
      + (b.current ? ' sg-current' : '')
      + (selected === n.id ? ' sg-selected' : '')
      + (b.hidden && showHidden ? ' sg-hidden' : '')
      + (thin ? ' sg-node-thin' : '')
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
      'aria-label': t('block.ariaLabel', { turn: b.turn, prompt: b.prompt }),
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
        || (thin ? t('block.thin') : t('block.noPrompt')))),
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

  /* 三种边不只靠颜色区分（§5.2）：线型不同，箭头也分实心与空心 */
  const edgeList = graph.error ? [] : graph.edges;
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
  const cornerNote = cornerNotes.length
    ? h('div', { className: 'sg-corner' }, cornerNotes.join(' · '))
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

  const detail = selectedEdge
    ? buildEdgeDetail()
    : (selected ? buildDetail() : h('div', { className: 'sg-emptybox' },
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
            value: e.label || '',
            onChange: (ev) => labelLink(e.id, ev.target.value)
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
      h('div', { className: 'sg-hint' },
        linking
          ? (linking.mode === 'drag'
            ? t('hint.linkingDrag')
            : t('hint.linkingClick'))
          : t('hint.idle')),
      contentHint,
      saveHint,
      scaleHint,
      cornerNote,
      labelInput,
      body),
    h('aside', { className: 'sg-side' }, detail),
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
    try {
      const out = exportText(exportFmt, exportHidden);
      preview = out.content;
      filename = out.filename;
    } catch (e) {
      errorText = e && e.message ? e.message : String(e);
    }
    const skipped = (graph.error ? 0 : graph.stats.hiddenSkipped);
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

/* ------------------------------------------------------------ 插件入口 */

function apply(ctx) {
  /* 把字典登记进宿主的本地化服务（NFR-3 第一条：文案经宿主服务提供）。
     登记失败不影响渲染 —— 取值时还有本地字典兜底，语义与宿主一致。 */
  try {
    if (ctx.locale && typeof ctx.locale.register === 'function') {
      ctx.locale.register(NS, flatten());
    }
  } catch { /* 宿主不认这份字典时退回本地取值 */ }

  /* 视图数据层：只做纯折叠，不订阅会话事件、不轮询、不写 DOM */
  ctx.uiConversation.views.register({
    target: TARGET,
    create: () => {
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
    label: () => t('view.title'),
    inject: (sessionId) => {
      let target = null;
      try {
        target = ctx.uiConversation.binding(sessionId).target(TARGET);
      } catch {
        /* 会话暂时不可绑定：视图退化为空态，不抛到槽位渲染里 */
      }
      return { sessionId, ctx, target, sessions: ctx.sessions };
    }
  }, GraphView));
}

return { inject: ['slots', 'sessions', 'uiSession', 'uiConversation', 'uiWorkspace', 'workspaces'], apply };
