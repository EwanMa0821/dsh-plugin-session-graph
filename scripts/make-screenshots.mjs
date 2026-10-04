/**
 * 从交互原型生成 README 用的界面截图。
 *
 * `prototype/session-graph-interactive.html` 是插件的可视化原型，
 * 界面长什么样由它说了算。这里不去截"作者机器上的产品截图"
 * （那会随宿主版本、主题、窗口大小过期），而是把原型本身
 * 放进一个无头浏览器里渲染，逐个场景存成 PNG。
 *
 * 做法：把原型复制到临时目录，在它自己的脚本之后追加一小段
 * 场景覆盖脚本（原型里的 `state` / `renderAll` 是模块作用域，
 * 只能从同一段脚本里访问），然后让无头 Edge/Chrome 打开并截图。
 * 原型文件本身不会被改动。
 *
 * 取景为什么用 CSS 而不是直接改 `#world` 的 style：
 * 原型启动流程里还会再跑一次它自己的 `fitView()`，它会以
 * "宽高同时约束 + scale 下限 0.3" 重写内联变换，把注入设好的
 * 取景盖掉。样式表里的 `!important` 压得过内联样式、又不会被
 * JS 的 `style.transform = ...` 覆盖，所以取景统一走这里。
 *
 * 运行：
 *   node scripts/make-screenshots.mjs                    # 自动探测浏览器
 *   node scripts/make-screenshots.mjs --browser=<路径>    # 指定 Edge/Chrome
 *   node scripts/make-screenshots.mjs --only=graph-overview
 *
 * 没有可用浏览器时以退出码 0 跳过并说明原因 —— 截图是文档资产，
 * 不该让 CI 因为"这台机器没装浏览器"而变红。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROTOTYPE = path.join(ROOT, 'prototype', 'session-graph-interactive.html');
const OUT_DIR = path.join(ROOT, 'assets', 'prototype');

/* 原型里的块尺寸（W×H）与列间距基准，用来算取景 */
const NODE_W = 232;
const NODE_H = 74;

/* ---------------------------------------------------------------
   浏览器探测
   --------------------------------------------------------------- */

