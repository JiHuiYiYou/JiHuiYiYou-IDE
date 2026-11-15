#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成**严格配对的双语任务集** —— 「同样的实现，大众语言 vs 小众语言」的对照组。

    python scripts/eval/gen-paired-tasks.py [--count 32]

产物：
    eval/tasks-paired.json      任务清单（两种语言的题混在一起，按 task.lang 区分）
    eval/tasks-paired/<id>.c    C 侧的坏版本源码
    eval/tasks-paired/<id>.jhyy JHYY 侧的坏版本源码

## 为什么是「严格配对」

语料来自语言仓 **`bench/difftest.py`** 的随机程序生成器 ——
它从**同一个 AST** 发出两个实现：

| C 侧（`emit_c`） | JHYY 侧（`emit_jhyy`） |
|---|---|
| `#include <stdio.h>` | `extern fn printf(fmt: *u8, val: i64) -> i32;` |
| `int main(void) {` | `fn main_jhyy() -> i32 {` |
| `printf("%lld\\n", ... & 0x7FFFFFFFu)` | `printf("%lld\\n" as *u8, ... & (2147483647 as u32))` |
| `static uint32_t f(...)` | `fn f(...) -> u32` |

⇒ 同一个算法、同一批数、同一份期望输出 ⇒ **只有语言不同**。

⇒ 四个变异在两种语言里**完全平行**：

| 变异 | C 侧 | JHYY 侧 | 类型 |
|---|---|---|---|
| `entry-name` | `int main(void)` → `int not_main(void)` | `fn main_jhyy()` → `fn main()` | 链接失败 |
| `missing-decl` | 删 `#include <stdio.h>` | 删 `extern fn printf(...)` | 编译失败 |
| `wrong-format` | `"%lld\\n"` → `"%d\\n"` | `"%lld\\n"` → `"%d\\n"` | 行为变了 |
| `mask-change` | `0x7FFFFFFFu` → `0xFFFFFFFFu` | `2147483647 as u32` → `4294967295 as u32` | 行为变了 |

⇒ **回答的问题**：模型多绕的那些轮，是 **JHYY 难**，还是**任务本身就难**？

## 判据

**两侧同口径**：编译 + 运行 + **stdout 逐字**一致
（基准 = **未变异**的那份程序的 stdout，构建时真跑一遍记下来）。
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

IDE_ROOT = Path(__file__).resolve().parents[2]
LANG_REPO = IDE_ROOT.parent / "JiHuiYiYou"
BENCH = LANG_REPO / "bench"

JHY = os.environ.get(
    "JHY", str(LANG_REPO / "compiler" / "build" / "bin" / "jhyy.exe")
)
GCC = os.environ.get("GCC", "gcc")
TIMEOUT = 60


def load_difftest():
    if not BENCH.exists():
        raise SystemExit(f"✗ 找不到 {BENCH} —— 需要语言仓（兄弟目录）")
    sys.path.insert(0, str(BENCH))
    import difftest  # noqa: E402

    return difftest


# ── 变异（每种都成对：c 侧 + jhyy 侧） ──────────────────────────

def m_entry_name(src: str, lang: str):
    if lang == "c":
        return src.replace("int main(void)", "int not_main(void)") if "int main(void)" in src else None
    return (
        src.replace("fn main_jhyy()", "fn main()")
        if "fn main_jhyy()" in src
        else None
    )


def m_missing_decl(src: str, lang: str):
    if lang == "c":
        return src.replace("#include <stdio.h>\n", "") if "#include <stdio.h>" in src else None
    return (
        src.replace('extern fn printf(fmt: *u8, val: i64) -> i32;\n', "")
        if "extern fn printf" in src
        else None
    )


def m_wrong_format(src: str, lang: str):
    return src.replace('%lld', '%d') if '%lld' in src else None


def m_mask_change(src: str, lang: str):
    if lang == "c":
        return src.replace("0x7FFFFFFFu", "0xFFFFFFFFu") if "0x7FFFFFFFu" in src else None
    return (
        src.replace("2147483647 as u32", "4294967295 as u32")
        if "2147483647 as u32" in src
        else None
    )


