/**
 * 会话图谱 · 界面文案（NFR-3）
 *
 * 全部文案集中在这里，`zh` / `en` 成对出现。
 * 取值走宿主的本地化服务（`ctx.locale.resolveText`），它按当前语言解析、
 * **缺键回退英文** —— 正是 NFR-3 的第三条要求。
 * 为了在没有宿主服务时也能工作（测试、降级），这里同样实现了同一套回退链。
 *
 * 字典集中放还有个副作用：可以写测试断言**每个键都有 zh 与 en 且非空**，
 * 这是散落在各处改文案时拿不到的保证。
 *
 * 纯函数，无副作用。
 */

/** 界面文案字典。`{name}` 是插值占位符。 */
export const UI = {
  'view.title': { zh: '图谱', en: 'Graph' },

  /* ---- 工具条 ---- */
  'toolbar.fit': { zh: '适应视图 F', en: 'Fit view (F)' },
  'toolbar.showHidden': { zh: '显示已隐藏', en: 'Show hidden' },
  'toolbar.collapseOthers': { zh: '折叠其他会话', en: 'Collapse other sessions' },
  'toolbar.export': { zh: '↧ 导出', en: '↧ Export' },
  'toolbar.undo': { zh: '↶ 撤销', en: '↶ Undo' },
  'toolbar.undoTip': { zh: '撤销上一步（Ctrl+Z）', en: 'Undo the last change (Ctrl+Z)' },
  'toolbar.nothingToUndo': { zh: '没有可撤销的操作', en: 'Nothing to undo' },

  /* ---- 提示条 ---- */
  'hint.idle': {
    zh: '滚轮缩放 · 拖空白平移 · 单击块看详情 · 双击块分叉 · 拖块右下圆点连线 · F 适应视图',
    en: 'Scroll to zoom · drag empty space to pan · click a block for details · double-click to fork · drag the corner dot to link · F to fit'
  },
  'hint.linkingDrag': {
    zh: '拖到另一个块并松手建立连线 · 松在空白处取消 · Esc 取消',
    en: 'Drop on another block to link · release on empty space to cancel · Esc to cancel'
  },
  'hint.linkingClick': {
    zh: '点击另一个块完成连线 · Esc 取消',
    en: 'Click another block to finish the link · Esc to cancel'
  },
  'hint.saveFailedSuffix': { zh: '（改动仍在本页生效）', en: ' (your change still applies on this page)' },
  'hint.partialContent': {
    zh: '暂时读不到会话内容，只显示了轮次骨架。切到「对话」再切回来可重试。',
    en: 'Session content is temporarily unreadable; only the turn skeleton is shown. Switch to Chat and back to retry.'
  },

  /* ---- 只读 / 存储 ---- */
  'ro.readonly': { zh: '只读', en: 'Read-only' },
  'ro.incompatible': { zh: '存档版本不兼容 · 只读', en: 'Incompatible save format · read-only' },
  'ro.incompatibleTip': {
    zh: '存档由更新的版本写入，本版本不会覆盖它',
    en: 'The save was written by a newer version; this version will not overwrite it'
  },
  'ro.noStorage': { zh: '存储不可用，改动不会被保存', en: 'Storage unavailable; changes will not be saved' },
  'ro.writeFailedIncompatible': {
    zh: '存档由更新的版本写入，本次改动未保存',
    en: 'The save was written by a newer version; this change was not saved'
  },
  'ro.writeFailed': { zh: '改动未能保存', en: 'Could not save the change' },

  /* ---- 连线 ---- */
  'link.self': { zh: '不能把一个块连到它自己', en: 'A block cannot be linked to itself' },
  'link.handleTip': { zh: '拖到另一个块建立连线', en: 'Drag onto another block to link' },
  'link.labelPlaceholder': { zh: '标签（可留空）', en: 'Label (optional)' },
  'link.created': { zh: '已新建引用式会话', en: 'Reference session created' },
  'link.kindManual': { zh: '手动连线', en: 'Manual link' },
  'link.kindReference': { zh: '引用连线', en: 'Reference link' },
  'link.sectionTitle': { zh: '连线', en: 'Link' },
  'link.from': { zh: '起点', en: 'From' },
  'link.to': { zh: '终点', en: 'To' },
  'link.status': { zh: '状态', en: 'Status' },
  'link.endpointGone': { zh: '端点已不存在', en: 'Endpoint no longer exists' },
  'link.delete': { zh: '✕ 删除这条连线', en: '✕ Delete this link' },
  'link.label': { zh: '标签', en: 'Label' },
  'link.noLabel': { zh: '（无标签）', en: '(no label)' },
  'link.labelHelp': {
    zh: '留空即无标签。同一对块之间可以有多条连线。',
    en: 'Leave empty for no label. Multiple links between the same pair of blocks are allowed.'
  },
  'link.gone': { zh: '这条连线已经不在了。', en: 'This link no longer exists.' },
  'link.missing': { zh: '（已不存在）', en: ' (no longer exists)' },

  /* ---- 分叉 ---- */
  'fork.openTurn': { zh: '该轮尚未结束，不能从这里分叉', en: 'This turn has not finished; cannot fork from here' },
  'fork.noBoundary': {
    zh: '这一轮没有可用的分叉边界，可能尚未载入',
    en: 'No usable fork boundary for this turn; it may not be loaded yet'
  },
  'fork.noneAvailable': { zh: '没有可用的已完成轮次', en: 'No completed turn available' },
  'fork.sourceUnavailable': { zh: '源会话不可用，请刷新图谱', en: 'The source session is unavailable; refresh the graph' },
  'fork.failed': { zh: '分叉失败：{msg}', en: 'Fork failed: {msg}' },
  'fork.done': { zh: '已从第 {turn} 轮分叉', en: 'Forked from turn {turn}' },
  'fork.action': { zh: '⑂ 从这里分叉', en: '⑂ Fork from here' },
  'fork.hint': { zh: '也可以直接双击块', en: 'You can also double-click the block' },
  'fork.turnOpen': { zh: '该轮尚未结束', en: 'This turn is still running' },

  /* ---- 块与详情 ---- */
  'block.turn': { zh: '第 {turn} 轮', en: 'Turn {turn}' },
  'block.turnOf': { zh: '第 {turn} 轮 · {title}', en: 'Turn {turn} · {title}' },
  'block.ariaLabel': { zh: '第 {turn} 轮：{prompt}', en: 'Turn {turn}: {prompt}' },
  'block.noPrompt': { zh: '（该轮提问尚未载入）', en: '(prompt not loaded)' },
  'block.noResponse': { zh: '（该轮回答尚未载入）', en: '(response not loaded)' },
  'block.thin': { zh: '（这一轮的内容读不出来）', en: '(this turn’s content is unreadable)' },
  /* 还在取数时**不许说"读不出来"**：那是在指控数据丢失，而数据只是还在路上。
     用中性的载入文案，取数回来自然消失。 */
  'block.loading': { zh: '载入中…', en: 'Loading…' },
  'block.thinResponse': {
    zh: '元数据仍在，可正常连线与分叉',
    en: 'Metadata is intact; linking and forking still work'
  },
  'block.loadFull': { zh: '点击载入这一轮的完整内容', en: 'Click to load this turn in full' },
  'block.prompt': { zh: '提问', en: 'Prompt' },
  'block.response': { zh: '回答', en: 'Response' },
  'block.notLoaded': { zh: '（未载入）', en: '(not loaded)' },
  'block.emptyChild': { zh: '空子会话 · 尚未提问', en: 'Empty child session · no prompt yet' },

  'side.meta': { zh: '元信息', en: 'Details' },
  'side.session': { zh: '会话', en: 'Session' },
  'side.turn': { zh: '轮次', en: 'Turn' },
  'side.turnOfTotal': { zh: '{turn} / 共 {total} 轮', en: '{turn} of {total}' },
  'side.status': { zh: '状态', en: 'Status' },
  'side.statusOpen': { zh: '进行中', en: 'Running' },
  'side.statusFailed': { zh: '失败', en: 'Failed' },
  'side.statusDone': { zh: '已完成', en: 'Completed' },
  'side.toolCalls': { zh: '工具调用', en: 'Tool calls' },
  'side.deliverables': { zh: '交付物', en: 'Deliverables' },
  'side.switch': { zh: '◻ 切换到该会话', en: '◻ Switch to this session' },
  'side.empty': {
    zh: '家族 {sessions} 个会话 · {blocks} 个块',
    en: '{sessions} sessions · {blocks} blocks in this family'
  },
  'side.emptyHint': {
    zh: '点一个块看它的提问与回答；双击块从那里分叉。',
    en: 'Click a block to see its prompt and response; double-click to fork from it.'
  },

  /* ---- 操作 ---- */
  'act.rename': { zh: '✎ 重命名', en: '✎ Rename' },
  'act.hide': { zh: '⊘ 隐藏此块', en: '⊘ Hide this block' },
  'act.unhide': { zh: '⊘ 取消隐藏', en: '⊘ Unhide' },
  'act.connect': { zh: '→ 连接到…', en: '→ Connect to…' },
  'act.locate': { zh: '⌖ 在对话视图中定位该轮', en: '⌖ Locate this turn in Chat' },
  'act.newRef': { zh: '⧉ 新建引用式会话', en: '⧉ New reference session' },
  'act.renameTitle': { zh: '重命名', en: 'Rename' },
  'act.renamePlaceholder': { zh: '新名称（留空恢复自动标题）', en: 'New name (leave empty to restore the automatic title)' },
  'act.renameHelp': {
    zh: '别名优先于自动标题，图谱上带 ✎ 前缀。',
    en: 'The alias takes precedence over the automatic title and is marked with ✎ in the graph.'
  },

  /* ---- 会话头 ---- */
  'head.switchTip': { zh: '点击切换到这个会话', en: 'Click to switch to this session' },
  'head.archivedTip': { zh: '该会话已归档，无法切换', en: 'This session is archived and cannot be opened' },
  'head.archived': { zh: '该会话已归档，无法切换', en: 'This session is archived and cannot be opened' },
  'head.expand': { zh: '就地展开这个会话的块', en: 'Expand this session’s blocks in place' },
  'head.collapse': { zh: '收起这个会话的块', en: 'Collapse this session’s blocks' },
  'head.turnCount': { zh: '{n} 轮', en: '{n} turns' },

  /* ---- 图角状态 ---- */
  'corner.skeleton': {
    zh: '{n} 个块尚未载入 · 点击块即可载入',
    en: '{n} blocks not loaded yet · click a block to load it'
  },
  'corner.incomplete': { zh: '{n} 个块数据不完整', en: '{n} blocks have incomplete data' },
  'corner.broken': { zh: '{n} 条连线指向已不存在的块', en: '{n} links point to blocks that no longer exist' },
  /* 降级留痕：宿主形状对不上时插件会退一步继续，这里把"退过"说出来 */
  'corner.degraded': {
    zh: '降级 {n} 项 · 最近：{why}',
    en: '{n} degraded · latest: {why}'
  },

  /* ---- 状态面板 ---- */
  'state.errorTitle': { zh: '图谱没能装配起来', en: 'The graph could not be assembled' },
  'state.errorHelp': {
    zh: '图谱以外的功能不受影响。若反复失败，请把下面这行一并反馈：',
    en: 'Everything outside the graph still works. If this keeps happening, please report the line below:'
  },
  'state.retry': { zh: '↻ 重试', en: '↻ Retry' },
  'state.assembling': { zh: '正在装配图谱…', en: 'Assembling the graph…' },
  'state.emptyTitle': { zh: '这个家族里还没有可显示的轮次', en: 'No turns to show in this family yet' },
  'state.emptyHelp': {
    zh: '发出第一条消息之后，图谱里就会出现第一个块。',
    en: 'Once you send the first message, the first block appears here.'
  },
  'state.goChat': { zh: '去对话视图开始提问', en: 'Go to Chat and ask something' },

  /* ---- 规模降级 ---- */
  'scale.dense': {
    zh: '块较多：为保持流畅已省略块内正文与边标签',
    en: 'Many blocks: block text and edge labels are omitted to keep things smooth'
  },
  'scale.skeleton': {
    zh: '块非常多：只画分叉骨架与当前会话，点会话头的 ▸ 展开其它会话',
    en: 'Very many blocks: only the fork skeleton and the current session are drawn; click ▸ on a session header to expand it'
  },
  'scale.slowLayout': { zh: '布局耗时超出预算，已回落简化布局', en: 'Layout exceeded its budget; fell back to a simplified layout' },

  /* ---- 引用式新建会话 ---- */
  'ref.noCreate': { zh: '当前宿主没有暴露新建会话的能力', en: 'This host does not expose session creation' },
  'ref.noWorkspace': { zh: '找不到这个会话所属的工作区，无法新建', en: 'Could not find the workspace for this session' },
  'ref.createFailed': { zh: '新建会话失败：{msg}', en: 'Could not create the session: {msg}' },
  'ref.noId': { zh: '新建会话失败：宿主没有返回会话 id', en: 'Could not create the session: the host returned no id' },
  'ref.navFailed': { zh: '引用式会话已建立，但没能自动切过去', en: 'The reference session was created, but could not be opened automatically' },

  /* ---- 跨会话跳转 ---- */
  'nav.noSwitch': { zh: '当前宿主没有暴露切换会话的能力', en: 'This host does not expose session switching' },
  'nav.switchFailed': { zh: '切换会话失败：{msg}', en: 'Could not switch sessions: {msg}' },
  'nav.noView': { zh: '当前宿主没有暴露切换视图的能力', en: 'This host does not expose view switching' },
  'nav.located': {
    zh: '已切到对话视图；本版本无法自动滚动，请找第 {turn} 轮',
    en: 'Switched to Chat; this version cannot scroll automatically — look for turn {turn}'
  },

  /* ---- 导出 ---- */
  'export.title': { zh: '导出会话图谱', en: 'Export the session graph' },
  'export.format': { zh: '格式', en: 'Format' },
  'export.mmHint': { zh: '可导入 XMind / MindManager / Freeplane', en: 'Imports into XMind / MindManager / Freeplane' },
  'export.mdHint': { zh: '可导入 XMind / Obsidian', en: 'Imports into XMind / Obsidian' },
  'export.scope': { zh: '范围', en: 'Scope' },
  'export.includeHidden': { zh: '包含已隐藏的块', en: 'Include hidden blocks' },
  'export.preview': { zh: '预览', en: 'Preview' },
  'export.generateFailed': { zh: '生成失败：{msg}', en: 'Could not generate: {msg}' },
  'export.help': {
    zh: '块内用「问」「答」两段区分用户提问与助手回答；分叉会话挂在它的分叉源块之下。',
    en: 'Inside each block, Q and A sections separate the prompt from the response; forked sessions hang under their fork source block.'
  },
  'export.download': { zh: '下载文件', en: 'Download' },
  'export.copied': { zh: '已复制到剪贴板', en: 'Copied to the clipboard' },
  'export.copyFailed': { zh: '复制失败，可手动选中预览区', en: 'Copy failed; select the preview manually' },
  'export.copy': { zh: '复制', en: 'Copy' },
  'export.copiedShort': { zh: '已复制', en: 'Copied' },
  'export.downloading': { zh: '已开始下载 {name}（本地生成）', en: 'Downloading {name} (generated locally)' },
  'export.failed': { zh: '导出失败：{msg}', en: 'Export failed: {msg}' },
  'export.hiddenNotExported': { zh: '有 {n} 个块因被隐藏而未导出', en: '{n} blocks were hidden and not exported' },

  /* ---- Markdown 渲染器标签 ---- */
  'md.code': { zh: '代码', en: 'Code' },
  'md.wrap': { zh: '自动换行', en: 'Wrap lines' },
  'md.unwrap': { zh: '不换行', en: 'No wrap' },
  'md.footnotes': { zh: '脚注', en: 'Footnotes' }
};