const CANDIDATES = [
  process.env.DSH_PREVIEW_BROWSER,
  path.join(process.env['ProgramFiles'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].filter(Boolean);

function findBrowser(explicit) {
  const list = explicit ? [explicit, ...CANDIDATES] : CANDIDATES;
  for (const c of list) {
    try {
      if (c && fs.statSync(c).isFile()) return c;
    } catch { /* 继续找下一个 */ }
  }
  return null;
}

/* ---------------------------------------------------------------
   场景定义
   --------------------------------------------------------------- */

/*
 * panel = 图谱画布可见区域（css px）的估计值：窗口宽 - 侧栏 240 - 详情栏 330
 *         - 内边距，窗口高 - 顶栏 - 标签栏 - 工具条 - 输入框。
 * 一个会话 = 一列（会话头 26px + 每轮 74px + 轮间距 26px），列间距 340px。
 * stage = 期望的缩放；取景把内容夹在画布内并居中，再小的窗口也不会溢出。
 */
const SHOTS = [
  {
    name: 'graph-overview',
    alt: '会话图谱视图（中文界面）：三个会话按分叉关系排成三列，竖排是同一个会话的先后轮次，向右是分叉出去的子孙，块与块之间用带箭头的实线连接',
    caption: '图谱视图 —— 竖排是同一会话的先后轮次，向右是分叉出去的子孙',
    width: 1560, height: 920,
    layout: { root: [60, 60], ancor: [400, 60], invest: [740, 60] },
    active: ['root', 'ancor', 'invest'],
    current: 'ancor',
    stage: 1.0,
    run: `
      state.pos = {}; state.hidden = {}; state.alias = {}; state.links = [];
    `
  },
  {
    name: 'fork-from-turn',
    alt: '在某一轮上点「从这里分叉」：右侧详情面板显示该轮的完整提问与回答、元信息、用量，以及分叉、连接到、重命名、隐藏等操作',
    caption: '从任意一轮分叉 —— 详情面板给出该轮的完整提问、回答与分叉入口',
    width: 1560, height: 920,
    layout: { root: [60, 60], ancor: [400, 60], invest: [740, 60] },
    active: ['root', 'ancor', 'invest'],
    current: 'root', selected: 'root:3',
    stage: 0.9,
    run: `
      state.pos = {}; state.hidden = {}; state.alias = {}; state.links = [];
    `
  },
  {
    name: 'conclusion-links',
    alt: '手动连线把两条分支上的结论接起来：虚线带标签的连线横跨两列，右侧详情面板可以就地改标签或删除这条连线',
    caption: '手动连线 —— 把散落在不同分支上的结论接起来，标签可就地编辑',
    width: 1560, height: 920,
    layout: { root: [60, 60], ancor: [400, 60], invest: [740, 60], infl: [740, 740] },
    active: ['root', 'ancor', 'invest', 'infl'],
    current: 'invest', selected: 'L1',
    stage: 0.97,
    run: `
      state.pos = {}; state.hidden = {}; state.alias = {};
      state.links = [Object.assign({}, SEED_LINK)];
    `
  },
  {
    name: 'export-dialog',
    alt: '会话图谱的导出对话框：可选 FreeMind .mm 与 Markdown .md 两种格式，显示导出块数、是否包含已隐藏的块，并给出导出内容预览',
    caption: '导出 —— FreeMind `.mm` 与 Markdown `.md`，可直接导入 XMind / Freeplane / MindManager',
    width: 1560, height: 920,
    layout: { root: [60, 60], ancor: [400, 60], invest: [740, 60] },
    active: ['root', 'ancor', 'invest'],
    current: 'root',
    stage: 1.0,
    run: `
      state.pos = {}; state.hidden = {}; state.alias = {};
      state.links = [Object.assign({}, SEED_LINK)];
      state.exportFmt = 'mm';
      openExport();
    `
  },
  {
    name: 'dark-theme',
    alt: '同一张会话图谱在深色主题下的样子：界面只使用宿主的 --dsw-alias-* 主题变量，深浅色自动跟随产品其余部分',
    caption: '主题跟随宿主 —— 界面只用 `--dsw-alias-*` 变量，深浅色与产品其余部分一致',
    width: 1560, height: 920,
    layout: { root: [60, 60], ancor: [400, 60], invest: [740, 60] },
    active: ['root', 'ancor', 'invest'],
    current: 'ancor',
    stage: 1.0,
    dark: true,
    run: `
      state.pos = {}; state.hidden = {}; state.alias = {}; state.links = [];
    `
  }
];

/* 内容包围盒 → 画布内的缩放与平移（与浏览器无关，可重复） */
function framing(shot) {
  const xs = Object.values(shot.layout).map(([x]) => x);
  const ys = Object.values(shot.layout).map(([, y]) => y);
  const turnsOf = { root: 5, ancor: 3, invest: 2, infl: 2 };
  let x0 = Math.min(...xs) - 30;
  const x1 = Math.max(...xs) + NODE_W + 30;
  const y0 = Math.min(...ys) - 30;
  let y1 = y0;
  for (const [sid, [x, y]] of Object.entries(shot.layout)) {
    y1 = Math.max(y1, y + 26 + turnsOf[sid] * (NODE_H + 26));
  }
  y1 += 30;
  const bw = x1 - x0, bh = y1 - y0;

  /* 画布可见区域：宁小勿大 —— 取景只需保证内容不出界、居中好看 */
  const pw = shot.width - 240 - 330 - 40;
  const ph = shot.height - 84 - 40 - 100;
  const scale = Math.min(shot.stage, pw / bw, ph / bh);
  const panX = Math.max(10, (pw - bw * scale) / 2 - x0 * scale);
  const panY = Math.max(10, Math.min((ph - bh * scale) / 2 - y0 * scale, 34));
  return { scale: Math.round(scale * 1000) / 1000, panX: Math.round(panX), panY: Math.round(panY) };
}

/* ---------------------------------------------------------------
   生成
   --------------------------------------------------------------- */

const argv = process.argv.slice(2);
const argOf = (k) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : null;
};

const browser = findBrowser(argOf('browser'));
if (!browser) {
  process.stdout.write('跳过截图生成：没找到 Edge / Chrome。\n'
    + '装一个浏览器，或用 --browser=<路径> 指定可执行文件后重跑。\n');
  process.exit(0);
}

if (!fs.existsSync(PROTOTYPE)) {
  process.stderr.write(`找不到原型文件：${path.relative(ROOT, PROTOTYPE)}\n`);
  process.exit(1);
}

const only = argOf('only');
const wanted = only ? SHOTS.filter((s) => s.name === only) : SHOTS;
if (!wanted.length) {
  process.stderr.write(`没有名为 ${only} 的场景。可选：${SHOTS.map((s) => s.name).join(', ')}\n`);
  process.exit(1);
}

const source = fs.readFileSync(PROTOTYPE, 'utf8');
const ANCHOR = 'applyStep(2);\n</script>';
if (!source.includes(ANCHOR)) {
  process.stderr.write('原型结构变了：找不到注入锚点 `applyStep(2);`，请同步更新本脚本。\n');
  process.exit(1);
}

/* 场景脚本：跑在原型自己的作用域里，因此能直接改 state / 调 renderAll */
function overrides(shot) {
  const box = framing(shot);
  const lines = Object.entries(shot.layout)
    .map(([sid, [x, y]]) => `  S.${sid}.x = ${x}; S.${sid}.y = ${y};`).join('\n');
  const sel = shot.selected ? `'${shot.selected}'` : 'null';
  return `
/* === README 截图覆盖（由 scripts/make-screenshots.mjs 注入；原型文件本身未被改动）=== */
(function () {
  /* 取景交给样式表的 !important：原型启动时还会再跑一次自己的 fitView()，
     它会重写 #world 的内联变换，把这里设好的缩放盖掉。 */
  var css = document.createElement('style');
  css.textContent = '#world{transform:translate(${box.panX}px,${box.panY}px) scale(${box.scale})!important}';
  document.head.appendChild(css);

  document.querySelector('.tour').style.display = 'none';
  document.getElementById('dlg').style.display = 'none';

  state.view = 'graph';
  state.active = ${JSON.stringify(shot.active)};
  state.current = '${shot.current}';
  state.selected = ${sel};
  state.pos = {}; state.hidden = {}; state.alias = {};
  state.connectFrom = null; state.dlgOpen = false;
  state.scale = ${box.scale}; state.panX = ${box.panX}; state.panY = ${box.panY};
  state.fitted = true;

${lines}
${shot.run}
${shot.dark ? "  document.getElementById('app').dataset.theme = 'dark';" : ''}

  renderAll();
  if (state.selected && state.selected.indexOf('L') === 0) renderDetail();
  document.getElementById('zoomLabel').textContent = Math.round(${box.scale} * 100) + '%';
})();
`;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-graph-shots-'));
let made = 0;
const failures = [];

for (const shot of wanted) {
  const html = source.replace(ANCHOR, `applyStep(2);\n${overrides(shot)}\n</script>`);
  const page = path.join(tmpRoot, `${shot.name}.html`);
  fs.writeFileSync(page, html, 'utf8');

  const out = path.join(OUT_DIR, `${shot.name}.png`);
  const profile = path.join(tmpRoot, `${shot.name}-profile`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profile}`,
    `--window-size=${shot.width},${shot.height}`,
    '--virtual-time-budget=6000',
    `--screenshot=${out}`,
    `file:///${page.replace(/\\/g, '/')}`
  ];

  const r = spawnSync(browser, args, { encoding: 'utf8', timeout: 180000 });
  const ok = fs.existsSync(out) && fs.statSync(out).size > 2000;
  if (ok) {
    made += 1;
    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    const box = framing(shot);
    process.stdout.write(`✓ assets/prototype/${shot.name}.png  ${shot.width}×${shot.height}`
      + `  scale=${box.scale}  ${kb} KB\n`);
  } else {
    failures.push(shot.name);
    const detail = (r.stderr || r.stdout || '').split('\n')
      .filter((l) => /ERROR|FATAL/.test(l)).slice(0, 3).join(' | ');
    process.stderr.write(`✗ ${shot.name} 截图失败${detail ? ` —— ${detail}` : ''}\n`);
  }
}

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch { /* 临时目录残留不影响结果 */ }

process.stdout.write(`\n共生成 ${made}/${wanted.length} 张，输出目录 assets/prototype/\n`);
if (failures.length) {
  process.stderr.write(`失败：${failures.join(', ')}。`
    + '若是沙箱拦下了浏览器进程，请在更宽的权限下重跑；'
    + '若只差某些场景，可用 --only=<名字> 单独重做。\n');
  process.exit(1);
}

