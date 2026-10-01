/**
 * 会话图谱 · 宿主契约检查
 *
 * 这个插件的两次线上级故障——`dsh.client.immediately` 把整个壳卡死、
 * `ctx.workspaces` 未 inject 的属性访问抛错导致视图白屏——**都不是逻辑错**，
 * 而是"对宿主契约的假设过期了"。单元测试永远测不到这一层：它们跑在假宿主上，
 * 测的是"我们相信的宿主"。
 *
 * 所以把契约写成**可执行断言**：本机有 DSH 安装时读它的 asar 逐条核对；
 * 没装（CI、别人的机器）就整体跳过并返回 0，不会误报。
 *
 * 用法：
 *   node scripts/check-host-contract.mjs [asar 路径]
 *   DSH_ASAR=/path/to/app.asar node scripts/check-host-contract.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './build-client.mjs';

/* 默认安装位置（Windows 桌面版）；也可以用参数或环境变量覆盖 */
const DEFAULT_ASAR = 'D:\\Software\\DeepSeekHarness\\resources\\app.asar';

const problems = [];
const notes = [];
const check = (ok, message) => { if (!ok) problems.push(message); else notes.push(message); };

/* --------------------------------------------------------------- asar 读取 */
/* 只做最小解析：头 8 字节（pickle 大小 + 头长度），随后是 JSON 目录索引。 */

function openAsar(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(8);
  fs.readSync(fd, head, 0, 8, 0);
  const headerSize = head.readUInt32LE(4);
  const raw = Buffer.alloc(headerSize);
  fs.readSync(fd, raw, 0, headerSize, 8);
  const index = JSON.parse(raw.toString('utf8', 8, 8 + raw.readUInt32LE(0)));
  const base = 8 + headerSize;
  const files = [];
  (function walk(node, prefix) {
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) walk(child, prefix + '/' + name);
      return;
    }
    if (!node.unpacked) files.push({ path: prefix, size: Number(node.size), offset: Number(node.offset) });
  })(index, '');
  return {
    files,
    read(entry) {
      const buf = Buffer.alloc(entry.size);
      fs.readSync(fd, buf, 0, entry.size, base + entry.offset);
      return buf.toString('utf8');
    },
    readPath(p) {
      const entry = files.find((f) => f.path === p);
      if (!entry) return undefined;
      const buf = Buffer.alloc(entry.size);
      fs.readSync(fd, buf, 0, entry.size, base + entry.offset);
      return buf.toString('utf8');
    },
    close() { fs.closeSync(fd); }
  };
}

const asarPath = process.argv[2] || process.env.DSH_ASAR || DEFAULT_ASAR;
if (!fs.existsSync(asarPath)) {
  process.stdout.write(`跳过：本机没有 DSH 安装（找的是 ${asarPath}）\n`);
  process.stdout.write('要在这台机器上跑契约检查，用 `node scripts/check-host-contract.mjs <app.asar 路径>`。\n');
  process.exit(0);
}

const asar = openAsar(asarPath);
const pkgName = (rel) => {
  const src = asar.readPath('/dsh/node_modules/' + rel + '/package.json');
  return src === undefined ? undefined : JSON.parse(src);
};
const clientSrc = (name) => asar.readPath(`/dsh/node_modules/@deepseek-ai/${name}/lib/client.js`);

process.stdout.write(`宿主：${asarPath}（${asar.files.length} 个条目）\n\n`);