/** 缺省语言：字典缺键时回退到它（NFR-3 明确要求回退英文） */
export const FALLBACK_LOCALE = 'en';

/** 语言标签归一：`zh-CN` → `zh`，与宿主 localeKey 的语义一致 */
export function localeKey(locale) {
  return String(locale === undefined || locale === null ? '' : locale).toLowerCase();
}

/**
 * 当前语言的回退链：`zh-Hans-CN` → `zh-hans-cn, zh-hans, zh`。
 * 与宿主 `resolveText` 的 `fallbackChain` 同构。
 */
export function fallbackChain(active) {
  const key = localeKey(active);
  if (!key) return [];
  const parts = key.split('-');
  const chain = [];
  for (let i = parts.length; i > 0; i -= 1) chain.push(parts.slice(0, i).join('-'));
  return chain;
}

/**
 * 取一条文案。
 *
 * 与宿主 `LocaleService.resolveText` 同一套语义：字符串原样返回，
 * 对象按回退链逐级向下，最后落到 `en`。
 *
 * @param {{zh?: string, en?: string}|string} text
 * @param {string} active 当前语言
 * @returns {string}
 */
export function pick(text, active) {
  if (typeof text === 'string') return text;
  if (!text || typeof text !== 'object') return '';
  for (const loc of fallbackChain(active)) {
    const v = text[loc];
    if (typeof v === 'string' && v !== '') return v;
  }
  const en = text[FALLBACK_LOCALE];
  return typeof en === 'string' ? en : '';
}

