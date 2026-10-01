/**
 * 会话图谱 · 客户端服务访问审计（纯函数，供门禁与测试共用）
 *
 * cordis 的硬规则：**没有声明在 `inject` 里的服务，属性访问会直接抛**
 * （`cannot get property "workspaces" without inject`）。这条例外抛在渲染期时，
 * 宿主会把整个视图卸掉 —— 表现是"标签在、视图一片白"，看起来只是"没内容"。
 * 这条审计就是那次事故的护栏。
 *
 * 为什么单独成文件：门禁也是代码，代码就要可测。这里只做纯文本判定，
 * 由 scripts/check-package.mjs 调用，并由 test/scripts.test.mjs 覆盖
 * （注释与模板字符串里的反例不能误报，真代码里的越界不能漏报）。
 */

/** cordis 上下文自身的成员（不是服务，允许直接访问） */
export const CTX_MEMBERS = new Set([
  'effect', 'get', 'inject', 'on', 'once', 'provide', 'emit', 'logger',
  'reflect', 'scope', 'root', 'fiber', 'plugin', 'config', 'dispose', 'start', 'stop'
]);

/**
 * 剥掉注释与模板字符串，只留代码。
 *
 * 不剥就会误报（注释里常写着 `ctx.workspaces` 这样的反例，CSS 也是模板字符串），
 * 而门禁误报比漏报更糟 —— 没人会再信它。
 * 已知取舍：模板字符串**内部**的 `${ctx.x}` 真代码会被一起剥掉（当前代码里没有这种写法）。
 *
 * @param {string} source
 * @returns {string} 与源码**逐行对齐**的代码文本（注释内容置空，换行保留）
 */
export function stripNonCode(source) {
  let out = '';
  let i = 0;
  let block = false;      /* 块注释 */
  let line = false;       /* 行注释 */
  let tick = false;       /* 模板字符串 */
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (block) {
      if (two === '*/') { block = false; i += 2; continue; }
      /* 块注释里的换行必须原样保留：否则注释之后的越界访问**行号会漂**，
         而"报错行号不准"会让门禁从"有用"直接变成"误导"。 */
      if (source[i] === '\n') out += '\n';
      i += 1;
      continue;
    }
    if (line) { if (source[i] === '\n') { line = false; out += '\n'; } i += 1; continue; }
    if (tick) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i] === '`') { tick = false; i += 1; continue; }
      if (source[i] === '\n') out += '\n';
      i += 1;
      continue;
    }
    if (two === '/*') { block = true; i += 2; continue; }
    if (two === '//') { line = true; i += 2; continue; }
    if (source[i] === '`') { tick = true; i += 1; continue; }
    out += source[i];
    i += 1;
  }
  return out;
}

/**
 * 找出"访问了未 inject 的服务"的位置。
 * 同一行的同名访问只报一次（`ctx.x && ctx.x.y` 这种写法不该刷两行噪声）。
 * @param {string} source 源码
 * @param {string[]} injected 该模块声明的服务名
 * @returns {Array<{line: number, name: string}>}
 */
export function findServiceViolations(source, injected) {
  const allowed = new Set(injected || []);
  const seen = new Set();
  const out = [];
  stripNonCode(source).split('\n').forEach((text, index) => {
    for (const hit of text.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
      const name = hit[1];
      if (allowed.has(name) || CTX_MEMBERS.has(name)) continue;
      const key = `${index + 1}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ line: index + 1, name });
    }
  });
  return out;
}
