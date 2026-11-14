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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=16)
    ap.add_argument("--per-mutation", type=int, default=8)
    args = ap.parse_args()

    dt = load_difftest()
    out_dir = IDE_ROOT / "eval" / "tasks-paired"
    # ⚠️ **先清空** —— 上一轮生成的文件会留着（实测：改了 per-mutation 上限后
    #   目录里还挂着上一轮的 92 个文件 ⇒ 看着像 92 道题，实际只有 58 道）。
    if out_dir.exists():
        for f in out_dir.iterdir():
            if f.is_file():
                f.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)

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

    out_json = IDE_ROOT / "eval" / "tasks-paired.json"
    out_json.write_text(
        json.dumps({
            "version": 1,
            "builtAt": __import__("datetime").datetime.now().isoformat(),
            "note": "由 scripts/eval/gen-paired-tasks.py 生成 —— 同一个 AST 的 C/JHYY 两个实现，严格配对",
            "tasks": tasks,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8", newline="",
    )

    n_c = sum(1 for t in tasks if t["lang"] == "c")
    n_j = len(tasks) - n_c
    print(f"✓ 配对任务 {len(tasks)} 道（C {n_c} / JHYY {n_j}），{len(seeds)} 个种子")
    pairs = len({t["pairId"] for t in tasks})
    print(f"  配对组 {pairs} 组")
    from collections import Counter
    for k, v in sorted(Counter(t["pairId"].split("/")[0] for t in tasks).items()):
        print(f"    {k:18} {v // 2} 对")
    print(f"  丢弃 {len(skipped)} 个候选")
    for s in skipped[:6]:
        print(f"    - {s.get('lang','')} {s.get('mutation','')} seed{s['seed']}: {s['reason'][:70]}")
    print(f"→ {out_json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