/** `{name}` 插值；缺变量就原样留下占位符，方便一眼看出漏了什么 */
export function interpolate(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (
    vars[k] === undefined || vars[k] === null ? m : String(vars[k])
  ));
}

/**
 * 造一个取值函数。
 *
 * @param {string} active 当前语言
 * @param {(text: any) => string} [resolver] 宿主的解析器；给了就用它，
 *        这样文案确实"经宿主客户端本地化服务提供"（NFR-3 第一条）
 * @param {object} [dict] 覆盖字典，便于测试
 * @returns {(key: string, vars?: object) => string}
 */
export function makeT(active, resolver, dict) {
  const table = dict || UI;
  const resolve = typeof resolver === 'function' ? resolver : (text) => pick(text, active);
  return (key, vars) => {
    const raw = table[key];
    /* 认不出的键：回退英文后再直接吐键名，绝不返回 undefined 让界面出现空洞 */
    const text = raw === undefined ? key : resolve(raw);
    return interpolate(text, vars);
  };
}

/** 数字按当前语言排版（NFR-3 第三条）。Intl 不可用时退回普通字符串。 */
export function formatNumber(value, active) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.NumberFormat === 'function') {
      return new Intl.NumberFormat(active || undefined).format(n);
    }
  } catch { /* 语言标签不被支持时按普通数字输出 */ }
  return String(n);
}

/** 供测试与构建脚本使用：把字典摊平成 `{zh: {...}, en: {...}}` */
export function flatten(locales) {
  const out = {};
  (locales || ['zh', 'en']).forEach((loc) => { out[loc] = {}; });
  Object.keys(UI).forEach((key) => {
    (locales || ['zh', 'en']).forEach((loc) => {
      const v = UI[key][loc];
      if (typeof v === 'string') out[loc][key] = v;
    });
  });
  return out;
}
