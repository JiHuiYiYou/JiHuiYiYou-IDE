#!/usr/bin/env node
/**
 * **生成一个大 `.jhyy` 文件** —— 用来测「打开大文件」的能。
 *
 * ⚠️ **为什么需要它** ——
 *   「打开大文件慢 / 卡 / 卡死」这种问题，光看代码看不出来 ⇒
 *   ⇒ 得有一个**又大又真**的文件来复现 ⇒
 *   ⇒ 这个脚本按行数生成一个**语法正确**的 JHYY 源文件（能真的编译）✓
 *
 * 用法：
 * ```bash
 * node scripts/dev/make-big-jhyy.mjs 20000 out.jhyy
 * ```
 * ⇒ 20000 行 ⇒ 大约 1 MB。
 *
 * ⚠️ **生成的东西要能真的编译** —— 语法不对的文件会让「编译」那条路
 *    提前 bail ⇒ 测出来的不是「真性能」⇒ 所以这里生成的是
 *    「一堆带不同常量的小函数」⇒ 编译器会真的把它们都编一遍 ✓
 */
import { writeFileSync } from 'node:fs'

const lines = Number(process.argv[2] ?? 20000)
const out = process.argv[3] ?? 'big.jhyy'

if (!Number.isFinite(lines) || lines <= 0) {
  console.error(`用法：node scripts/dev/make-big-jhyy.mjs <行数> [输出文件]`)
  process.exit(1)
}

const parts = [
  '// 自动生成的大文件（scripts/dev/make-big-jhyy.mjs）\n',
  '// 用来测「打开大文件」的耗时 —— 语法正确，能真的编译。\n\n',
]

for (let i = 0; i < lines; i++) {
  parts.push(`fn helper_${i}(x: i32) -> i32 {\n    x + ${i}\n}\n\n`)
}

parts.push('fn main_jhyy() -> i32 {\n    0\n}\n')

const content = parts.join('')
writeFileSync(out, content, 'utf8')

const bytes = Buffer.byteLength(content, 'utf8')
console.log(`写了 ${out}：${lines} 个函数，${bytes} 字节（${(bytes / 1024 / 1024).toFixed(2)} MB）`)
