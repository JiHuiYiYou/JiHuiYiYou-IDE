/**
 * JHYY 语言速查 —— 内嵌 Claude 会话常驻的「反直觉规则」。
 *
 * ## 为什么单独一个文件
 *
 * 这份规则**有两份消费者**：
 *
 * 1. IDE 的内嵌会话（`src/main/index.ts` 的 `jhyyCheatSheet()`）
 * 2. 评测 harness（`scripts/eval/run-eval.ts` 的基线臂）
 *
 * 放一起 ⇒ **评测的基线跟 IDE 的现状是同一份东西** ⇒ A/B 才有意义。
 * 抄一份到 harness 里 ⇒ 两边迟早漂移 ⇒ 测出来的差值不知道是谁的锅。
 *
 * ## 未来的走向
 *
 * 这份手写清单是**过渡形态**。最终它会被「从规范自动生成的知识包」取代
 * （`docs/generated/jhyy-knowledge.md`，见 `scripts/gen-knowledge.mjs`）——
 * 但在那之前，它是唯一一份「模型会踩的坑」清单。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 速查的每一行（`''` 是空行）。 */
export const JHYY_CHEATSHEET_LINES: string[] = [
  '你在给 JHYY（机会翼游）语言写代码。JHYY 是 Rust 风格的自举系统语言。',
  '',
  '要点：',
  '- 入口是 fn main_jhyy() -> i32（不是 main！），返回值就是进程退出码。',
  '- 类型必须显式标注：let x: i32 = 5;。参数也要标：fn f(a: i32) -> i32。',
  '- 整数与浮点之间不能隐式转换，要写 as：let f: f64 = 3 as f64;',
  '- 没有 print 内建；输出用 extern fn printf(fmt: *u8, val: i32) -> i32; 声明后调用。',
  '- type X = struct { ... } 结尾**不能**带分号；enum 同理。',
  '- import 只写模块名本身：import vec;（不是 import std::vec;）',
  '- 运算符：&& || 是短路逻辑，& | ^ << >> 是位运算；as 的优先级跟 * 一样。',
  '- if/else 是表达式，分支体是表达式不是语句块；match 的区间是闭区间，for 的区间是半开。',
  '- 泛型：type Pair<T> = struct { a: T }，调用写 max::<i32>(3, 5)。',
  '- 闭包 |x: i32| { x + 1 } 不能捕获外层变量。',
]

/** 速查全文（可直接当 system prompt 用）。 */
export function jhyyCheatsheet(): string {
  return JHYY_CHEATSHEET_LINES.join('\n')
}

// ── 知识包（从语言仓生成）────────────────────────────────────────

/**
 * 知识包在语言仓里的位置 —— 找不到返回 `null`。
 *
 * ⚠️ **跨仓读**：知识包由**语言仓**的 `scripts/gen-knowledge.py` 生成
 * （真相源是规范 + 标准库源码，都在语言仓）⇒ IDE 侧只读、不生成。
 *
 * 找不到语言仓时**不报错** —— 退回手写速查表（见 `buildResidentKnowledge`）。
 * IDE 本来就依赖语言仓（找 `mcp-jhyy/server.py`、找编译器），这条依赖不新增。
 */
export function knowledgePackPath(): string | null {
  // 候选根目录 —— 挨个试，谁先命中用谁。
  const roots = [
    // ① **按模块自身位置**（最可靠）：本文件在 `<IDE仓>/src/main/claude/` ⇒
    //    上三层是 IDE 仓根，再上一层的兄弟目录就是语言仓。
    //    ⚠️ 不能只靠 `process.cwd()` —— IDE 打包后 cwd 可能是任意路径。
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'JiHuiYiYou'),
    // ② IDE 仓库的兄弟目录（从 cwd 找）
    resolve(process.cwd(), '..', 'JiHuiYiYou'),
    // ③ 常见的开发布局
    resolve(homedir(), 'Desktop', 'coding', 'JiHuiYiYou'),
  ]
  for (const root of roots) {
    const candidate = join(root, 'docs', 'generated', 'jhyy-knowledge.md')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 「报错 → 修法」表在语言仓里的位置 —— 找不到返回 `null`。
 *
 * ⚠️ **跟知识包同一个套路**：真相在语言仓（`scripts/gen-knowledge.py` 导出），
 *   IDE 侧只读、不生成。
 *
 * ⇒ **给谁用**：IDE 的 PostToolUse hook —— 诊断**顺带带上「怎么改」**，
 *   模型**不用多调一次工具**就知道该改哪儿（评测实测：hook 只说「哪里错」
 *   会让模型「照诊断改」而不是「去查规范」⇒ 反而掉正确率）。
 */
export function errorFixPath(): string | null {
  const roots = [
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'JiHuiYiYou'),
    resolve(process.cwd(), '..', 'JiHuiYiYou'),
    resolve(homedir(), 'Desktop', 'coding', 'JiHuiYiYou'),
  ]
  for (const root of roots) {
    const candidate = join(root, 'docs', 'generated', 'jhyy-error-fix.json')
    if (existsSync(candidate)) return candidate
  }
  return null
}

let packCache: string | null | undefined

/** 读知识包（带缓存）。找不到返回 `null`。 */
export function readKnowledgePack(): string | null {
  if (packCache !== undefined) return packCache
  const path = knowledgePackPath()
  if (!path) {
    packCache = null
    return null
  }
  try {
    packCache = readFileSync(path, 'utf8')
  } catch {
    packCache = null
  }
  return packCache
}

/**
 * 组装「常驻知识」—— **知识包优先，缺了退回手写速查表**。
 *
 * 知识包是从规范自动生成的 ⇒ 它**包含**手写速查表的全部内容
 * （速查表那 12 条都能在规范里找到出处）⇒ 两者不必叠加，只做取舍。
 */
export function buildResidentKnowledge(): string {
  return readKnowledgePack() ?? jhyyCheatsheet()
}

