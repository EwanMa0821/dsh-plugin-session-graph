/**
 * 包结构与清单一致性检查。
 *
 * 这类错误装上去才会炸（而且是装到别人机器上才炸），所以放在提交前跑：
 *   - 清单字段缺失、patch 路径写着但文件不存在
 *   - 图标越界／过大
 *   - client.js 与 src/ 不同步（改了源码忘了重新生成）
 *
 * 运行：node scripts/check-package.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, OUT, PKG_NAME, generateClient } from './build-client.mjs';

const problems = [];
const notes = [];
const check = (ok, message) => { if (!ok) problems.push(message); else notes.push(message); };

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/* ------------------------------------------------------------ 清单 */

let pkg;
try {
  pkg = readJson('package.json');
  notes.push('package.json 可解析');
} catch (e) {
  problems.push('package.json 无法解析：' + e.message);
}

if (pkg) {
  check(pkg.name === PKG_NAME, `包名与生成器一致（${PKG_NAME}）`);
  check(typeof pkg.version === 'string' && pkg.version.length > 0, 'version 已填写');
  check(pkg.type === 'module', 'type 为 module（Host 半用 ESM）');

  const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
  check(typeof patch === 'string' && patch.length > 0, 'dsh.bundle.patch 已声明');
  check(patch ? exists(patch) : false, `patch 文件存在（${patch}）`);

  const client = pkg.dsh && pkg.dsh.client;
  check(!!client, 'dsh.client 已声明');
  check(client && client.platform === 'web', 'dsh.client.platform 为 web');
  check(client && Array.isArray(client.inject) && client.inject.length > 0,
    'dsh.client.inject 声明了需要先激活的宿主客户端包');
  /* **绝不能声明 immediately。** 宿主把这类条目编进「Vite 壳之前」的 bootstrap 批次，
     而客户端 runner 挂载插件时会 await fiber.await()；本插件注入的 uiConversation /
     uiSession / uiWorkspace 都由非 immediately 的视图插件提供、要等壳起来之后才存在，
     于是 fiber 永远落不定 → 整个壳被卡死（窗口画得出来，但完全不可交互、也没有标签）。
     产品里只有基础设施包声明它（api-gateway、client-locale、ui-renderer 等 10 个），
     61 个视图插件一个都没有。这条断言就是那次"一装插件整个界面就废"的护栏。 */
  check(client && client.immediately === undefined,
    'dsh.client 不声明 immediately（视图插件进引导批次会卡死整个壳）');

  const ex = pkg.exports || {};
  check(ex['.'] === './index.js', 'exports["."] 指向 Host 半');
  check(ex['./client'] === './client.js', 'exports["./client"] 指向客户端半');
  check(ex['./package.json'] === './package.json', 'exports 暴露 package.json（元信息读取需要）');

  check(!!(pkg.meta && pkg.meta.title), 'meta.title 已填写（插件管理页展示）');
  check(!!(pkg.meta && pkg.meta.description), 'meta.description 已填写');

  /* 图标：相对路径、不越界、不超限 */
  const icon = pkg.icon;
  check(typeof icon === 'string' && icon.startsWith('./'), 'icon 是相对清单目录的路径');
  if (typeof icon === 'string') {
    check(!icon.includes('..') && !path.isAbsolute(icon.replace(/^\.\//, '')),
      'icon 不越出包目录');
    const iconPath = path.join(ROOT, icon.replace(/^\.\//, ''));
    check(fs.existsSync(iconPath), `图标文件存在（${icon}）`);
    if (fs.existsSync(iconPath)) {
      const size = fs.statSync(iconPath).size;
      check(size <= 256 * 1024, `图标不超过 256 KiB（实际 ${size} 字节）`);
      check(!fs.lstatSync(iconPath).isSymbolicLink(), '图标不是符号链接');
    }
  }

  /* files 字段要把真正需要的产物带上 */
  const files = pkg.files || [];
  ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg'].forEach((f) => {
    check(files.includes(f), `files 包含 ${f}`);
  });

  check(!!(pkg.peerDependencies && pkg.peerDependencies['@deepseek-ai/dsh']),
    '声明了对 DSH 运行时的 peer 范围（安装时会被校验）');
}

/* ------------------------------------------------------------ patch */

if (pkg && pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch && exists(pkg.dsh.bundle.patch)) {
  const text = fs.readFileSync(path.join(ROOT, pkg.dsh.bundle.patch), 'utf8');
  check(/^\s*-\s*insert:/m.test(text), 'patch 里有 insert 列表');
  check(text.includes(PKG_NAME), `patch 里的 name 指向本包（${PKG_NAME}）`);
  check(!/\t/.test(text), 'patch 里没有制表符（YAML 不吃制表符缩进）');
}

/* -------------------------------------------------------- 各入口 */

check(exists('index.js'), 'Host 半 index.js 存在');
check(exists('client.js'), '客户端半 client.js 存在');
check(exists('src/core/model.js') && exists('src/core/graph.js') && exists('src/core/export.js'),
  'src/core 三个核心模块齐备');
check(exists('locale/zh.json') && exists('locale/en.json'), '中英词典齐备');

for (const loc of ['locale/zh.json', 'locale/en.json']) {
  if (!exists(loc)) continue;
  try {
    const dict = readJson(loc);
    check(typeof dict.title === 'string' && dict.title.length > 0, `${loc} 有 title`);
    check(typeof dict['view.graph'] === 'string', `${loc} 有 view.graph`);
  } catch (e) {
    problems.push(`${loc} 无法解析：${e.message}`);
  }
}

/* Host 半能被导入，并导出 apply；同时避开两个"会让整半静默失效"的坑 */
try {
  const mod = await import(new URL('../index.js', import.meta.url).href);
  check(typeof mod.apply === 'function', 'index.js 导出 apply(ctx, config)');

  /* 坑一：插件级 inject 里写了某个可能不出现的服务 → 插件永远停在 pending，
     模块不加载、路由不注册，浏览器侧只看到一个 404 而无从判断。
     要用服务就用 apply 内的 ctx.inject([...], cb) 等它。 */
  const injected = Array.isArray(mod.inject) ? mod.inject : [];
  check(!injected.includes('connection'),
    'index.js 没有用插件级 inject 卡住 connection（否则会静默不注册）');

  /* 坑二：Config 必须是 Schemastery schema。普通对象会让配置校验失败、fiber 被拒。 */
  const cfg = mod.Config;
  const looksLikeSchema = cfg === undefined
    || typeof cfg === 'function'
    || (cfg && typeof cfg.resolve === 'function');
  check(looksLikeSchema,
    'index.js 的 Config（若导出）是 Schemastery schema，不是普通对象');
} catch (e) {
  problems.push('index.js 无法导入：' + e.message);
}

/* ------------------------------------------------- 客户端产物是否过期 */

try {
  const expected = generateClient();
  const actual = fs.readFileSync(path.join(ROOT, OUT), 'utf8');
  if (expected === actual) {
    notes.push(`${OUT} 与 src/ 同步（${Buffer.byteLength(actual, 'utf8')} 字节）`);
  } else {
    problems.push(`${OUT} 已过期：src/ 改过但没重新生成，请运行 node scripts/build-client.mjs`);
  }
  check(actual.includes('window.__ModuleLoader__.load'), `${OUT} 是合法的客户端模块`);
  check(actual.includes(PKG_NAME), `${OUT} 里的模块 id 与包名一致`);
  check(!/^\s*import\s/m.test(actual.replace(/^\/\*[\s\S]*?\*\//, '')),
    `${OUT} 里没有 ESM import（浏览器模块表不吃）`);

  /* 客户端只允许 require 两个模块：react 与宿主的 UI 基础件。
     基础件是**基线模块**——conversation 自己也直接 require 它，无须声明 external。 */
  const required = new Set([...actual.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]));
  const allowed = new Set(['react', '@deepseek-ai/dsh-client-ui-primitives']);
  const extra = [...required].filter((n) => !allowed.has(n));
  check(extra.length === 0, `客户端只 require react 与宿主 primitives（多出：${extra.join(', ') || '无'}）`);
  check(required.has('@deepseek-ai/dsh-client-ui-primitives'),
    '客户端用宿主的 MarkdownText / extractMarkdownPlainText 渲染 Markdown');
} catch (e) {
  problems.push('生成客户端产物失败：' + e.message);
}

/* ------------------------------------------------- 产物必须真的能装载 */

/* 静态检查看不出「模板字符串被反引号截断」「顶层求值抛错」这类问题，
   而它们只会在发布物上炸。这里用最小环境把 client.js 真跑一遍。 */
try {
  const captured = [];
  const previous = globalThis.window;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    __ModuleLoader__: { load(reg) { captured.push(reg); } }
  };
  try {
    await import(new URL('../client.js', import.meta.url).href + '?gate=' + Date.now());
  } finally {
    globalThis.window = previous;
  }
  check(captured.length === 1 && typeof captured[0].factory === 'function',
    `${OUT} 能被 __ModuleLoader__ 装载并给出 factory`);

  if (captured.length === 1) {
    const fakeReact = {
      createElement: (type, props) => ({ type, props: props || {} }),
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
      useEffect() {}, useMemo: (f) => f(), useCallback: (f) => f, useRef: (v) => ({ current: v })
    };
    const api = captured[0].factory((name) => {
      if (name === 'react') return fakeReact;
      if (name === '@deepseek-ai/dsh-client-ui-primitives') {
        return { MarkdownText: () => null, extractMarkdownPlainText: () => '' };
      }
      throw new Error('客户端 require 了未预期的模块：' + name);
    });
    check(typeof api.apply === 'function', `${OUT} 的 factory 返回 { inject, apply }`);
    check(Array.isArray(api.inject) && api.inject.includes('slots'),
      `${OUT} 声明了 slots（否则视图注册不到槽位）`);
  }
} catch (e) {
  problems.push(`${OUT} 无法装载：` + e.message);
}

/* --------------------------------------------------- 本地化一致性（NFR-3） */

try {
  const i18n = await import('../src/core/i18n.js');
  const dict = i18n.UI;
  const keys = Object.keys(dict);

  const missing = keys.filter((k) => typeof dict[k].zh !== 'string' || dict[k].zh === ''
    || typeof dict[k].en !== 'string' || dict[k].en === '');
  check(missing.length === 0,
    `${keys.length} 个文案键都有 zh 与 en${missing.length ? '（缺：' + missing.slice(0, 5).join(', ') + '）' : ''}`);

  /* bundle 里出现的每个 t('key') 都要在字典里 —— 键名拼错不报错，只会把键名原样显示出来 */
  const used = new Set();
  const src = fs.readFileSync(path.join(ROOT, OUT), 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) used.add(m[1]);
  const unknown = [...used].filter((k) => !(k in dict));
  check(unknown.length === 0,
    `客户端用到的 ${used.size} 个文案键都在字典里${unknown.length ? '（未定义：' + unknown.slice(0, 5).join(', ') + '）' : ''}`);

  /* 插件管理页读的是 locale/*.json；视图名要与字典同源，否则两边会飘 */
  for (const loc of ['zh', 'en']) {
    const file = readJson('locale/' + loc + '.json');
    check(file['view.graph'] === dict['view.title'][loc],
      `locale/${loc}.json 的 view.graph 与字典一致`);
  }
} catch (e) {
  problems.push('本地化检查失败：' + e.message);
}

/* ------------------------------------------------------------- 输出 */

process.stdout.write(`通过 ${notes.length} 项检查\n`);
notes.forEach((n) => process.stdout.write(`  ok   ${n}\n`));
if (problems.length) {
  problems.forEach((p) => process.stdout.write(`  FAIL ${p}\n`));
  process.stdout.write(`\n${problems.length} 项未通过\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\n全部通过\n');
}
