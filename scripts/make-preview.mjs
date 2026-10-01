/**
 * 生成 README 用的示例图（验收 26）。
 *
 * 这不是界面截图，而是**用插件自己的装配、布局与几何代码真实渲染出来的结果**：
 * 同一份 buildGraph / layout / edgePath 就是界面上跑的那几个函数。
 * 好处是它可以随代码重新生成（`node scripts/make-preview.mjs`），不会像截图那样过期。
 *
 * 颜色用字面量而非 --dsw-* 主题变量 —— 这张图不在宿主里，拿不到主题；
 * 界面本身仍然只使用主题变量（NFR-2）。
 *
 * 运行：node scripts/make-preview.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeSessions, buildGraph, clip } from '../src/core/model.js';
import { layout, bounds, edgePath, edgeMidpoint, DEFAULT_LAYOUT } from '../src/core/graph.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'assets', 'graph-example.svg');

const turn = (n, prompt, response, extra) => ({
  turn: n, startSeq: n * 10, endSeq: n * 10 + 8,
  prompt, response, status: 'done', toolCalls: 0, deliverables: 0, ...extra
});

const sessions = normalizeSessions([
  { id: 'root', title: '读懂《思考，快与慢》', parentId: null },
  { id: 'ancor', title: '锚定效应能用在谈判里吗', parentId: 'root', forkAtTurn: 2 },
  { id: 'invest', title: '这些偏差在投资里长什么样', parentId: 'ancor', forkAtTurn: 1 },
  { id: 'fresh', title: '引用：系统一与系统二的区别', parentId: null }
]);

const turnsBySession = {
  root: [
    turn(1, '这本书的两个系统到底指什么？', '系统一快而直觉，系统二慢而费力。它们不是两个器官，而是两套加工方式。', { toolCalls: 2 }),
    turn(2, '那为什么人会被锚定效应影响？', '因为系统一拿最先出现的数字当参照，系统二往往懒得复核。'),
    turn(3, '有没有办法对抗它？', '先自己给出估计再看别人的数字；谈判里则可以先开价，把锚点放在自己这边。', { deliverables: 1 })
  ],
  ancor: [
    turn(1, '先开价真的有用吗？', '有，但取决于信息量：信息不足时先开价占优，信息充分时反而容易被对方识破。')
  ],
  invest: [
    turn(1, '投资里最常见的锚是什么？', '买入成本。它和资产的未来现金流毫无关系，却最容易变成参照点。', { toolCalls: 5 })
  ],
  fresh: []
};

/* 手动连线与引用连线，好把三种边的形态一起展示出来 */
const links = [
  { id: 'L1', kind: 'link', from: 'root:3', to: 'invest:1', label: '结论迁移' },
  { id: 'R1', kind: 'reference', from: 'root:2', to: 'header:fresh', label: '引用' }
];

const graph = buildGraph({
  sessions, turnsBySession, currentId: 'ancor', links
});

const laid = layout(graph, {});
const box = bounds(laid.nodes);
const PAD = 28;
const W = Math.round(box.maxX - box.minX + PAD * 2);
const H = Math.round(box.maxY - box.minY + PAD * 2);

const esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const EDGE_STYLE = {
  branch: { stroke: '#8b93a7', width: 1.6, dash: '', marker: 'arrow-solid' },
  link: { stroke: '#4176e6', width: 1.6, dash: '6 4', marker: 'arrow-solid' },
  reference: { stroke: '#b06ae0', width: 1.6, dash: '1.5 3.5', marker: 'arrow-hollow' }
};

const parts = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${box.minX - PAD} ${box.minY - PAD} ${W} ${H}" font-family="ui-sans-serif,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif">`);
parts.push('<defs>'
  + '<marker id="arrow-solid" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#8b93a7"/></marker>'
  + '<marker id="arrow-hollow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#ffffff" stroke="#b06ae0" stroke-width="1.4"/></marker>'
  + '</defs>');
parts.push(`<rect x="${box.minX - PAD}" y="${box.minY - PAD}" width="${W}" height="${H}" fill="#ffffff"/>`);

const nodeMap = new Map(laid.nodes.map((n) => [n.id, n]));

/* 连线画在块下面 */
graph.edges.forEach((e) => {
  const st = EDGE_STYLE[e.kind] || EDGE_STYLE.branch;
  const d = edgePath(e, nodeMap);
  if (!d) return;
  parts.push(`<path d="${d}" fill="none" stroke="${e.kind === 'branch' ? st.stroke : st.stroke}"`
    + ` stroke-width="${st.width}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}`
    + ` marker-end="url(#${st.marker})"/>`);
});

