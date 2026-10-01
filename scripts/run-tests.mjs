/**
 * 在**同一个进程内**依次执行全部测试。
 *
 * 为什么不用 `node --test`：测试运行器会以管道 stdio 派生子进程，
 * 在受限沙箱下会以 EPERM 失败。直接 import 测试文件同样会跑 node:test，
 * 但不产生子进程。
 *
 * 运行：node scripts/run-tests.mjs
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = [
  '../test/core.test.mjs',
  '../test/state.test.mjs',
  '../test/host.test.mjs',
  '../test/client.test.mjs'
];

let failed = false;
for (const rel of suites) {
  try {
    await import(new URL(rel, import.meta.url).href);
  } catch (error) {
    failed = true;
    process.stderr.write(`\n加载失败 ${rel}: ${error && error.message}\n`);
  }
}

/* node:test 会在事件循环空闲后汇报结果；这里只保证加载阶段的问题能冒出来 */
process.on('exit', (code) => {
  if (failed && code === 0) process.exitCode = 1;
});