MUTATIONS = [
    ("entry-name", m_entry_name, "compile-break",
     "入口符号名写错（链接期才报）", "C/JHYY 入口"),
    ("missing-decl", m_missing_decl, "compile-break",
     "用了 printf 却没声明/没 include", "C 头文件 / JHYY extern 声明"),
    ("wrong-format", m_wrong_format, "behavior-break",
     "printf 的格式符跟实参类型对不上", "printf 格式符"),
    ("mask-change", m_mask_change, "behavior-break",
     "输出前的掩码被改了", "输出掩码"),
]


# ── 编译 + 运行 ─────────────────────────────────────────────────

def run_c(src: str, tag: str):
    tmp = tempfile.mkdtemp(prefix="jhpair_c-")
    try:
        path = os.path.join(tmp, f"{tag}.c")
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(src)
        exe = os.path.join(tmp, f"{tag}.exe")
        c = subprocess.run(
            [GCC, "-O0", "-ffp-contract=off", "-o", exe, path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, errors="replace", timeout=TIMEOUT,
        )
        if c.returncode != 0 or not os.path.exists(exe):
            return False, "", (c.stderr or "").strip()
        p = subprocess.run(
            [exe], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, errors="replace", timeout=TIMEOUT,
        )
        return True, p.stdout, (p.stderr or "").strip()
    except subprocess.TimeoutExpired:
        return False, "", "超时"
    finally:
        try:
            for f in os.listdir(tmp):
                os.unlink(os.path.join(tmp, f))
            os.rmdir(tmp)
        except OSError:
            pass


def run_jhyy(src: str, tag: str):
    tmp = tempfile.mkdtemp(prefix="jhpair_j-")
    try:
        path = os.path.join(tmp, f"{tag}.jhyy")
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(src)
        base = os.path.join(tmp, f"{tag}_jh")
        c = subprocess.run(
            [JHY, "compile", path, "-o", base],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, errors="replace", timeout=TIMEOUT,
        )
        exe = base + ".exe"
        if c.returncode != 0 or not os.path.exists(exe):
            return False, "", (c.stderr or "").strip()
        p = subprocess.run(
            [exe], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, errors="replace", timeout=TIMEOUT,
        )
        return True, p.stdout, (p.stderr or "").strip()
    except subprocess.TimeoutExpired:
        return False, "", "超时"
    finally:
        try:
            for f in os.listdir(tmp):
                os.unlink(os.path.join(tmp, f))
            os.rmdir(tmp)
        except OSError:
            pass


# ═══════════════════════════════════════════════════════════════════
# **手写翻译题** —— 形状跟 difftest 那种「u32 算术」不一样
#
# 为什么要有（2026-11-15 实测逼出来的）：
#   difftest 的生成器**只用 u32/u64 算术**（不用 struct/enum/数组/闭包/
#   import/defer/match/全局变量/浮点/递归）⇒ 8 道翻译题其实是
#   **同一道题的 8 次采样** ⇒
#   ⇒ **知识包里 string/vec/fmt/mem/math 那一整块从未被考过**
#   ⇒ ⇒ 「该补 stdlib 用法」这个结论**现在根本无法验证**
#
# ⇒ 所以手写一组**形状不同**的题：C 侧用标准库（string.h / string.h /
#   math.h），JHYY 侧用对应模块 ⇒ 正好考「知识包的 stdlib 那一节够不够用」。
#
# ⚠️ **配对纪律不变**：C 侧与 JHYY 侧参考 stdout 必须**逐字相同**
#   ⇒ 不相同就跳过这一对（跟 difftest 那批一个规矩）⇒ 不会混进「题目本身
#   没定义好」的噪声。
# ⚠️ **参考实现是我写的** ⇒ 它同时是「标准答案」和「知识包该讲什么」的样本
#   —— 写它的时候卡住的地方，就是要补进知识包的地方。
# ═══════════════════════════════════════════════════════════════════

_HAND_PRINT_I64 = '''fn print_i64(v: i64) {
    let mut buf: [u8; 32] = [0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                              0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                              0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                              0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8];
    let p: *u8 = &buf[0];
    let n = fmt_i64(p, v);
    buf[n] = 10u8;
    buf[n + 1i64] = 0u8;
    std_io_print(p);
}
'''

HANDWRITTEN_TRANSLATE = [
    {
        "id": "translate/stdlib-string/jhyy",
        "title": "把 C 程序翻译成 JHYY（字符串）",
        "rule": "C → JHYY 翻译（stdlib）",
        "specFile": "translate_stdlib_string_c.c",
        "c_src": """/* 手写翻译题 —— 字符串：strlen / strcmp / strstr */
#include <stdio.h>
#include <string.h>

int main(void) {
    const char *a = "hello";
    const char *b = "world";
    printf("%d\\n", (int)strlen(a));
    printf("%d\\n", (int)strlen(b));
    printf("%d\\n", strcmp(a, b) < 0 ? 1 : 0);
    printf("%d\\n", strcmp(b, a) < 0 ? 1 : 0);
    printf("%d\\n", strcmp(a, a) == 0 ? 1 : 0);
    const char *hay = "the quick brown fox";
    printf("%d\\n", (int)(strstr(hay, "brown") - hay));
    printf("%d\\n", strstr(hay, "zzz") == NULL ? 0 : 1);
    return 0;
}
""",
        "jhyy_src": """// 手写翻译题 —— 字符串：strlen / strcmp / strstr
import arena;
import string;
import fmt;
import io;

""" + _HAND_PRINT_I64 + """
fn main_jhyy() -> i32 {
    // JHYY 的 string 模块要一个 arena 放字符串数据
    let mut abuf: [i32; 10] = [0 as i32, 0 as i32, 0 as i32, 0 as i32, 0 as i32,
                               0 as i32, 0 as i32, 0 as i32, 0 as i32, 0 as i32];
    let a = abuf as *u8;
    arena_init(a, 4096 as i64);
    let s1 = str_from_cstr(a, "hello" as *u8);
    let s2 = str_from_cstr(a, "world" as *u8);
    print_i64(str_len(s1));
    print_i64(str_len(s2));
    if (str_compare(s1, s2) < 0) { print_i64(1); } else { print_i64(0); }
    if (str_compare(s2, s1) < 0) { print_i64(1); } else { print_i64(0); }
    if (str_compare(s1, s1) == 0) { print_i64(1); } else { print_i64(0); }
    let hay = str_from_cstr(a, "the quick brown fox" as *u8);
    print_i64(str_find(hay, "brown" as *u8));
    let miss = str_find(hay, "zzz" as *u8);
    if (miss < 0) { print_i64(0); } else { print_i64(1); }
    return 0;
}
""",
    },
    {
        "id": "translate/stdlib-mem/jhyy",
        "title": "把 C 程序翻译成 JHYY（字节块）",
        "rule": "C → JHYY 翻译（stdlib）",
        "specFile": "translate_stdlib_mem_c.c",
        "c_src": """/* 手写翻译题 —— 字节块：memcpy / memcmp / memset */
#include <stdio.h>
#include <string.h>

int main(void) {
    char a[16];
    char b[16];
    for (int i = 0; i < 16; i++) a[i] = (char)(i + 1);
    memcpy(b, a, 16);
    memset(b, 0, 4);
    printf("%d\\n", memcmp(a, b, 16) < 0 ? 1 : 0);
    int s = 0;
    for (int i = 0; i < 16; i++) s += (int)(unsigned char)b[i];
    printf("%d\\n", s);
    printf("%d\\n", (int)(unsigned char)b[4]);
    return 0;
}
""",
        "jhyy_src": """// 手写翻译题 —— 字节块：memcpy / memcmp / memset
import mem;
import fmt;
import io;

""" + _HAND_PRINT_I64 + """
fn main_jhyy() -> i32 {
    let mut a: [u8; 16] = [1u8, 2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8,
                           9u8, 10u8, 11u8, 12u8, 13u8, 14u8, 15u8, 16u8];
    let mut b: [u8; 16] = [0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                           0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8];
    let pa: *u8 = &a[0];
    let pb: *u8 = &b[0];
    mem_copy(pb, pa, 16 as i64);
    mem_set(pb, 0 as i32, 4 as i64);
    if (mem_compare(pa, pb, 16 as i64) < 0) { print_i64(1); } else { print_i64(0); }
    let mut s: i64 = 0 as i64;
    let mut i: i64 = 0 as i64;
    while i < 16 as i64 {
        s = s + (*(pb + i) as i64);
        i = i + 1 as i64;
    }
    print_i64(s);
    print_i64(*(pb + 4) as i64);
    return 0;
}
""",
    },
    {
        # ── **「难形状」**：struct ──────────────────────────────────
        # 为什么要有难形状（2026-11-15 实测）：臂 I（11 题）里
        # **编译错误总共只有 1 次** ⇒ difftest 那种 u32 算术题对模型
        # **已经太容易** ⇒ 尺子**饱和了** ⇒ 再加同形状的题也测不出东西。
        # ⇒ 要加**能卡住模型**的形状 ⇒ 挑「知识包里已登记、但 difftest
        #   不会生成」的那些：
        #   · struct 字面量的**字段类型必须精确匹配**（`P { c: 7 }` 报
        #     `field type mismatch` —— 整数字面量默认是 i32）
        #   · struct **按值传参/返回**
        #   · struct 字面量**省略的字段是未初始化垃圾**（本测试不踩这个）
        "id": "translate/struct-value/jhyy",
        "title": "把 C 程序翻译成 JHYY（struct 按值传参）",
        "rule": "C → JHYY 翻译（struct）",
        "specFile": "translate_struct_value_c.c",
        "c_src": """/* 手写翻译题 —— struct：按值传参 / 返回 + struct 字面量 */
#include <stdio.h>

struct Point {
    int x;
    int y;
};

static struct Point make(int x, int y) {
    struct Point p;
    p.x = x;
    p.y = y;
    return p;
}

static int dist2(struct Point a, struct Point b) {
    int dx = a.x - b.x;
    int dy = a.y - b.y;
    return dx * dx + dy * dy;
}

int main(void) {
    struct Point a = make(3, 4);
    struct Point b = make(1, 1);
    printf("%d\\n", a.x + a.y);
    printf("%d\\n", dist2(a, b));
    struct Point c = { 10, 20 };
    printf("%d\\n", c.x);
    printf("%d\\n", c.y);
    return 0;
}
""",
        "jhyy_src": """// 手写翻译题 —— struct：按值传参 / 返回 + struct 字面量
import fmt;
import io;

type Point = struct {
    x: i32,
    y: i32,
}

fn make(x: i32, y: i32) -> Point {
    let p: Point = Point { x: x, y: y };
    return p;
}

fn dist2(a: Point, b: Point) -> i32 {
    let dx: i32 = a.x - b.x;
    let dy: i32 = a.y - b.y;
    return dx * dx + dy * dy;
}

fn print_i32(v: i32) {
    let mut buf: [u8; 32] = [0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                              0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                              0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                              0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8];
    let p: *u8 = &buf[0];
    let n = fmt_i32(p, v);
    buf[n] = 10u8;
    buf[n + 1i64] = 0u8;
    std_io_print(p);
}

fn main_jhyy() -> i32 {
    let a: Point = make(3 as i32, 4 as i32);
    let b: Point = make(1 as i32, 1 as i32);
    print_i32(a.x + a.y);
    print_i32(dist2(a, b));
    let c: Point = Point { x: 10 as i32, y: 20 as i32 };
    print_i32(c.x);
    print_i32(c.y);
    return 0;
}
""",
    },
    {
        "id": "translate/stdlib-math/jhyy",
        "title": "把 C 程序翻译成 JHYY（浮点）",
        "rule": "C → JHYY 翻译（浮点）",
        "specFile": "translate_stdlib_math_c.c",
        "c_src": """/* 手写翻译题 —— 浮点：整数↔浮点不能隐式转 */
#include <stdio.h>
#include <math.h>

static double f(double x) {
    return x * x + 1.5;
}

int main(void) {
    double v = f(3);
    printf("%d\\n", (int)(v * 2.0));
    printf("%d\\n", (int)sqrt(16.0));
    printf("%d\\n", (int)pow(2.0, 10.0));
    return 0;
}
""",
        "jhyy_src": """// 手写翻译题 —— 浮点：整数↔浮点不能隐式转
import math;
import fmt;
import io;

""" + _HAND_PRINT_I64 + """
fn f(x: f64) -> f64 {
    return x * x + 1.5;
}

fn main_jhyy() -> i32 {
    // C 里 f(3) 会把 int 隐式转成 double ⇒ JHYY 必须显式写 as
    let v = f(3 as f64);
    print_i64(((v * 2.0) as i32) as i64);
    print_i64((std_math_sqrt(16.0) as i32) as i64);
    print_i64((std_math_pow(2.0, 10.0) as i32) as i64);
    return 0;
}
""",
    },
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=16)
    ap.add_argument("--per-mutation", type=int, default=8)
    args = ap.parse_args()

    dt = load_difftest()
    # ⚠️ **先写到暂存目录，最后再换上去**（2026-11-15 实测踩过）——
    #   生成过程会被**中途打断**（例：`| head -10` ⇒ SIGPIPE ⇒ 生成器半路死），
    #   而旧写法是「**先清空**目录、再逐个写」⇒ 打断的那一瞬间
    #   **语料是残的**（实测：少了 30 多个文件、3 道手写题一个没写进去）。
    #   ⇒ 残语料会**静默**进评测 ⇒ 判分拿到缺文件的题 ⇒ 结论全歪。
    #   ⇒ 改成：写暂存目录 → 全部写完 → **一次性换上去**。
    #   ⇒ 被打断 ⇒ 旧语料原封不动（最坏是「没更新」，不是「残的」）。
    out_dir = IDE_ROOT / "eval" / "tasks-paired"
    staging = IDE_ROOT / "eval" / "tasks-paired.new"
    if staging.exists():
        for f in staging.iterdir():
            if f.is_file():
                f.unlink()
    staging.mkdir(parents=True, exist_ok=True)
    out_dir = staging  # ← 生成期间，所有写入都落暂存目录

    seeds = []
    seeds_file = BENCH / "seeds" / "ci.txt"
    if seeds_file.exists():
        for line in seeds_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                seeds.append(int(line))
    seeds = seeds[: args.count] or list(range(1, args.count + 1))

    tasks = []
    skipped = []
    per_mut = {}

    # ⚠️ **严格配对**：先算「这个变异在这个种子上、两种语言各自坏成什么样」，
    #   **只要有一侧没真坏掉，这一对就整对剔除** ⇒ 否则两侧的题目会错位，
    #   对比就失去意义了。
    for seed in seeds:
        try:
            funcs, main_args = dt.generate(seed)
        except Exception as e:
            skipped.append({"seed": seed, "reason": f"生成失败：{e}"})
            continue

        langs = (
            ("c", dt.emit_c(funcs, main_args), run_c),
            ("jhyy", dt.emit_jhyy(funcs, main_args), run_jhyy),
        )

        # 两侧的「未变异」程序 + stdout
        orig = {}
        for lang, src, runner in langs:
            ok, stdout, err = runner(src, f"s{seed}_orig")
            if not ok:
                skipped.append({"seed": seed, "lang": lang,
                                "reason": f"原程序编不过：{err[:120]}"})
                orig = None
                break
            orig[lang] = (src, stdout)
        if orig is None:
            continue

        for mut_name, mut_fn, kind, title, rule in MUTATIONS:
            if per_mut.get(mut_name, 0) >= args.per_mutation:
                continue

            pair = {}
            actual_out = {}
            ok_pair = True
            for lang, src, runner in langs:
                broken = mut_fn(src, lang)
                if not broken:
                    ok_pair = False
                    break
                if kind == "compile-break":
                    bok, _, berr = runner(broken, f"s{seed}_b")
                    if bok:
                        ok_pair = False
                        break
                    break_err = (berr.splitlines() or ["编译失败"])[-1][:200]
                else:
                    bok, bout, _ = runner(broken, f"s{seed}_b")
                    if not bok or bout == orig[lang][1]:
                        ok_pair = False
                        break
                    break_err = "输出变了"
                    actual_out[lang] = bout
                pair[lang] = (broken, break_err)

            if not ok_pair:
                skipped.append({"seed": seed, "mutation": mut_name,
                                "reason": "有一侧没真坏掉 ⇒ 整对剔除"})
                continue

            for lang, src, runner in langs:
                broken, break_err = pair[lang]
                ext = "c" if lang == "c" else "jhyy"
                fname = f"{mut_name}_seed{seed}_{lang}.{ext}"
                (out_dir / fname).write_text(broken, encoding="utf-8", newline="")
                tasks.append({
                    "id": f"{mut_name}/seed{seed}/{lang}",
                    "lang": lang,
                    "pairId": f"{mut_name}/seed{seed}",
                    "mutationId": mut_name,
                    "kind": kind,
                    "title": title,
                    "rule": rule,
                    "sourceFile": fname,
                    "broken": broken,
                    "expectStdout": orig[lang][1],
                    "actualStdout": actual_out.get(lang),
                    "breakError": break_err,
                })
            per_mut[mut_name] = per_mut.get(mut_name, 0) + 1

        # ── **「翻译」题**：给 C 程序，写出行为一致的 JHYY 程序 ──────
        #
        # ⚠️ **为什么要有这一类** —— 规则类题目已经**饱和**了
        #   （entry-name / missing-decl / wrong-format 都 ~100%）
        #   ⇒ 那把尺子只能测「有没有变差」，测不出「有没有变好」。
        #
        # ⇒ **「翻译」不饱和**（要摸清 stdlib API 语义 + 整数宽度）
        #   且**正是 IDE 的真实用法**（写新代码，不是修代码）
        #   ⇒ 地面真相**免费**：配对语料的 JHYY 侧就是标准答案。
        #
        # ⚠️ **良定义性**：C 侧与 JHYY 侧的参考 stdout **必须逐字相同**
        #   （否则「翻译成行为一致的程序」不成立）⇒ 不相同就跳过这一对。
        if per_mut.get("translate", 0) < args.per_mutation:
            c_src = orig["c"][0]
            j_src, j_out = orig["jhyy"]
            c_out = orig["c"][1]
            if c_out == j_out:
                fname = f"translate_seed{seed}_c.c"
                (out_dir / fname).write_text(c_src, encoding="utf-8", newline="")
                tasks.append({
                    "id": f"translate/seed{seed}/jhyy",
                    "lang": "jhyy",
                    "pairId": f"translate/seed{seed}",
                    "mutationId": "translate",
                    "kind": "translate",
                    "title": "把 C 程序翻译成 JHYY",
                    "rule": "C → JHYY 翻译",
                    "sourceFile": "",
                    "specFile": fname,
                    "specContent": c_src,
                    "broken": "",
                    "expectStdout": j_out,
                    "actualStdout": None,
                    "breakError": "",
                    "expectExit": 0,
                })
                per_mut["translate"] = per_mut.get("translate", 0) + 1
            else:
                skipped.append({"seed": seed, "mutation": "translate",
                                "reason": "C 侧与 JHYY 侧 stdout 不同 ⇒ 翻译不成立"})

    # ── **手写翻译题**：形状不同（stdlib / 浮点）────────────────────
    # 纪律与 difftest 那批**一样**：C 侧与 JHYY 侧参考 stdout 必须逐字相同。
    # ⚠️ **但手写题配不上 = bug,不是「跳过」** —— 它没有「这个种子不合适」
    #   这种解释 ⇒ 静默跳过会让题集**悄悄少一道** ⇒ 门还绿着。
    #   ⇒ 手写题配不上 ⇒ **响亮失败**（退出码非 0）。
    hand_failures = []
    for t in HANDWRITTEN_TRANSLATE:
        ok_c, c_out, c_err = run_c(t["c_src"], "hand_c")
        if not ok_c:
            hand_failures.append((t["id"], f"C 侧编不过：{c_err[:400]}"))
            continue
        ok_j, j_out, j_err = run_jhyy(t["jhyy_src"], "hand_j")
        if not ok_j:
            hand_failures.append((t["id"], f"JHYY 参考实现编不过：{j_err[:400]}"))
            continue
        if c_out != j_out:
            hand_failures.append(
                (t["id"], f"C 侧 stdout {c_out!r} ≠ JHYY 侧 {j_out!r}"))
            continue
        (out_dir / t["specFile"]).write_text(t["c_src"], encoding="utf-8", newline="")
        tasks.append({
            "id": t["id"],
            "lang": "jhyy",
            "pairId": t["id"],
            "mutationId": "translate",
            "kind": "translate",
            "title": t["title"],
            "rule": t.get("rule", "C → JHYY 翻译"),
            "sourceFile": "",
            "specFile": t["specFile"],
            "specContent": t["c_src"],
            "broken": "",
            "expectStdout": j_out,
            "actualStdout": None,
            "breakError": "",
            "expectExit": 0,
        })
    if hand_failures:
        print("\n✗ 手写翻译题配对失败 —— 这是**题目/参考实现的 bug**，不是「跳过」：",
              file=sys.stderr)
        for tid, why in hand_failures:
            print(f"    - {tid}: {why}", file=sys.stderr)
        print("  ⇒ 修好（或删掉那道题）再生成 —— 静默跳过会让题集悄悄少一道。",
              file=sys.stderr)
        return 1

    out_json = IDE_ROOT / "eval" / "tasks-paired.json"
    tmp_json = IDE_ROOT / "eval" / "tasks-paired.json.new"
    tmp_json.write_text(
        json.dumps({
            "version": 1,
            "builtAt": __import__("datetime").datetime.now().isoformat(),
            "note": "由 scripts/eval/gen-paired-tasks.py 生成 —— 同一个 AST 的 C/JHYY 两个实现，严格配对",
            "tasks": tasks,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8", newline="",
    )

    # ── **一次性换上去** ────────────────────────────────────────
    # 前面所有写入都落在暂存目录 ⇒ 只有**全部写完**了才动真目录。
    # ⇒ 被打断（Ctrl-C / SIGPIPE / 断网）⇒ 旧语料**原封不动**。
    final_dir = IDE_ROOT / "eval" / "tasks-paired"
    old_dir = IDE_ROOT / "eval" / "tasks-paired.old"
    if old_dir.exists():
        shutil.rmtree(old_dir, ignore_errors=True)
    if final_dir.exists():
        os.rename(final_dir, old_dir)
    os.rename(staging, final_dir)
    shutil.rmtree(old_dir, ignore_errors=True)
    os.replace(tmp_json, out_json)

    n_c = sum(1 for t in tasks if t["lang"] == "c")
    n_j = len(tasks) - n_c
    print(f"✓ 配对任务 {len(tasks)} 道（C {n_c} / JHYY {n_j}），{len(seeds)} 个种子")
    pairs = len({t["pairId"] for t in tasks})
    print(f"  配对组 {pairs} 组")
    # ⚠️ **按「组数」数，不要按「题数 // 2」** —— 「翻译」那类是**只有 JHYY 侧**
    #   （C 程序是**规格书**，不是对照组）⇒ 除以 2 会把它少算一半
    #   （实测：11 道翻译题被显示成「5 对」）。
    from collections import defaultdict
    groups_by_prefix = defaultdict(set)
    for t in tasks:
        groups_by_prefix[t["pairId"].split("/")[0]].add(t["pairId"])
    for k, ids in sorted(groups_by_prefix.items()):
        print(f"    {k:18} {len(ids)} 组")
    print(f"  丢弃 {len(skipped)} 个候选")
    for s in skipped[:6]:
        print(f"    - {s.get('lang','')} {s.get('mutation','')} seed{s['seed']}: {s['reason'][:70]}")
    print(f"→ {out_json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
