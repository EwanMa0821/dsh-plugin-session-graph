/**
 * 会话图谱 · 门禁脚本自身的测试
 *
 * 门禁也是代码。`scripts/lib/service-audit.mjs` 是那条"未 inject 的服务不得属性访问"
 * 的护栏 —— 它必须**抓得住真违规**（否则等于没有门禁），同时**放得过注释与模板里的反例**
 * （误报会让所有人不再相信它的红与绿）。这两件事都只能用测试锁住。
 *
 * 运行：node test/scripts.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripNonCode, findServiceViolations, CTX_MEMBERS } from '../scripts/lib/service-audit.mjs';

const INJECTED = ['slots', 'sessions', 'uiSession', 'uiConversation', 'uiWorkspace', 'locale'];

test('抓得住真违规：访问未 inject 的服务', () => {
  /* 这就是线上那次白屏的原文（错误卡片上的第一行）：ctx.workspaces 而 workspaces 不在 inject 里 */
  const hits = findServiceViolations('const a = ctx.workspaces;\n', INJECTED);
  assert.deepEqual(hits, [{ line: 1, name: 'workspaces' }]);
});

test('行号准确（跨行扫描）', () => {
  const src = 'const ok = ctx.locale;\nconst pad = 1;\nconst bad = ctx.archived && ctx.archived.list;\n';
  const hits = findServiceViolations(src, INJECTED);
  assert.deepEqual(hits, [{ line: 3, name: 'archived' }]);
});

test('放得过注释与模板字符串里的反例（否则门禁没人信）', () => {
  const src = [
    '// 别用 ctx.workspaces 属性访问，未 inject 会抛',
    '/* ctx.uiNothing 是反例 */',
    'const CSS = `',
    '  /* ctx.whatever */',
    '`;',
    'const keep = ctx.get("workspaces");'
  ].join('\n') + '\n';
  assert.deepEqual(findServiceViolations(src, INJECTED), []);
});

test('已 inject 的服务与上下文成员都算合法', () => {
  const src = [
    'const a = ctx.locale;',
    'const b = ctx.slots.register({});',
    'ctx.effect(() => {}, "x");',
    'ctx.inject(["connection"], (scoped) => scoped.get("x"));',
    'const c = ctx.get("workspaces");',
    'ctx.on("ready", () => {});'
  ].join('\n') + '\n';
  assert.deepEqual(findServiceViolations(src, INJECTED), []);
});

test('stripNonCode 保留行结构（行号不会漂）', () => {
  const src = '/* 一行\n两行\n三行 */\nconst x = ctx.bad;\n';
  const kept = stripNonCode(src);
  assert.equal(kept.split('\n').length, src.split('\n').length);
  assert.equal(kept.split('\n')[3].trim(), 'const x = ctx.bad;');
});

test('上下文成员表只列"不是服务"的东西', () => {
  /* 表里混进服务名 = 那条服务的越界访问会被放过 */
  for (const service of INJECTED) assert.ok(!CTX_MEMBERS.has(service), `${service} 不该在成员表里`);
  for (const member of ['effect', 'get', 'inject', 'on', 'provide', 'logger']) {
    assert.ok(CTX_MEMBERS.has(member), `${member} 应当在成员表里`);
  }
});
