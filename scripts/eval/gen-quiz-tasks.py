#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成**推理题**（读代码 ⇒ 说输出）—— 用来测「模型知不知道语义」。

    python scripts/eval/gen-quiz-tasks.py

产物：
    eval/tasks-quiz.json

## 为什么要有这一类题（2026-11-18 实测逼出来的）

**翻译题测不出正确率** —— 工作目录里就有 C 参照、prompt 还明确告诉模型
「gcc 就在 PATH 上」⇒ ⇒ 模型**编译并运行 C 参照** ⇒ 比对输出 ⇒ 不对就改
⇒ ⇒ **迭代就收敛** ⇒ ⇒ 实测 n=1 / n=3、7 道 / 11 道、两个臂**全是 100%**
⇒ ⇒ ⇒ **这把尺子只能回答「省多少轮」**，回答不了「谁写得更对」。

⇒ ⇒ **推理题**把反馈回路**从工具层断掉**：
- 题面是一段**函数**（不是一个完整程序）⇒ 没有 `main_jhyy` ⇒ 跑不起来
- 这一类题**不带 jhyy 工具**（评测的 `--no-mcp`）⇒ 没法编译、没法跑
⇒ ⇒ **模型只能靠推理** ⇒ ⇒ **答错就是答错** ⇒ ⇒ 正确率终于能测出来。

## 地面真相**免费**

每道题的期望值 = **真编译 + 真跑**那个函数算出来的 ⇒
⇒ **不是手写的答案** ⇒ ⇒ 语义改了 ⇒ 重新生成即可 ⇒ 不会漂。

## 题目从哪来

**知识包登记过的反直觉点** —— 每道题对应一条：
`u32` 回绕 / 零扩展 / `as` 的优先级 / `match` 闭区间 / `for` 半开 /
切片半开 / **写保护未实装** / 有符号除法向 0 截断 / 算术右移 /
逻辑右移 / 补码取反 / 浮点→整数饱和 / enum+match / 数组传参按引用 ……
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from quiz_bank import BREADTH  # noqa: E402  —— 同目录的题库模块

IDE_ROOT = Path(__file__).resolve().parents[2]
LANG_REPO = IDE_ROOT.parent / "JiHuiYiYou"
JHY = os.environ.get(
    "JHY", str(LANG_REPO / "compiler" / "build" / "bin" / "jhyy.exe")
)
TIMEOUT = 60

# ── **哨兵** ─────────────────────────────────────────────────────
# ⚠️ **为什么要有**：有些题（defer 的顺序、打印）**函数自己会打印东西**
#   ⇒ 那道题的答案是「**它打印了什么**」⇒ ⇒ 可 wrapper 一律
#   `print_i64(f())` ⇒ 期望值里会**多出最后一行**（返回值）
#   ⇒ ⇒ 模型答「打印了什么」就**永远对不了**（实测 4 道题两个臂都错，
#   错的是**题**、不是模型）⇒ ⇒ 用哨兵把两段**分开**：
#     哨兵**之前** = 函数自己的输出 ⇒ 那就是答案
#     哨兵**之后** = 返回值 ⇒ 只在函数**不打印**时才是答案
SENTINEL = "-987654321"
SENTINEL_STR = "-987654321"

