/**
 * 标准库 API 表 —— 补全与 hover 的数据源。
 *
 * 8 个模块，导入时写**模块名本身**（不带 `std::` 前缀）。
 * 数据来自语言规范 §15（`docs/abis/jhyy-lang-spec-v4.0.0.md`）。
 */

export interface StdlibFunction {
  name: string
  /** 一句话说明（给 hover 用） */
  doc?: string
}

export interface StdlibModule {
  name: string
  doc: string
  functions: StdlibFunction[]
}

/** 零参常量函数（`os::OS_O_CREAT()`）—— 用法上必须带括号。 */
const ZERO_ARG_CONSTANTS = new Set([
  'OS_O_RDONLY',
  'OS_O_WRONLY',
  'OS_O_RDWR',
  'OS_O_CREAT',
  'OS_O_TRUNC',
  'OS_O_APPEND',
  'OS_MODE_RW_R',
])

export const STDLIB_MODULES: StdlibModule[] = [
  {
    name: 'mem',
    doc: '裸内存操作。',
    functions: [
      { name: 'ptr_add', doc: '指针按元素偏移。' },
      { name: 'mem_copy', doc: '拷贝一段内存。' },
      { name: 'mem_compare', doc: '比较两段内存。' },
      { name: 'mem_set', doc: '用字节填充一段内存。' },
      { name: 'mem_find_byte', doc: '在内存里找某个字节。' },
      { name: 'mem_zero', doc: '把一段内存清零。' },
    ],
  },
  {
    name: 'fmt',
    doc: '格式化输出。',
    functions: [
      { name: 'ptr_add', doc: '指针按元素偏移。' },
      { name: 'digit_char', doc: '数字 → 字符。' },
      { name: 'hex_char', doc: '十六进制数字 → 字符。' },
      { name: 'fmt_i32', doc: '格式化 i32。' },
      { name: 'fmt_i64', doc: '格式化 i64。' },
      { name: 'fmt_str', doc: '格式化字符串。' },
      { name: 'fmt_hex_u32', doc: '格式化十六进制 u32。' },
    ],
  },
  {
    name: 'string',
    doc: '字符串操作。',
    functions: [
      { name: 'str_from_cstr', doc: '从 C 风格字符串构造。' },
      { name: 'str_from_bytes', doc: '从字节数组构造。' },
      { name: 'str_len', doc: '取长度。' },
      { name: 'str_data', doc: '取数据指针。' },
      { name: 'str_concat', doc: '拼接。' },
      { name: 'str_equals', doc: '比较是否相等。' },
      { name: 'str_compare', doc: '比较大小。' },
      { name: 'str_find', doc: '查找子串。' },
      { name: 'strlen_local', doc: '本地 strlen。' },
    ],
  },
  {
    name: 'arena',
    doc: '内存分配器。',
    functions: [
      { name: 'arena_init', doc: '初始化 arena。' },
      { name: 'arena_alloc', doc: '分配内存。' },
      { name: 'arena_alloc_aligned', doc: '按对齐要求分配。' },
      { name: 'arena_calloc', doc: '分配并清零。' },
      { name: 'arena_reset', doc: '重置 arena。' },
      { name: 'arena_free', doc: '释放 arena。' },
      { name: 'arena_new_block', doc: '新建一个块。' },
      { name: 'align_up', doc: '向上对齐。' },
      { name: 'ptr_add', doc: '指针按元素偏移。' },
    ],
  },
  {
    name: 'io',
    doc: '文件与标准流 I/O。',
    functions: [
      { name: 'std_io_open', doc: '打开文件。' },
      { name: 'std_io_close', doc: '关闭文件。' },
      { name: 'std_io_read', doc: '读文件。' },
      { name: 'std_io_write', doc: '写文件。' },
      { name: 'std_io_print', doc: '打印到 stdout。' },
      { name: 'std_io_print_err', doc: '打印到 stderr。' },
      { name: 'std_io_eprint', doc: '打印到 stderr。' },
    ],
  },
  {
    name: 'os',
    doc: '操作系统接口。',
    functions: [
      { name: 'std_os_open', doc: '打开文件。' },
      { name: 'std_os_close', doc: '关闭文件描述符。' },
      { name: 'std_os_read', doc: '读。' },
      { name: 'std_os_write', doc: '写。' },
      { name: 'std_os_exit', doc: '退出进程。' },
      { name: 'std_os_getenv', doc: '读环境变量。' },
      ...[...ZERO_ARG_CONSTANTS].map((name) => ({
        name,
        doc: '零参常量函数 —— 用法必须带括号：`os::' + name + '()`',
      })),
    ],
  },
  {
    name: 'vec',
    doc: '动态数组。',
    functions: [
      { name: 'std_vec_new', doc: '新建空 Vec。' },
      { name: 'std_vec_with_cap', doc: '按容量新建。' },
      { name: 'std_vec_push', doc: '追加元素。' },
      { name: 'std_vec_get', doc: '取元素。' },
      { name: 'std_vec_len', doc: '取长度。' },
      { name: 'std_vec_cap', doc: '取容量。' },
      { name: 'std_vec_free', doc: '释放。' },
      { name: 'std_vec_grow', doc: '扩容。' },
      { name: 'std_vec_byte_copy', doc: '字节拷贝。' },
    ],
  },
  {
    name: 'math',
    doc: '数学函数（**仅 f64**）。',
    functions: [
      { name: 'std_math_sin', doc: '正弦。' },
      { name: 'std_math_cos', doc: '余弦。' },
      { name: 'std_math_sqrt', doc: '平方根。' },
      { name: 'std_math_pow', doc: '幂。' },
    ],
  },
]

/** 语言内建函数与关键字（补全用）。 */
export const BUILTINS: StdlibFunction[] = [
  { name: 'sizeof', doc: '类型大小（字节），返回 i64。' },
  { name: 'alignof', doc: '类型对齐（字节），返回 i64。' },
  { name: 'len', doc: '切片 / 数组的长度。' },
  { name: 'fence_seq_cst', doc: '全序内存栅栏。' },
  { name: 'fence_acquire', doc: '获取栅栏。' },
  { name: 'fence_release', doc: '释放栅栏。' },
  { name: 'printf', doc: 'C 风格格式化输出（需要先 extern fn 声明）。' },
]

const moduleByName = new Map(STDLIB_MODULES.map((m) => [m.name, m]))

export function findStdlibModule(name: string): StdlibModule | undefined {
  return moduleByName.get(name)
}

/** 某个模块里的某个函数。 */
export function findStdlibFunction(module: string, fn: string): StdlibFunction | undefined {
  return moduleByName.get(module)?.functions.find((f) => f.name === fn)
}

/** 全部函数名（补全列表用）。 */
export function allStdlibFunctionNames(): string[] {
  const names = new Set<string>()
  for (const m of STDLIB_MODULES) for (const f of m.functions) names.add(f.name)
  return [...names]
}
