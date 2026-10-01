/**
 * 会话图谱 · 导出
 *
 * FR-15：把图谱导出为思维导图软件可导入的格式。
 * 核心约束——**一个块在导出结果里是同一个节点，节点内部区分用户提问与助手回答**。
 *
 * `.mm` 用三层保底（同一份文本，任何一层都不缺内容）：
 *   1. richcontent NODE —— 支持节点富文本的工具直接看到「问」「答」两段
 *   2. richcontent NOTE —— 大多数工具显示备注，作为保底
 *   3. TEXT 里的提问截断 —— 连备注都不显示的工具至少能看到提问
 *
 * `.md` 里同一个块是一个列表项，其下 `**问**` / `**答**` 两个子项，
 * 正文以**缩进块**原样嵌入 —— 这样正文里的表格、代码块、列表才能正确渲染。
 */

import { clip, plain, sessionOfId, summarize, tidy } from './model.js';

export const FORMATS = ['mm', 'md'];

/**
 * XML 1.0 的 Char 不允许的字符：C0 控制字符（\t \n \r 例外）与 U+FFFE/U+FFFF。
 *
 * 真实会话正文里带着 ANSI 转义（ESC = U+001B）与 NUL，只转义 & < > " ' 是拦不住它们的 ——
 * 结果是**整个 .mm 文件都不是合法 XML**（不是少一行，是解析器直接罢工）。
 * 所以这里直接丢掉，而不是换成实体：这些字符在思维导图里也没有任何可显示的含义。
 */
const XML_ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

const escXml = (v) => String(v === undefined || v === null ? '' : v)
  .replace(XML_ILLEGAL, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

/**
 * Markdown 行内标记 → FreeMind richcontent 认的 HTML。
 *
 * `.mm` 的 richcontent 是 **HTML**，不是 Markdown。不转换的话，思维导图里会
 * 原样显示 `**DSH**`、`| 层 | 依赖 |` 这些源码。先转义再做替换，顺序不能反。
 */
function inlineHtml(text) {
  return escXml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * 表格分隔行（`|---|---|`）在思维导图里只是噪声，丢掉。
 *
 * 必须**同时**含 `|` 才算分隔行：早先只按"字符全在 [\s:|-] 里且至少一个 -"判断，
 * 于是 `---`、`--` 这类 Markdown 水平线也被当成表格规则吃掉 —— 那是一行真内容。
 */
const isTableRule = (line) =>
  line.includes('|') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line);

/**
 * 把一段 Markdown 正文逐行转成 `<p>`，首行带标签（如「问」）。返回**数组**，
 * 由调用方决定怎么分行输出 —— 行拆开之后 `.mm` 才 diff 得动、预览也读得了。
 *
 * 空行与表格分隔行跳过（空 `<p>` 在多数思维导图软件里会渲染成一行空白）；
 * 围栏代码换成等宽段落并丢掉 ``` 标记 —— 在导图里那三个反引号只是噪声，
 * 且围栏内不能再套行内标记，否则代码里的 `**` 会被吃掉。
 */
function paragraphList(text, label) {
  const out = [];
  const push = (html) => {
    const head = out.length === 0 ? `<b>${escXml(label)}</b>　` : '';
    out.push(`<p>${head}${html}</p>`);
  };

  let fenced = false;
  tidy(text).split('\n').forEach((raw) => {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) {
      if (line !== '') push(`<font face="Courier New, monospace">${escXml(raw.replace(/\s+$/, ''))}</font>`);
      return;
    }
    if (line === '' || isTableRule(line)) return;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    push(heading ? `<b>${inlineHtml(heading[1])}</b>` : inlineHtml(line.replace(/^>\s?/, '')));
  });

  if (out.length === 0) out.push(`<p><b>${escXml(label)}</b></p>`);   /* 正文为空也要留一格 */
  return out;
}

/** 把多行文本整体缩进 n 个空格，供 Markdown 列表项内部嵌入块内容 */
function indentBlock(text, n) {
  const pad = ' '.repeat(n);
  return tidy(text).split('\n').map((line) => (line === '' ? '' : pad + line)).join('\n');
}