/* 边标签 */
graph.edges.forEach((e) => {
  if (!e.label) return;
  const p = edgeMidpoint(e, nodeMap);
  if (!p) return;
  const w = Math.max(30, e.label.length * 11 + 12);
  parts.push(`<rect x="${p.x - w / 2}" y="${p.y - 10}" width="${w}" height="18" rx="9" fill="#ffffff" stroke="#dfe3ea"/>`);
  parts.push(`<text x="${p.x}" y="${p.y + 3.5}" font-size="11" fill="#5b6478" text-anchor="middle">${esc(e.label)}</text>`);
});

/* 节点 */
laid.nodes.forEach((n) => {
  if (n.kind === 'header') {
    const cur = n.sessionId === graph.currentId;
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${Math.max(n.w, 200)}" height="${n.h}" rx="6" fill="${cur ? '#eef4ff' : '#f3f5f8'}" stroke="${cur ? '#4176e6' : '#e3e7ee'}"/>`);
    parts.push(`<text x="${n.x + 10}" y="${n.y + 17}" font-size="12" font-weight="600" fill="${cur ? '#2f5fd0' : '#39414f'}">${esc(clip(n.title, 22))}</text>`);
    parts.push(`<text x="${n.x + Math.max(n.w, 200) - 10}" y="${n.y + 17}" font-size="11" fill="#8b93a7" text-anchor="end">${n.turnCount} 轮</text>`);
    return;
  }
  if (n.kind === 'empty') {
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="9" fill="#fbfcfe" stroke="#c9ced9" stroke-dasharray="5 4"/>`);
    parts.push(`<text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 4}" font-size="11.5" fill="#8b93a7" text-anchor="middle">空子会话 · 尚未提问</text>`);
    return;
  }
  const b = n.block;
  const sel = b.sessionId === graph.currentId && b.turn === 3;
  parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="9" fill="${sel ? '#f5f8ff' : '#ffffff'}" stroke="${sel ? '#4176e6' : '#e3e7ee'}" stroke-width="${sel ? 1.6 : 1}"/>`);
  parts.push(`<text x="${n.x + 11}" y="${n.y + 19}" font-size="11" font-weight="600" fill="#8b93a7">第 ${b.turn} 轮</text>`);
  if (b.toolCalls) parts.push(`<text x="${n.x + n.w - 11}" y="${n.y + 19}" font-size="10.5" fill="#8b93a7" text-anchor="end">⚙ ${b.toolCalls}</text>`);
  const ask = clip(String(b.prompt || '').replace(/\s+/g, ' '), 26);
  const ans = clip(String(b.response || '').replace(/\s+/g, ' '), 30);
  parts.push(`<text x="${n.x + 11}" y="${n.y + 40}" font-size="12" fill="#232a35">${esc(ask)}</text>`);
  parts.push(`<text x="${n.x + 11}" y="${n.y + 58}" font-size="11" fill="#7c8598">${esc(ans)}</text>`);
});

/* 图例：三种边形态必须一眼可分（不能只靠颜色） */
const LY = box.maxY + PAD - 34;
const LX = box.minX;
parts.push(`<text x="${LX}" y="${LY - 12}" font-size="11" fill="#8b93a7">三类边在界面上靠形态区分，不只靠颜色：</text>`);
const legend = [
  ['branch', '派生边 · 实线 + 实心箭头'],
  ['link', '手动边 · 虚线 + 实心箭头 + 标签'],
  ['reference', '引用边 · 点线 + 空心箭头 + 标签']
];
legend.forEach(([kind, label], i) => {
  const x = LX + i * 250;
  const st = EDGE_STYLE[kind];
  parts.push(`<line x1="${x}" y1="${LY + 10}" x2="${x + 34}" y2="${LY + 10}" stroke="${st.stroke}" stroke-width="${st.width}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''} marker-end="url(#${st.marker})"/>`);
  parts.push(`<text x="${x + 42}" y="${LY + 14}" font-size="11" fill="#5b6478">${esc(label)}</text>`);
});

parts.push('</svg>');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, parts.join('\n') + '\n', 'utf8');

const rel = path.relative(ROOT, OUT).replace(/\\/g, '/');
process.stdout.write(`已生成 ${rel}（${W}×${H}，${laid.nodes.length} 个节点，${graph.edges.length} 条边）\n`);
