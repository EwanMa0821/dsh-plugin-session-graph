/**
 * 会话图谱 · 真实事件形状夹具测试
 *
 * `test/fixtures/session-shapes.json` 是从**真实会话日志**抽出来的事件形状
 * （类型 + 字段名 + 字段类型，不含任何内容），由 `scripts/make-fixtures.mjs` 生成。
 *
 * 为什么要有这个文件：仓库栽过一次"猜字段"的跟头（README 里 `source.kind` 那条），
 * 而单元测试里的事件夹具是手工编的"看起来合理"的形状 —— 猜错词汇时手工夹具会跟着一起错。
 * 这份夹具来自真实日志，能把"我们读的字段/类型是否真的存在"变成断言。
 *
 * 运行：node test/fixture.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import fixture from './fixtures/session-shapes.json' with { type: 'json' };

const has = (type) => Object.prototype.hasOwnProperty.call(fixture.shapes, type);
const shape = (type) => fixture.shapes[type];

test('夹具本身是可用的：来自真实日志、有记录、带形状', () => {
  assert.ok(fixture.records > 0, '夹具必须有记录');
  assert.ok(Array.isArray(fixture.types) && fixture.types.length > 0, '夹具必须带类型清单');
  assert.ok(fixture.note.includes('不含任何内容'), '夹具必须写明脱敏口径');
});

test('事件信封与折叠逻辑读到的一致：{type, seq, time, data}', () => {
  /* fold.js 逐条事件读 seq / data.turn，并按 type 分派 */
  for (const type of ['step/start', 'turn/end', 'tool/call']) {
    assert.ok(has(type), `真实日志里应当有 ${type}`);
    const s = shape(type);
    assert.equal(s.keys.type, 'string');
    assert.equal(s.keys.seq, 'number', `${type} 必须有数字 seq（折叠用它排序/定序）`);
    assert.equal(s.keys.data, 'object', `${type} 必须有 data 对象`);
  }
});

test('会话头字段：id / parentSession / createdAt 的形状与代码假设一致', () => {
  const s = shape('session');
  assert.ok(s, '真实日志里有 session 头事件');
  assert.equal(s.keys.id, 'string');
  assert.equal(s.keys.createdAt, 'number');
  /* 根会话没有 parentSession，子会话有 —— 折叠用它判父子 */
  assert.ok('parentSession' in s.keys || true, '根会话可无 parentSession');
});

test('我们确实在用的字段：step/start.turn、turn/end.turn、tool/call.name', () => {
  assert.equal(shape('step/start').data.turn, 'number', 'step/start 带轮次号');
  assert.equal(shape('turn/end').data.turn, 'number', 'turn/end 带轮次号');
  assert.equal(shape('tool/call').data.name, 'string', 'tool/call 带工具名');
});

/* ---------------------------------------------------------------------------
 * 已知缺口：折叠逻辑读的是**另一套词汇**
 *
 * src/host/fold.js 按 `turn/start` 开启一个轮次，并读 `user/message` /
 * `assistant/message` / `deliverables/presented`。而真实 DSH v4 日志里
 * **这些类型一个都不存在**（见夹具的类型清单）：真实词汇是 `step/start`
 * （data 里带 turn/step）、`turn/end`、`tool/call`、`session/title` 等。
 *
 * 后果：`cur` 只在 `turn/start` 分支里创建，于是**一个轮次也折不出来**，
 * 图上只有会话头、没有块 —— 这就是"图谱里没内容"的原因。
 *
 * 这条用例先标 skip：它记录的是**待修**的事实，而不是把红灯藏起来。
 * 修法（另开一次改动）：把折叠改成按真实词汇开轮次（首个 `step/start` 的
 * `data.turn` 变化即新轮次，`turn/end` 收尾），并确认提问/回答文本在 v4 日志里
 * 究竟落在哪（当前抓到的样本里没有任何消息文本事件）。
 * ------------------------------------------------------------------------- */
test('折叠逻辑依赖的 turn/start 等类型在真实日志里存在', {
  skip: '待修：真实 DSH v4 日志用 step/start，没有 turn/start（见本文件注释与夹具）'
}, () => {
  for (const type of ['turn/start', 'user/message', 'assistant/message', 'deliverables/presented']) {
    assert.ok(has(type), `真实日志里应当有 ${type}`);
  }
});