/** 时间戳，`YYYY-MM-DD HH:mm` */
export function stamp(at) {
  const d = at instanceof Date ? at : new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 去掉孤立代理码元。
 *
 * 截断救不了输入本身就畸形的标题（正文被截过、上游拼接出错等），
 * 而孤立代理会让 encodeURIComponent 抛 URIError —— 下载链接根本拼不出来。
 */
const stripLoneSurrogates = (s) => s
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
  .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1');

/**
 * 文件名安全化：路径非法字符替换、长度截断、空标题回落。
 *
 * 截断必须按**码点**，不能按 UTF-16 码元：`'x'.repeat(59) + '😀'` 这类标题
 * 切在 60 个码元上会留下半个代理对（0xD83D），随后 encodeURIComponent 抛 URIError。
 */
export function safeFilename(title, fallback = 'session-graph') {
  const base = plain(title).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  return stripLoneSurrogates([...(base || fallback)].slice(0, 60).join(''));
}

/** 导出文件名：`会话图谱-<家族根标题>.mm|.md` */
export function exportFilename(graph, format) {
  const root = graph.sessions.find((s) => s.id === graph.rootId);
  const base = safeFilename(root ? root.title : '', '会话图谱');
  return `会话图谱-${base}.${format === 'md' ? 'md' : 'mm'}`;
}

/* ---------------------------------------------------------------- 树装配 */

/**
 * 把图模型装配成导出树。
 *
 * - 分叉出来的会话挂在**它的分叉源块**之下（真正的树，不平级）
 * - 引用式会话挂在源块之下，带虚线边标记
 * - 手动连线和引用连线在 `.mm` 里是 arrowlink，在 `.md` 里另起清单
 *
 * @param {object} graph buildGraph 结果
 * @param {object} [options] { links: [{id, from, to, label, kind, route, xr}] }
 */
export function buildTree(graph, options = {}) {
  const links = options.links || [];
  const bySession = new Map(graph.sessions.map((s) => [s.id, s]));
  const blocksOf = (sid) => graph.blocks.filter((b) => b.sessionId === sid);
  const childrenAt = (sid, turn) =>
    graph.sessions.filter((s) => s.parentId === sid && s.forkAtTurn === turn);
  /**
   * 挂在会话层、而不是某个块下面的子会话。
   *
   * 包括两类：分叉源轮次未知（forkAtTurn 为 null），以及分叉源轮次不在可见块里
   * （被隐藏、或尚未载入）。**没有这一层，这两种子会话会在导出结果里整个消失。**
   */
  const leftoverChildren = (sid) => {
    const visibleTurns = new Set(blocksOf(sid).map((b) => b.turn));
    return graph.sessions.filter((s) => s.parentId === sid
      && (s.forkAtTurn === null || s.forkAtTurn === undefined || !visibleTurns.has(s.forkAtTurn)));
  };
  const refsAt = (blockIdValue) =>
    links.filter((l) => l.kind === 'reference' && l.from === blockIdValue)
      /* 终点可能是某个块（`sid:turn`），也可能是整个会话（`header:sid`）——
         引用式新建出来的会话还没有轮次，只能指向会话本身。 */
      .map((l) => sessionOfId(l.to))
      .filter((sid) => bySession.has(sid));

  /* 家族根：没有父、或父不在家族内的会话。
     被引用拉进来的会话不算根 —— 它们挂在源块之下（refsAt），
     否则同一个会话会在导出结果里出现两遍。 */
  const pulled = new Set(graph.referenced || []);
  const baseRoots = graph.order
    .map((id) => bySession.get(id))
    .filter((s) => s && !pulled.has(s.id) && (!s.parentId || !bySession.has(s.parentId)));

  const childrenOf = new Map();
  graph.sessions.forEach((s) => {
    if (!s.parentId) return;
    if (!childrenOf.has(s.parentId)) childrenOf.set(s.parentId, []);
    childrenOf.get(s.parentId).push(s.id);
  });

  /* 哪些会话真的会被画出来？从根往下走一遍：子会话全部会挂上，而**只有可见块的
     引用连线才拉得动会话** —— 源块被隐藏时 buildGraph 根本不生成那条引用边（FR-11）。
     早先没有这一步，只把"源块 id 命中"当唯一出口：源块一被隐藏，被引用的会话
     既不是根、也没有挂载点，于是一整个会话从 .mm/.md 里消失，连一句提示都没有。 */
  const live = new Set();
  const mark = (seed) => {
    const stack = seed.map((s) => s.id);
    while (stack.length) {
      const sid = stack.pop();
      if (!sid || live.has(sid) || !bySession.has(sid)) continue;
      live.add(sid);
      (childrenOf.get(sid) || []).forEach((id) => stack.push(id));
      blocksOf(sid).forEach((b) => refsAt(b.id).forEach((id) => stack.push(id)));
    }
  };
  mark(baseRoots);

  /* order 里的会话必须**恰好出现一次**：没被任何节点接住的（引用源块被隐藏、
     血缘成环谁也不是根）补成根，绝不静默丢节点。 */
  const extraRoots = graph.order
    .map((id) => bySession.get(id))
    .filter((s) => s && !live.has(s.id));
  mark(extraRoots);
  const roots = [...baseRoots, ...extraRoots];

  /* 同一个会话只能出现在一处：补出来的根与树内挂载可能指向同一个会话
     （成环、同一条引用被多块引用），渲染期用这个集合兜住"恰好一次"。 */
  const rendered = new Set();
  const enter = (sid) => {
    if (rendered.has(sid)) return false;
    rendered.add(sid);
    return true;
  };

  const skipped = [];
  const keptLinks = [];
  /* 只有真的会被输出的块才算"可见"。按 graph.blocks 判断会造出指向不存在节点的
     `<arrowlink DESTINATION>` —— 悬空目标在思维导图里是硬错误，不是少画一条线。 */
  const visible = new Set(graph.blocks.filter((b) => live.has(b.sessionId)).map((b) => b.id));
  links.forEach((l) => {
    if (l.kind === 'reference') return;                       /* 引用关系已由树结构表达 */
    if (visible.has(l.from) && visible.has(l.to)) keptLinks.push(l);
    else skipped.push(l);
  });

  const linkFrom = new Map();
  keptLinks.forEach((l) => {
    if (!linkFrom.has(l.from)) linkFrom.set(l.from, []);
    linkFrom.get(l.from).push(l);
  });

  return {
    roots, blocksOf, childrenAt, leftoverChildren, refsAt, keptLinks, linkFrom, skipped, enter,
    /* 被引用拉进来、却因源块不可见而只能当根的会话：导出里要给出诚实提示 */
    promotedRoots: extraRoots.filter((s) => pulled.has(s.id))
  };
}

/* ------------------------------------------------------------------ .mm */

/**
 * FreeMind `.mm`（XML）。可导入 XMind / MindManager / Freeplane / MindMeister。
 * @returns {{ content: string, filename: string }}
 */
export function toFreeMind(graph, options = {}) {
  const tree = buildTree(graph, options);
  const ids = new Map();
  let uid = 0;
  const idOf = (key) => {
    if (!ids.has(key)) ids.set(key, `ID_${1000000000 + (++uid)}`);
    return ids.get(key);
  };
  const pad = (d) => '  '.repeat(d);
  const out = [];

  /* 富文本**逐行**输出：整段挤成一行时，文件没法 diff，导出预览也只能横向裁切 */
  function rich(type, depth, parts) {
    out.push(`${pad(depth)}<richcontent TYPE="${type}"><html><body>`);
    parts.forEach((p) => out.push(`${pad(depth + 1)}${p}`));
    out.push(`${pad(depth)}</body></html></richcontent>`);
  }

  function blockNode(block, depth) {
    const title = block.alias
      ? `✎ ${block.alias}`
      : `第 ${block.turn} 轮 · ${clip(summarize(block.prompt), 24)}`;
    const bg = block.current ? ' BACKGROUND_COLOR="#e4edfd"' : '';
    out.push(`${pad(depth)}<node TEXT="${escXml(title)}" ID="${idOf(block.id)}"${bg}>`);
    /* 第 1 层：节点富文本里「问」「答」两段（正文里的换行原样保留） */
    rich('NODE', depth + 1, [
      ...paragraphList(block.prompt, '问'),
      ...paragraphList(block.response, '答')
    ]);
    /* 第 2 层：备注里的全文与元信息 */
    rich('NOTE', depth + 1, [
      ...paragraphList(block.prompt, '问：'),
      ...paragraphList(block.response, '答：'),
      `<p>元信息：${escXml(block.sessionTitle)} · 第 ${block.turn} 轮 · ` +
      `${block.toolCalls} 个工具 · ${block.deliverables} 个交付物</p>`
    ]);
    if (block.status === 'open') out.push(`${pad(depth + 1)}<icon BUILTIN="hourglass"/>`);
    if (block.status === 'failed') out.push(`${pad(depth + 1)}<icon BUILTIN="messagebox_warning"/>`);
    if (block.deliverables) out.push(`${pad(depth + 1)}<icon BUILTIN="attach"/>`);

    /* 手动连线 → 箭头链接（FreeMind 格式没有边标签，标签另见根备注） */
    (tree.linkFrom.get(block.id) || []).forEach((l) => {
      out.push(`${pad(depth + 1)}<arrowlink DESTINATION="${idOf(l.to)}" COLOR="#4176e6" ` +
        `STARTARROW="None" ENDARROW="Default"/>`);
    });

    tree.childrenAt(block.sessionId, block.turn).forEach((s) => sessionNode(s, depth + 1, 'fork'));
    tree.refsAt(block.id).forEach((sid) => sessionNode(byIdSafe(sid), depth + 1, 'ref'));
    out.push(`${pad(depth)}</node>`);
  }

  function byIdSafe(sid) { return graph.sessions.find((s) => s.id === sid); }

  function sessionNode(s, depth, mode) {
    if (!s) return;
    /* 同一个会话只画一次：补出来的根与树内挂载可能指向同一个会话（成环、重复引用） */
    if (!tree.enter(s.id)) return;
    const ref = mode === 'ref';
    const label = ref && /^引用[:：]/.test(s.title) ? s.title : (ref ? `引用：${s.title}` : s.title);
    out.push(`${pad(depth)}<node TEXT="${escXml(label)}" ID="${idOf(`S:${s.id}`)}">`);
    if (ref) {
      out.push(`${pad(depth + 1)}<edge COLOR="#81858c" STYLE="dash"/>`);
      out.push(`${pad(depth + 1)}<icon BUILTIN="bookmark"/>`);
    }
    const mine = tree.blocksOf(s.id);
    if (!mine.length) {
      out.push(`${pad(depth + 1)}<node TEXT="空子会话 · 尚未提问" ID="${idOf(`E:${s.id}`)}"/>`);
    } else {
      mine.forEach((b) => blockNode(b, depth + 1));
    }
    /* 分叉源轮次未知或不可见的孩子挂在会话层，绝不丢节点 */
    tree.leftoverChildren(s.id).forEach((c) => sessionNode(c, depth + 1, 'fork'));
    out.push(`${pad(depth)}</node>`);
  }

  /* 合成根：承载家族全部根会话，并在备注里写导出说明 */
  const rootLabel = tree.roots.map((s) => s.title).join(' / ') || '会话图谱';
  out.push(`<node TEXT="${escXml('会话图谱 · ' + rootLabel)}" ID="${idOf('ROOT')}">`);
  tree.roots.forEach((s) => sessionNode(s, 1, 'fork'));

  const note = [
    `导出时间：${options.stamp || stamp()}`,
    `会话 ${graph.stats.sessions} 个 · 块 ${graph.stats.blocks} 个`,
    '每个块内用「问」「答」两段区分用户提问与助手回答。',
    '分叉出来的会话挂在它的分叉源块之下；手动连线导出为箭头链接。'
  ];
  if (graph.stats.hiddenSkipped) note.push(`有 ${graph.stats.hiddenSkipped} 个块因被隐藏而未导出。`);
  /* 引用源块被隐藏时，被引用的会话只能当根 —— 这件事必须说出来，不能悄悄改变结构 */
  if (tree.promotedRoots.length) {
    note.push(`有 ${tree.promotedRoots.length} 个被引用的会话因源块不可见，已作为根导出。`);
  }
  tree.keptLinks.forEach((l) => note.push(`连线：${l.from} → ${l.to}${l.label ? `（${l.label}）` : ''}`));
  tree.skipped.forEach((l) => note.push(`未导出的连线：${l.from} → ${l.to}${l.label ? `（${l.label}）` : ''}`));
  rich('NOTE', 1, note.map((n) => `<p>${escXml(n)}</p>`));
  out.push('</node>');

  const content = '<map version="1.0.1">\n' +
    `<!-- 「会话图谱」导出 · ${options.stamp || stamp()} · ` +
    `${graph.stats.sessions} 个会话 / ${graph.stats.blocks} 个块 -->\n` +
    out.join('\n') + '\n</map>\n';
  return { content, filename: exportFilename(graph, 'mm') };
}

/* ------------------------------------------------------------------ .md */

/**
 * Markdown 大纲。可导入 XMind（Markdown）、Obsidian 与任意大纲工具。
 * @returns {{ content: string, filename: string }}
 */
export function toMarkdown(graph, options = {}) {
  const tree = buildTree(graph, options);
  const ind = (d) => '  '.repeat(d);
  const out = [];
  const rootLabel = tree.roots.map((s) => s.title).join(' / ') || '会话图谱';

  out.push(`# 会话图谱 · ${rootLabel}`, '');
  out.push(`> 导出时间 ${options.stamp || stamp()} · 会话 ${graph.stats.sessions} 个 · 块 ${graph.stats.blocks} 个`);
  out.push('>');
  out.push('> 每个块内用 **问** / **答** 两段区分用户提问与助手回答，正文按其原有 Markdown 结构缩进呈现。', '');
  /* 引用源块被隐藏时，被引用的会话只能当根 —— 这件事必须说出来，不能悄悄改变结构 */
  if (tree.promotedRoots.length) {
    out.push(`> 有 ${tree.promotedRoots.length} 个被引用的会话因源块不可见，已作为根导出。`, '');
  }

  function blockItem(block, depth) {
    const alias = block.alias ? `（${block.alias}）` : '';
    out.push(`${ind(depth)}- **第 ${block.turn} 轮**${alias}`, '');
    /* 正文以缩进块嵌入，而不是拼在 `- **问**：` 后面 ——
       拼在后面会让表格、代码块、多段列表全塌成一行。 */
    out.push(`${ind(depth + 1)}- **问**`, '');
    out.push(indentBlock(block.prompt, (depth + 2) * 2), '');
    out.push(`${ind(depth + 1)}- **答**`, '');
    out.push(indentBlock(block.response, (depth + 2) * 2), '');
    out.push(`${ind(depth + 1)}- *${block.sessionTitle} · ${block.toolCalls} 个工具 · ${block.deliverables} 个交付物*`, '');
    tree.childrenAt(block.sessionId, block.turn).forEach((s) => sessionItem(s, depth + 1, 'fork'));
    tree.refsAt(block.id).forEach((sid) =>
      sessionItem(graph.sessions.find((s) => s.id === sid), depth + 1, 'ref'));
  }

  function sessionItem(s, depth, mode) {
    if (!s) return;
    /* 同一个会话只列一次：补出来的根与树内挂载可能指向同一个会话（成环、重复引用） */
    if (!tree.enter(s.id)) return;
    const mark = mode === 'ref' ? '🔗 引用' : '⑂ 分叉';
    const label = mode === 'ref' ? s.title.replace(/^引用[:：]\s*/, '') : s.title;
    out.push(`${ind(depth)}- **${mark} → ${label}**`);
    const mine = tree.blocksOf(s.id);
    if (!mine.length) out.push(`${ind(depth + 1)}- *空子会话 · 尚未提问*`);
    else mine.forEach((b) => blockItem(b, depth + 1));
    tree.leftoverChildren(s.id).forEach((c) => sessionItem(c, depth + 1, 'fork'));
  }

  tree.roots.forEach((s) => {
    /* 补根与树内挂载可能撞到同一个会话：先到先画，后到的跳过 */
    if (!tree.enter(s.id)) return;
    out.push(`## ${s.title}`, '');
    tree.blocksOf(s.id).forEach((b) => blockItem(b, 0));
    tree.leftoverChildren(s.id).forEach((c) => sessionItem(c, 0, 'fork'));
    out.push('');
  });

  if (tree.keptLinks.length) {
    out.push('---', '', '## 手动连线', '');
    tree.keptLinks.forEach((l) =>
      out.push(`- \`${l.from}\` —${l.label ? ` **${l.label}** ` : ' '}→ \`${l.to}\``));
    out.push('');
  }
  if (tree.skipped.length) {
    out.push('---', '', '## 未导出的连线（端点被隐藏）', '');
    tree.skipped.forEach((l) =>
      out.push(`- \`${l.from}\` → \`${l.to}\`${l.label ? `（${l.label}）` : ''}`));
    out.push('');
  }

  const content = out.join('\n');
  return { content, filename: exportFilename(graph, 'md') };
}

/** 统一入口 */
export function render(graph, format, options = {}) {
  return format === 'md' ? toMarkdown(graph, options) : toFreeMind(graph, options);
}