try {
  /* ---------------------------------------------------------- 1. 存储域名 */
  const storage = asar.readPath('/dsh/node_modules/@deepseek-ai/dsh-storage/lib/index.js') || '';
  const reMatch = /UNIT_NAME_RE\s*=\s*([^;]+);/.exec(storage);
  const unitNameRe = reMatch ? eval(reMatch[1].trim()) : null;   /* eslint-disable-line no-eval */
  check(unitNameRe instanceof RegExp, 'dsh-storage 仍然用 UNIT_NAME_RE 约束单元名');
  if (unitNameRe) {
    const store = fs.readFileSync(path.join(ROOT, 'src/host/store.js'), 'utf8');
    const domain = /DOMAIN_NAME = '([^']+)'/.exec(store);
    const table = /TABLE_NAME = '([^']+)'/.exec(store);
    check(!!domain && unitNameRe.test(domain[1]),
      `领域名 ${domain ? domain[1] : '?'} 必须匹配 ${unitNameRe}（带连字符会让存储永远打不开）`);
    check(!!table && unitNameRe.test(table[1]), `表名 ${table ? table[1] : '?'} 必须匹配 ${unitNameRe}`);
  }
  const jsonBackend = asar.readPath('/dsh/node_modules/@deepseek-ai/dsh-storage-json/lib/index.js') || '';
  check(/invalid unit name/.test(jsonBackend) && /UNIT_NAME_RE\.test\(descriptor\.name\)/.test(jsonBackend),
    'json 后端确实在 open 时校验单元名（域名写错 = 静默只读）');

  /* ------------------------------------------------------ 2. 槽位标签契约 */
  const slots = asar.readPath('/dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js') || '';
  check(/typeof label === "function"\s*\?\s*label\(\)\s*:\s*label/.test(slots),
    'resolveSlotLabel 直接调用函数标签（无兜底）→ 标签必须是模块作用域可解析的纯函数');

  /* ------------------------------------------------ 3. 视图注册与数据层契约 */
  const conversation = clientSrc('dsh-client-ui-conversation') || '';
  check(/resolveSlotLabel[^\n]{0,24}entry\.options\.label/.test(conversation),
    '视图标签在渲染时被调用（切会话也会取）');
  check(/renderSlot\(\s*"conversation\.view"/.test(conversation) && /only:\s*viewId/.test(conversation),
    'active view 用 renderSlot("conversation.view", …, { only: viewId }) 挂载 → 注册 id 必须与视图 target 一致');
  /* 真实形状：replacing ? builder.replace({ nodes, timeline, changedTurns })
                        : builder.apply({ upserts: nodes, timeline, changedTurns }) */
  check(/builder\.replace\(\{\s*nodes,\s*timeline,\s*changedTurns\s*\}\)/.test(conversation)
    && /builder\.apply\(\{\s*upserts:\s*nodes,\s*timeline,\s*changedTurns\s*\}\)/.test(conversation),
    '视图数据层契约仍是 replace({nodes,timeline,changedTurns}) / apply({upserts,…})');

  /* -------------------------------------------------- 4. 客户端清单与引导批次 */
  const modules = asar.readPath('/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js') || '';
  check(/batches/.test(modules) && /immediately/.test(modules) && /parseBootManifest/.test(modules),
    '引导清单仍有 batches / immediately 的语义（immediately 会被编进壳之前的批次）');

  const immediately = [];
  for (const entry of asar.files) {
    if (!/\/node_modules\/@deepseek-ai\/[^/]+\/package.json$/.test(entry.path)) continue;
    const name = entry.path.split('/node_modules/')[1].replace('/package.json', '');
    let manifest;
    try { manifest = JSON.parse(asar.read(entry)); } catch { continue; }
    if (manifest.dsh && manifest.dsh.client && manifest.dsh.client.immediately === true) immediately.push(name);
  }
  notes.push(`声明 dsh.client.immediately 的包（共 ${immediately.length} 个）：${immediately.join(', ')}`);
  check(immediately.length > 0, 'immediately 仍被宿主 recognises（上面的清单即"基础设施专用"现状）');

  /* ------------------------------------------------ 5. 未声明服务不得属性访问 */
  const cordis = asar.readPath('/dsh/node_modules/@deepseek-ai/cordis/lib/index.js') || '';
  check(/without inject/.test(cordis),
    'cordis 仍然禁止未 inject 的服务做属性访问（可选服务只能走 ctx.get）');

  /* --------------------------------------------------- 6. 依赖的客户端包都在 */
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const dep of (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || []) {
    check(asar.files.some((f) => f.path === `/dsh/node_modules/${dep}/package.json`),
      `dsh.client.inject 里的 ${dep} 在宿主里存在`);
  }

  /* ------------------------------------------- 7. 我们声明的服务必须有人提供 */
  const declared = /return \{ inject: \[([^\]]*)\], apply \}/.exec(
    fs.readFileSync(path.join(ROOT, 'src/client/app.js'), 'utf8'));
  const injected = declared
    ? declared[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    : [];
  const providers = new Set();
  for (const entry of asar.files) {
    if (!/\/lib\/client\.js$/.test(entry.path)) continue;
    const src = asar.read(entry);
    /* 两种注册形状都要认：Service 子类的 `super(ctx, "name")`，
       以及显式注册 `provide("name", …)` / `reflect.provide("name", …)`。 */
    for (const m of src.matchAll(/super\(\s*ctx\s*,\s*["']([A-Za-z][\w.]*)["']/g)) providers.add(m[1]);
    for (const m of src.matchAll(/(?:reflect\s*\.\s*)?provide\(\s*["']([A-Za-z][\w.]*)["']/g)) providers.add(m[1]);
  }
  for (const name of injected) {
    check(providers.has(name),
      `客户端 inject 的 ${name} 有产品包在提供（否则插件会永远停在 pending）`);
  }
} finally {
  asar.close();
}

/* ------------------------------------------------------------------ 输出 */

process.stdout.write(`通过 ${notes.length} 项\n`);
notes.forEach((n) => process.stdout.write(`  ok   ${n}\n`));
if (problems.length) {
  problems.forEach((p) => process.stdout.write(`  FAIL ${p}\n`));
  process.stdout.write(`\n${problems.length} 项契约已变，插件需要跟着改\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\n宿主契约全部符合\n');
}
