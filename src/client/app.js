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
const MD_LABELS = {
  code: {
    copyLabel: '复制',
    copiedLabel: '已复制',
    toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '不换行' }
  },
  footnotes: '脚注'
};

/** 正文渲染：优先用宿主的渲染器，缺失时退回纯文本 */
function markdownBlock(text, key) {
  if (!MarkdownText) return h('div', { key, className: 'sg-tx' }, text);
  return h('div', { key, className: 'sg-md' },
    h(MarkdownText, { text, labels: MD_LABELS, variant: 'compact' }));
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

/* ------------------------------------------------------------ 主组件 */

function GraphView(props) {
  const { ctx, target, sessions } = props || {};
  const listSnapshot = useSource(sessions && sessions.list);
  const sessionId = resolveSessionId(props, listSnapshot);
  const [selected, setSelected] = React.useState(null);
  const [hidden, setHidden] = React.useState({});
  const [alias, setAlias] = React.useState({});
  const [links, setLinks] = React.useState([]);
  /* 用户摆过的坐标（FR-5：已拖拽过的块坐标即权威） */
  const [positions, setPositions] = React.useState({});
  /* 正在拖动中的块：{ id, x, y }，只在本地生效，松手才落盘 */
  const [draggingBlock, setDraggingBlock] = React.useState(null);
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

  /* 每次数据变化重建图模型 */
  const sessionsNorm = React.useMemo(() => normalizeSessions(listOf(listSnapshot)), [listSnapshot]);
  const sessionKey = sessionsNorm.map((s) => s.id).join(',');
  const localTurns = React.useMemo(
    () => turnsFromTimeline(graphSnapshot && graphSnapshot.timeline),
    [graphSnapshot]
  );

  /* 家族里其他会话的轮次要向 Host 取（本地的装配器时间线只覆盖当前会话）。
     取不到就退化成"只有当前会话有块"——家族骨架仍然完整。 */
  const [remote, setRemote] = React.useState(null);
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
      + (sessionKey ? '&sessions=' + encodeURIComponent(sessionKey) : '');
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
  }, [sessionId, sessionKey]);

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
        setSaveError(r && r.status === 409 ? '存档由更新的版本写入，本次改动未保存' : '改动未能保存');
        if (r && r.status === 409) setIncompatible(true);
      }).catch(() => setSaveError('改动未能保存'));
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
  }, [sessionsNorm, turnsBySession, sessionId, hidden, alias, links, showHidden]);

  const laid = React.useMemo(() => {
    if (!graph || graph.error) return { nodes: [], headers: new Map(), bounds: null, opts: DEFAULT_LAYOUT };
    try {
      /* 传进已摆过的坐标：布局只负责没有坐标的那些（FR-5） */
      return layout(graph, { positions });
    } catch {
      return { nodes: [], headers: new Map(), bounds: null, opts: DEFAULT_LAYOUT };
    }
  }, [graph, positions]);

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
    if (!snap) { say('没有可撤销的操作'); return; }
    applySnapshot(snap);
  }, [applySnapshot, say]);

  /** 建立一条手动连线（FR-9），随后弹出标签输入框 */
  const createLink = React.useCallback((from, to, at) => {
    if (!from || !to) return;
    if (from === to) { say('不能把一个块连到它自己'); return; }
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
      if (hit === linking.from) { say('不能把一个块连到它自己'); return; }
      createLink(linking.from, hit, toCanvas(ev));
      return;
    }

    /* 在**按下**时选中，而不是等抬起：双击过程中手抖一两个像素很常见，
       若靠"没移动过"来决定选中，双击就会既不选中、又照样分叉 */
    if (hit) setSelected(hit);
    const node = hit ? nodeMap.get(hit) : null;
    /* 拖块 = 移动块，拖空白 = 平移（FR-5）。块上起手不再平移 ——
       那会让"想挪块"变成"整张图跑掉"。 */
    drag.current = node && node.kind === 'block'
      ? { kind: 'move', id: hit, sx: ev.clientX, sy: ev.clientY, ox: node.x, oy: node.y, moved: false, focus: hit }
      : { kind: 'pan', sx: ev.clientX, sy: ev.clientY, px: view.panX, py: view.panY, moved: false, id: hit };
    setPanning(true);
  }, [nodeMap, view, linking, createLink, say, toWorld, toCanvas]);

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
        if (to === from) { L.say('不能把一个块连到它自己'); return; }
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
    if (block && block.status === 'open') { say('该轮尚未结束，不能从这里分叉'); return; }
    const atSeq = block ? block.endSeq : null;
    if (atSeq === null || atSeq === undefined) { say('这一轮没有可用的分叉边界，可能尚未载入'); return; }
    try {
      const titles = graph.sessions.map((s) => s.title);
      const src = graph.sessions.find((s) => s.id === sid);
      const childTitle = src ? uniqueTitle(src.title, titles) : undefined;
      const p = ctx.sessions.fork({ sessionId: sid, atSeq, increaseTitle: true, onCreated: () => undefined });
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          const code = err && err.rpcError ? err.rpcError.code : '';
          if (code === 'session/fork-unavailable') say('没有可用的已完成轮次');
          else if (code === 'session/not-found') say('源会话不可用，请刷新图谱');
          else say('分叉失败：' + (err && err.message ? err.message : String(err)));
        });
      }
      say('已从第 ' + turn + ' 轮分叉' + (childTitle ? ' → ' + childTitle : ''));
    } catch (e) {
      say('分叉失败：' + (e && e.message ? e.message : String(e)));
    }
  }, [ctx, graph, say]);

  const openSession = React.useCallback((sid) => {
    if (typeof ctx.sessions.retain === 'function') { try { ctx.sessions.retain(sid); } catch { /* 已保留 */ } }
    if (typeof props.onOpenSession === 'function') props.onOpenSession(sid);
    else say('请在左侧会话列表中选择该会话');
  }, [ctx, props, say]);

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
      say('导出失败：' + (e && e.message ? e.message : String(e)));
      return;
    }
    const url = routeUrl(fmt, exportHidden);
    try {
      if (typeof fetch === 'function') {
        const head = await fetch(url, { method: 'HEAD', credentials: 'same-origin' });
        if (head && head.ok) {
          saveUrl(url);                      /* 文件名由 Content-Disposition 决定 */
          setExportOpen(false);
          say('已开始下载 ' + filename);
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
      say('已开始下载 ' + out.filename + '（本地生成）');
    } catch (e) {
      say('导出失败：' + (e && e.message ? e.message : String(e)));
    }
  }, [exportFmt, exportHidden, exportText, routeUrl, saveUrl, say]);

  /* ---- 渲染 ---- */
  const nodes = showHidden ? shownNodes : shownNodes.filter((n) => !(n.kind === 'block' && n.block.hidden));
  const cell = nodes.map((n) => {
    if (n.kind === 'header') {
      return h('div', {
        key: n.id,
        className: 'sg-label' + (n.sessionId === sessionId ? ' sg-current' : ''),
        style: { left: n.x, top: n.y, minWidth: n.w, height: n.h },
        title: '点击切换到这个会话',
        onClick: () => openSession(n.sessionId)
      },
      h('span', { className: 'sg-sdot' }),
      h('span', { className: 'sg-st' }, n.title),
      h('span', { className: 'sg-sm' }, n.turnCount + ' 轮'));
    }
    if (n.kind === 'empty') {
      return h('div', {
        key: n.id, className: 'sg-node sg-empty',
        style: { left: n.x, top: n.y, width: n.w, minHeight: n.h }
      }, h('span', null, '空子会话 · 尚未提问'));
    }
    const b = n.block;
    const cls = 'sg-node'
      + (b.current ? ' sg-current' : '')
      + (selected === n.id ? ' sg-selected' : '')
      + (b.hidden && showHidden ? ' sg-hidden' : '');
    const badges = [];
    if (b.toolCalls) badges.push(h('span', { key: 't', className: 'sg-badge' }, '⚙ ' + b.toolCalls));
    if (b.deliverables) badges.push(h('span', { key: 'd', className: 'sg-badge' }, '⧉ ' + b.deliverables));
    return h('div', {
      key: n.id,
      className: cls,
      'data-sg-node': n.id,
      tabIndex: 0,
      role: 'button',
      'aria-label': '第 ' + b.turn + ' 轮：' + b.prompt,
      style: { left: n.x, top: n.y, width: n.w, minHeight: n.h },
      onDoubleClick: (e) => { e.stopPropagation(); doFork(b.sessionId, b.turn); },
      onKeyDown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); setSelected(n.id); } }
    },
    h('div', { className: 'sg-hd' },
      h('span', { className: 'sg-turn' }, '第 ' + b.turn + ' 轮'),
      h('span', { className: 'sg-dot' + (b.status === 'open' ? ' sg-open' : b.status === 'failed' ? ' sg-failed' : '') }),
      h('span', { className: 'sg-sp' }),
      badges),
    h('div', { className: 'sg-ask' + (digest(b.prompt) ? '' : ' sg-empty') },
      b.alias ? '✎ ' + b.alias : (clip(digest(b.prompt), 110) || '（该轮提问尚未载入）')),
    h('div', { className: 'sg-ans' }, clip(digest(b.response, 'first-paragraph'), 220) || '（该轮回答尚未载入）'),
    /* 连线把手：拖到另一个块即可建立手动边（FR-9）。悬停或选中时才显形。 */
    h('div', {
      className: 'sg-handle',
      'data-sg-link-handle': n.id,
      title: '拖到另一个块建立连线'
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

  /* 标签落在边中点；过长由 CSS 截断，title 给完整文本（FR-9） */
  const edgeLabels = edgeList.map((e) => {
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
  }).filter(Boolean);

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

  /* 空态说人话（FR-13）：不暴露状态码，只告诉用户现在能看到什么、可以做什么 */
  const body = graph.error
    ? h('div', { className: 'sg-err' },
        '图谱没能装配起来。',
        h('br'),
        '可以把当前视图切到「对话」再切回来重试；若一直如此，请反馈这条信息：' + graph.error.message)
    : !laid.nodes.length
      ? h('div', { className: 'sg-emptybox' },
          '这个家族里还没有可显示的轮次。',
          h('br'), h('br'),
          '发出第一条消息之后，图谱里就会出现第一个块。')
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
    placeholder: '标签（可留空）',
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
        '暂时读不到会话内容，只显示了轮次骨架。切到「对话」再切回来可重试。')
    : null;

  /* 改动没存上：说清楚原因，但**不回滚**用户刚做的操作 */
  const saveHint = saveError
    ? h('div', { className: 'sg-hint sg-hint-warn' }, saveError + '（改动仍在本页生效）')
    : null;

  const detail = selectedEdge
    ? buildEdgeDetail()
    : (selected ? buildDetail() : h('div', { className: 'sg-emptybox' },
      '家族 ' + (graph.error ? 0 : graph.stats.sessions) + ' 个会话 · ' +
      (graph.error ? 0 : graph.stats.blocks) + ' 个块',
      h('br'), h('br'),
      '点一个块看它的提问与回答；双击块从那里分叉。'));

  function buildEdgeDetail() {
    const e = edgeList.find((x) => x.id === selectedEdge);
    if (!e) return h('div', { className: 'sg-emptybox' }, '这条连线已经不在了。');
    const nameOf = (id) => {
      const n = nodeMap.get(id);
      if (!n) return id + '（已不存在）';
      if (n.kind === 'header') return n.title;
      const b = n.block;
      return '第 ' + b.turn + ' 轮 · ' + (b.alias || clip(digest(b.prompt), 20) || b.sessionTitle);
    };
    return [
      h('div', { key: 'hd', className: 'sg-side-hd' },
        h('span', { className: 'sg-t' }, e.kind === 'reference' ? '引用连线' : '手动连线'),
        h('button', { className: 'sg-x', onClick: () => setSelectedEdge(null) }, '✕')),
      h('div', { key: 'meta', className: 'sg-side-meta' },
        h('div', { className: 'sg-lb' }, '连线'),
        h('div', { className: 'sg-meta' },
          h('span', { className: 'sg-k' }, '起点'), h('span', { className: 'sg-v' }, nameOf(e.from)),
          h('span', { className: 'sg-k' }, '终点'), h('span', { className: 'sg-v' }, nameOf(e.to)),
          e.broken
            ? [h('span', { key: 'k', className: 'sg-k' }, '状态'),
              h('span', { key: 'v', className: 'sg-v' }, '端点已不存在')]
            : null)),
      h('div', { key: 'acts', className: 'sg-side-acts' },
        h('button', {
          className: 'sg-act sg-danger',
          onClick: () => removeLink(e.id)
        }, '✕ 删除这条连线')),
      h('div', { key: 'bd', className: 'sg-side-bd' },
        h('div', { className: 'sg-sec' },
          h('div', { className: 'sg-lb' }, '标签'),
          h('input', {
            className: 'sg-linkdraft-in sg-wide',
            maxLength: 120,
            placeholder: '（无标签）',
            value: e.label || '',
            onChange: (ev) => labelLink(e.id, ev.target.value)
          }),
          h('div', { className: 'sg-tx' }, '留空即无标签。同一对块之间可以有多条连线。')))
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
        h('span', { className: 'sg-t' }, '第 ' + b.turn + ' 轮'),
        h('span', { className: 'sg-s' }, b.sessionTitle),
        h('button', { className: 'sg-x', onClick: () => setSelected(null) }, '✕')),
      /* 固定区：元信息 —— 无论正文多长都看得见 */
      h('div', { key: 'meta', className: 'sg-side-meta' },
        renaming && renaming.id === b.id
          ? h('div', { className: 'sg-sec' },
            h('div', { className: 'sg-lb' }, '重命名'),
            h('input', {
              className: 'sg-linkdraft-in sg-rename-in',
              autoFocus: true,
              maxLength: 120,
              placeholder: '新名称（留空恢复自动标题）',
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
            h('div', { className: 'sg-tx' }, '别名优先于自动标题，图谱上带 ✎ 前缀。'))
          : null,
        h('div', { className: 'sg-lb' }, '元信息'),
        h('div', { className: 'sg-meta' },
          h('span', { className: 'sg-k' }, '会话'), h('span', { className: 'sg-v' }, b.sessionTitle),
          h('span', { className: 'sg-k' }, '轮次'), h('span', { className: 'sg-v' },
            b.turn + (total ? ' / 共 ' + total + ' 轮' : '')),
          h('span', { className: 'sg-k' }, '状态'), h('span', { className: 'sg-v' },
            open ? '进行中' : b.status === 'failed' ? '失败' : '已完成'),
          h('span', { className: 'sg-k' }, '工具调用'), h('span', { className: 'sg-v' }, String(b.toolCalls)),
          h('span', { className: 'sg-k' }, '交付物'), h('span', { className: 'sg-v' },
            b.deliverables ? String(b.deliverables) : '—'))),
      /* 固定区：操作 —— 越长的正文越不该把按钮顶出去 */
      h('div', { key: 'acts', className: 'sg-side-acts' },
        h('button', {
          className: 'sg-act sg-primary', disabled: open,
          title: open ? '该轮尚未结束' : '也可以直接双击块',
          onClick: () => doFork(b.sessionId, b.turn)
        }, '⑂ 从这里分叉'),
        h('button', {
          className: 'sg-act',
          onClick: () => setLinking({ from: b.id, mode: 'click' })
        }, '→ 连接到…'),
        h('button', {
          className: 'sg-act',
          onClick: () => setRenaming({ id: b.id, value: alias[b.id] || '' })
        }, '✎ 重命名'),
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
        }, hidden[b.id] ? '⊘ 取消隐藏' : '⊘ 隐藏此块'),
        h('button', {
          className: 'sg-act',
          onClick: () => openSession(b.sessionId)
        }, '◻ 切换到该会话')),
      /* 唯一滚动的区域：正文 */
      h('div', { key: 'bd', className: 'sg-side-bd' },
        h('div', { className: 'sg-sec' },
          h('div', { className: 'sg-lb' }, '提问'),
          b.prompt ? markdownBlock(b.prompt, 'q') : h('div', { className: 'sg-tx' }, '（未载入）')),
        h('div', { className: 'sg-sec' },
          h('div', { className: 'sg-lb' }, '回答'),
          b.response ? markdownBlock(b.response, 'a') : h('div', { className: 'sg-tx' }, '（未载入）')))
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
        h('button', { className: 'sg-btn', onClick: fit }, '适应视图 F'),
        h('button', {
          className: 'sg-btn' + (showHidden ? ' sg-on' : ''),
          onClick: () => setShowHidden(!showHidden)
        }, '显示已隐藏'),
        h('button', {
          className: 'sg-btn' + (collapseOthers ? ' sg-on' : ''),
          onClick: () => setCollapseOthers(!collapseOthers)
        }, '折叠其他会话'),
        h('button', { className: 'sg-btn', onClick: () => setExportOpen(true) }, '↧ 导出'),
        h('button', {
          className: 'sg-btn',
          disabled: !canUndo,
          title: canUndo ? '撤销上一步（Ctrl+Z）' : '没有可撤销的操作',
          onClick: undo
        }, '↶ 撤销'),
        (!writable || incompatible)
          ? h('span', {
            className: 'sg-ro',
            title: incompatible
              ? '存档由更新的版本写入，本版本不会覆盖它'
              : '存储不可用，改动不会被保存'
          }, incompatible ? '存档版本不兼容 · 只读' : '只读')
          : null,
        h('span', { className: 'sg-zoom' }, Math.round(view.scale * 100) + '%')),
      h('div', { className: 'sg-hint' },
        linking
          ? (linking.mode === 'drag'
            ? '拖到另一个块并松手建立连线 · 松在空白处取消 · Esc 取消'
            : '点击另一个块完成连线 · Esc 取消')
          : '滚轮缩放 · 拖空白平移 · 单击块看详情 · 双击块分叉 · 拖块右下圆点连线 · F 适应视图'),
      contentHint,
      saveHint,
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
          h('span', { className: 'sg-t' }, '导出会话图谱'),
          h('span', { className: 'sg-s' }, filename),
          h('button', { className: 'sg-x', onClick: () => setExportOpen(false) }, '✕')),
        h('div', { className: 'sg-dlg-bd' },
          h('div', { className: 'sg-row' },
            h('span', { className: 'sg-lb' }, '格式'),
            h('div', { className: 'sg-seg' },
              h('button', { 'aria-pressed': exportFmt === 'mm' ? 'true' : 'false', onClick: () => setExportFmt('mm') },
                'FreeMind .mm'),
              h('button', { 'aria-pressed': exportFmt === 'md' ? 'true' : 'false', onClick: () => setExportFmt('md') },
                'Markdown .md')),
            h('span', { className: 'sg-s' },
              exportFmt === 'mm' ? '可导入 XMind / MindManager / Freeplane' : '可导入 XMind / Obsidian')) ,
          h('div', { className: 'sg-row' },
            h('span', { className: 'sg-lb' }, '范围'),
            h('label', { className: 'sg-chk' },
              h('input', {
                type: 'checkbox', checked: exportHidden,
                onChange: (e) => setExportHidden(!!e.target.checked)
              }), '包含已隐藏的块'),
            skipped && !exportHidden
              ? h('span', { className: 'sg-s' }, '有 ' + skipped + ' 个块因被隐藏而未导出')
              : null),
          h('div', { className: 'sg-row' },
            h('span', { className: 'sg-lb' }, '预览'),
            h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { className: 'sg-prev' }, preview))),
          errorText ? h('div', { className: 'sg-err' }, '生成失败：' + errorText) : null),
        h('div', { className: 'sg-dlg-ft' },
          h('span', { className: 'sg-hi' },
            '块内用「问」「答」两段区分用户提问与助手回答；分叉会话挂在它的分叉源块之下。'),
          h('button', {
            className: 'sg-bigbtn',
            onClick: () => {
              try {
                const out = exportText(exportFmt, exportHidden);
                if (navigator && navigator.clipboard) navigator.clipboard.writeText(out.content);
                say('已复制到剪贴板');
              } catch { say('复制失败，可手动选中预览区'); }
            }
          }, '复制'),
          h('button', { className: 'sg-bigbtn sg-primary', onClick: doDownload }, '下载文件'))));
  }
}

/* ------------------------------------------------------------ 插件入口 */

function apply(ctx) {
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
    label: () => '图谱',
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

return { inject: ['slots', 'sessions', 'uiSession', 'uiConversation'], apply };