# ── 每题都自带的打印辅助（**题目里不再重复**）────────────────────
HELPER = '''import fmt;
import io;

fn print_i64(v: i64) {
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

# ── 题目 ───────────────────────────────────────────────────────
#
# ⚠️ **每道题的 `code` 必须能编译**（生成器会真编译 ⇒ 编不过就失败）
# ⚠️ **每道题必须输出恰好一行**（判分靠它）
QUIZ = [
    {
        "id": "quiz/u32-wrap",
        "title": "u32 溢出会怎样",
        "rule": "整数溢出是回绕",
        "code": """fn f() -> i64 {
    let max: u32 = 4294967295u32;
    let w: u32 = max + 1u32;
    return w as i64;
}""",
    },
    {
        "id": "quiz/u32-zero-extend",
        "title": "u32 拓宽到 i64",
        "rule": "u32 → u64/i64 是零扩展",
        "code": """fn f() -> i64 {
    let x: u32 = 4294967295u32;
    return x as i64;
}""",
    },
    {
        "id": "quiz/u32-literal-no-suffix",
        "title": "u32 的字面量（**没带后缀**）",
        "rule": "装得下目标类型时按目标类型解释",
        "code": """fn f() -> i64 {
    let x: u32 = 4294967295;
    return x as i64;
}""",
    },
    {
        "id": "quiz/i32-sign-extend",
        "title": "i32 拓宽到 i64",
        "rule": "i32 → i64 是符号扩展",
        "code": """fn f() -> i64 {
    let x: i32 = -1;
    return x as i64;
}""",
    },
    {
        "id": "quiz/as-precedence",
        "title": "`as` 与 `*` 的优先级（**没写括号**）",
        "rule": "`as` 与 `*` 同级、左结合",
        "code": """fn f() -> i64 {
    let a: u32 = 3000000000u32;
    let b: u32 = 2u32;
    let v: u64 = a * b as u64;
    return v as i64;
}""",
    },
    {
        "id": "quiz/as-precedence-parenthesized",
        "title": "同样的意思、**加了括号**",
        "rule": "`as` 与 `*` 同级、左结合",
        "code": """fn f() -> i64 {
    let a: u32 = 3000000000u32;
    let b: u32 = 2u32;
    let v: u64 = (a as u64) * (b as u64);
    return v as i64;
}""",
    },
    {
        "id": "quiz/match-closed",
        "title": "`match` 的区间端点",
        "rule": "match 的区间是闭区间",
        "code": """fn f() -> i64 {
    let r: i32 = match 10 {
        0..10 => 1,
        _ => 0,
    };
    return r as i64;
}""",
    },
    {
        "id": "quiz/for-half-open",
        "title": "`for` 的区间端点",
        "rule": "for 的区间是半开",
        "code": """fn f() -> i64 {
    let mut s: i32 = 0;
    for i in 0..10 {
        s = s + i;
    }
    return s as i64;
}""",
    },
    {
        "id": "quiz/slice-half-open",
        "title": "切片的区间端点",
        "rule": "切片的区间是半开",
        "code": """fn f() -> i64 {
    let arr: [i32; 4] = [10 as i32, 20 as i32, 30 as i32, 40 as i32];
    let s: [*]i32 = arr as [*]i32;
    let sub: [*]i32 = s[1..3];
    return len(sub) as i64;
}""",
    },
    {
        "id": "quiz/write-protection",
        "title": "不可变绑定经指针写进去会怎样",
        "rule": "写保护未实装 ⇒ 写进去**不生效**",
        "code": """fn f() -> i64 {
    let x: i32 = 5;
    let p: *i32 = &x;
    *p = 7;
    return x as i64;
}""",
    },
    {
        "id": "quiz/array-param-by-ref",
        "title": "数组传参：callee 改得到调用方的数组吗",
        "rule": "数组传参是**按引用**（只有 struct 才是真按值）",
        "code": """fn bump(a: [i32; 2]) {
    a[0] = 99;
}

fn f() -> i64 {
    let mut arr: [i32; 2] = [1 as i32, 2 as i32];
    bump(arr);
    return arr[0] as i64;
}""",
    },
    {
        "id": "quiz/div-trunc",
        "title": "负数除法",
        "rule": "整数除法**向 0 截断**",
        "code": """fn f() -> i64 {
    let n: i32 = -7;
    return (n / 2) as i64;
}""",
    },
    {
        "id": "quiz/mod-sign",
        "title": "负数取模",
        "rule": "整数取模**向 0 截断**",
        "code": """fn f() -> i64 {
    let n: i32 = -7;
    return (n % 2) as i64;
}""",
    },
    {
        "id": "quiz/shift-arith",
        "title": "i32 的右移",
        "rule": "i32 的 `>>` 是**算术**右移",
        "code": """fn f() -> i64 {
    let a: i32 = -1;
    return (a >> 1) as i64;
}""",
    },
    {
        "id": "quiz/shift-logical-u32",
        "title": "u32 的右移",
        "rule": "u32 的 `>>` 是**逻辑**右移",
        "code": """fn f() -> i64 {
    let a: u32 = 4294967295u32;
    // ⚠️ 右操作数也要带 u32 后缀（`a >> 1` 里 `1` 是 i32 ⇒ 混算报错）
    return (a >> 1u32) as i64;
}""",
    },
    {
        "id": "quiz/tilde-u32",
        "title": "u32 的按位取反",
        "rule": "`~` 是补码取反",
        "code": """fn f() -> i64 {
    let a: u32 = 0u32;
    return (~a) as i64;
}""",
    },
    {
        "id": "quiz/float-to-int-saturation",
        "title": "浮点转整数（**超范围**）",
        "rule": "浮点 → 整数是**饱和**语义",
        "code": """fn f() -> i64 {
    let x: f64 = 3000000000.0;
    return (x as i32) as i64;
}""",
    },
    {
        "id": "quiz/enum-match",
        "title": "enum + match",
        "rule": "enum 是名义类型 + match 穷尽",
        "code": """type Shape = enum {
    Circle,
    Square,
}

fn sides(s: Shape) -> i64 {
    let r: i32 = match s {
        Shape::Circle => 0,
        Shape::Square => 4,
    };
    return r as i64;
}

fn f() -> i64 {
    return sides(Shape::Square);
}""",
    },
]


def compile_and_run(src: str, tag: str):
    """真编译 + 真跑 ⇒ 返回 (ok, stdout, err)。"""
    tmp = tempfile.mkdtemp(prefix="jhquiz-")
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


def main():
    if not os.path.exists(JHY):
        print(f"✗ 找不到编译器：{JHY}", file=sys.stderr)
        return 1

    tasks = []
    failures = []
    # ⚠️ **广度批**在另一个文件（`quiz_bank.py`）⇒ 两批分开放 ⇒ 目的不同
    all_q = QUIZ + BREADTH
    for i, q in enumerate(all_q):
        # 生成器把函数包进 main ⇒ **真跑一遍** ⇒ 期望值由编译器给
        imports = "".join(l + "\n" for l in q.get("imports", []))
        src = (
            imports
            + HELPER
            + q.get("extra", "")
            + q["code"]
            + "\nfn main_jhyy() -> i32 {\n"
              "    let r: i64 = f();\n"
              "    print_i64(" + SENTINEL + "i64);\n"
              "    print_i64(r);\n"
              "    return 0;\n}\n"
        )
        ok, out, err = compile_and_run(src, "q%d" % i)
        # ⚠️ **进度** —— 150 道题要跑十几分钟 ⇒ 不打印就看不出是在跑还是在挂
        if (i + 1) % 10 == 0 or i + 1 == len(all_q):
            print("  … %d/%d" % (i + 1, len(all_q)), flush=True)
        if not ok:
            failures.append((q["id"], "编译不过：" + err[-300:]))
            continue
        # ⚠️ **允许多行** —— 有些题（defer 的顺序、打印）**就是要多行**
        lines = [ln for ln in out.replace("\r\n", "\n").split("\n") if ln.strip() != ""]
        if len(lines) == 0:
            failures.append((q["id"], f"输出是空的：{out!r}"))
            continue
        # ⚠️ **哨兵分段** —— 见上面 SENTINEL 的说明
        if SENTINEL_STR not in lines:
            failures.append((q["id"], f"没找到哨兵（wrapper 坏了）：{out!r}"))
            continue
        k = lines.index(SENTINEL_STR)
        own = lines[:k]          # 函数**自己**打印的
        ret = lines[k + 1:]      # 返回值
        answer = own if own else ret
        if not answer:
            failures.append((q["id"], f"答案段是空的：{out!r}"))
            continue
        answer_kind = "print" if own else "return"
        tasks.append({
            "id": q["id"],
            "lang": "jhyy",
            "pairId": q["id"],
            "mutationId": "quiz",
            "kind": "quiz",
            "title": q["title"],
            "rule": q["rule"],
            "sourceFile": "",
            "specFile": "",
            "specContent": "",
            "broken": "",
            "quizCode": q["code"],
            "helperCode": HELPER,
            "quizAnswerKind": answer_kind,
            "expectStdout": "\n".join(answer),
            "actualStdout": None,
            "breakError": "",
            "expectExit": 0,
        })

    if failures:
        print("\n✗ 推理题生成失败 —— **这是题目的 bug**，不是「跳过」：", file=sys.stderr)
        for tid, why in failures:
            print(f"    - {tid}: {why}", file=sys.stderr)
        print("  ⇒ 修好（或删掉那道题）再生成 —— 静默跳过会让题集悄悄少一道。",
              file=sys.stderr)
        return 1

    out_json = IDE_ROOT / "eval" / "tasks-quiz.json"
    out_json.write_text(
        json.dumps({
            "version": 1,
            "builtAt": __import__("datetime").datetime.now().isoformat(),
            "note": "由 scripts/eval/gen-quiz-tasks.py 生成 —— 读代码说输出，"
                    "期望值由**真编译真跑**算出",
            "tasks": tasks,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8", newline="",
    )
    print(f"✓ 推理题 {len(tasks)} 道 ⇒ {out_json}")
    for t in tasks:
        print(f"    {t['id']:34} ⇒ {t['expectStdout']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
