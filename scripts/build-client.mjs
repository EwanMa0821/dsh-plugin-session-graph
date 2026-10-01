/**
 * 生成 client.js。
 *
 * 为什么需要它：客户端产物由宿主的 __ModuleLoader__ 以懒加载 CJS 形式装载，
 * 里面只能 require 宿主提供的模块（react），无法 import 本包的 ESM 源码。
 * 而需求 NFR-8 又要求「首装不得执行依赖构建脚本」——
 * 所以构建发生在**作者侧**：源码保持唯一的 ESM 真源，产物是预构建并随包提交的。
 *
 * 运行（作者侧）：node scripts/build-client.mjs
 * 其他脚本可 import { generateClient } 做「产物是否过期」的校验。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

const CORE = [
  'src/core/model.js',
  'src/core/graph.js',
  'src/core/export.js',
  'src/core/state.js',
  'src/core/scale.js',
  'src/core/i18n.js'
];
const APP = 'src/client/app.js';
export const OUT = 'client.js';
export const PKG_NAME = 'dsh-plugin-session-graph';

/** 顶层声明的名字，用来检测跨文件撞名 */
const TOP_LEVEL = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * 撞名检测。
 *
 * 内联之后所有核心文件共用**同一个作用域**，两个文件各写一个 `const str`
 * 就是 `Identifier 'str' has already been declared` —— 而 `node --check` 未必
 * 在每个环节都跑到，真正暴露它的往往是浏览器里的一片空白。
 * 与其靠运气，不如在这里直接拦住。
 */
function assertNoCollisions(files) {
  const owner = new Map();
  const clashes = [];
  for (const { file, name } of files) {
    const seen = owner.get(name);
    if (seen && seen !== file) clashes.push(`${name}（${seen} 与 ${file}）`);
    else owner.set(name, file);
  }
  if (clashes.length) {
    throw new Error(
      '内联后顶层声明撞名，请给私有助手加文件前缀：\n  ' + clashes.join('\n  ')
    );
  }
}

/** 把 ESM 源码降级成同作用域的普通语句（去掉 import / export） */
function flatten(src, file) {
  const out = src
    .replace(/^import[\s\S]*?from\s*'[^']*';\s*$/gm, '')
    .replace(/^export\s+(const|let|var|function|class)\s/gm, '$1 ')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  if (/^\s*(export|import)\b/m.test(out)) {
    throw new Error(`${file}: 仍残留 import/export，生成物不会是合法脚本`);
  }
  if (out.length === src.length) {
    throw new Error(`${file}: 没有发生任何降级，正则可能已失配`);
  }
  return `/* ---- ${file} ---- */\n${out.trim()}\n`;
}

/** 由 src/ 生成 client.js 的完整内容 */
export function generateClient() {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  /* 先查撞名，再拼内容 —— 查的是降级之后的真实声明 */
  const declared = [];
  CORE.forEach((file) => {
    const flat = flatten(read(file), file);
    for (const m of flat.matchAll(TOP_LEVEL)) declared.push({ file, name: m[1] });
  });
  assertNoCollisions(declared);

  const parts = [];
  parts.push('/* 由 scripts/build-client.mjs 生成 —— 请勿直接编辑；改 src/ 后重新生成。 */');
  parts.push('window.__ModuleLoader__.load({');
  parts.push(`  id: ${JSON.stringify(PKG_NAME)},`);
  parts.push('  factory(require) {');
  parts.push("    const React = require('react');");
  parts.push('    const h = React.createElement;');
  CORE.forEach((f) => parts.push(flatten(read(f), f)));
  parts.push(read(APP).trim());
  parts.push('  }');
  parts.push('});');
  parts.push('');
  return parts.join('\n');
}

function main() {
  const out = generateClient();
  fs.writeFileSync(path.join(ROOT, OUT), out, 'utf8');
  process.stdout.write(JSON.stringify({
    file: OUT,
    bytes: Buffer.byteLength(out, 'utf8'),
    lines: out.split('\n').length,
    core: CORE,
    app: APP
  }, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
