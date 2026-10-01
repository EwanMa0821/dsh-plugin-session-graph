/**
 * 从**真实会话日志**里提取"事件形状"夹具。
 *
 * 为什么需要它：这个仓库栽过一次"猜字段"的跟头（README 里 `source.kind` 那条），
 * 而单元测试的事件夹具是手工编的"看起来合理"的形状 —— 猜错字段时，
 * 手工夹具会跟着一起错，测试照样绿。
 *
 * 所以：把真实日志里的**形状**（事件类型 + 字段名 + 字段类型 + 出现次数）抽出来入库，
 * **不带任何内容**（不落值、不落文本、不落 id），既能公开提交，又能让
 * `test/fixture.test.mjs` 拿它反过来核对我们读的字段路径是否真的存在。
 *
 * 用法：
 *   node scripts/make-fixtures.mjs <session.v4.jsonl.zstd 路径>
 *   node scripts/make-fixtures.mjs            # 取最新一个会话日志
 *
 * 日志格式（宿主事实）：每行一个 zstd 帧，一帧一条 JSON 记录。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const OUT = 'test/fixtures/session-shapes.json';

const FRAME = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 按 zstd 魔数切帧，逐帧解压成 JSON 记录 */
function readRecords(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === FRAME[0] && buf[i + 1] === FRAME[1] && buf[i + 2] === FRAME[2] && buf[i + 3] === FRAME[3]) {
      starts.push(i);
    }
  }
  const records = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try {
      records.push(JSON.parse(zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8')));
    } catch { /* 尾部残帧：跳过 */ }
  }
  return records;
}

/** 值的形状：只留类型，不留内容 */
function shapeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? 'array' : `array<${shapeOf(value[0])}>`;
  return typeof value;
}

/** 一个对象的所有键 → 键名到形状的映射（只到第一层，避免体积与噪音） */
function shapeOfObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = shapeOf(v);
  return out;
}

function newestLog() {
  const base = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'sessions');
  if (!fs.existsSync(base)) return null;
  let best = null;
  for (const ws of fs.readdirSync(base)) {
    const dir = path.join(base, ws);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const sid of entries) {
      const log = path.join(dir, sid, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(log)) continue;
      const stat = fs.statSync(log);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { log, mtimeMs: stat.mtimeMs };
    }
  }
  return best && best.log;
}

const file = process.argv[2] || newestLog();
if (!file || !fs.existsSync(file)) {
  process.stderr.write('找不到会话日志。用法：node scripts/make-fixtures.mjs <session.v4.jsonl.zstd 路径>\n');
  process.exit(1);
}

const records = readRecords(file);
const shapes = {};
for (const rec of records) {
  const type = rec && typeof rec.type === 'string' ? rec.type : '(无 type)';
  const entry = shapes[type] || (shapes[type] = { count: 0, keys: null, data: null });
  entry.count += 1;
  const keys = shapeOfObject(rec);
  /* 同一类型取"并集"：不同事件的记录键可能略有出入，取到最多键的那条做代表 */
  if (keys && (!entry.keys || Object.keys(keys).length > Object.keys(entry.keys).length)) entry.keys = keys;
  const data = shapeOfObject(rec && rec.data);
  if (data && (!entry.data || Object.keys(data).length > Object.keys(entry.data).length)) entry.data = data;
}

const out = {
  note: '从真实会话日志提取的**事件形状**（类型 + 字段名 + 字段类型），不含任何内容。'
    + '由 scripts/make-fixtures.mjs 生成；test/fixture.test.mjs 用它核对折叠逻辑读的字段路径。',
  records: records.length,
  types: Object.keys(shapes).sort(),
  shapes
};
fs.mkdirSync(path.join(ROOT, 'test/fixtures'), { recursive: true });
fs.writeFileSync(path.join(ROOT, OUT), JSON.stringify(out, null, 2) + '\n', 'utf8');
process.stdout.write(`写入 ${OUT}：${records.length} 条记录，${Object.keys(shapes).length} 种事件类型\n`);
process.stdout.write('类型：' + Object.keys(shapes).sort().join(', ') + '\n');
