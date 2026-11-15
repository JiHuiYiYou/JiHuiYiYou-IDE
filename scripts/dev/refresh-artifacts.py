#!/usr/bin/env python3
"""刷**派生产物** —— 提交前跑一次就够（本仓只有评测任务集这一样）。

## 本仓的派生产物

= **从源码算出来的、但要进仓**的文件：

| 产物 | 生成器 | 什么时候会过期 |
|---|---|---|
| `eval/tasks.json`（32 道破坏题） | `npm run eval:tasks`（`scripts/eval/build-tasks.ts`） | 语言仓的**语料/变异定义**变了 |
| `eval/tasks-paired.json` + `eval/tasks-paired/*`（配对/翻译题） | `npm run eval:tasks:paired`（`scripts/eval/gen-paired-tasks.py`） | 同上 |

⚠️ **它们的真相在**语言仓**（`../JiHuiYiYou/bench/`）** ⇒ ⇒ **跨仓**：
改了语言仓的语料 ⇒ 本仓的任务集就过期了 ⇒ ⇒ 光看「暂存了哪些文件」
**发现不了** ⇒ ⇒ 所以这里**额外**比一次**新旧**（语料比任务集新 ⇒ 过期）。

## 为什么要有这个脚本

忘了刷 ⇒ 任务集与语料对不上 ⇒ **评测在旧题上跑** ⇒ 结论对不上 reality
⇒ 而且**没人会发现**（CI 没有「任务集是最新的」这道门）。

## 用法

    python scripts/dev/refresh-artifacts.py --should-refresh   # 该刷吗？（钩子用：退出码 0 = 该刷）
    python scripts/dev/refresh-artifacts.py --stage            # 把产物 git add 进去（钩子用）
    python scripts/dev/refresh-artifacts.py --check            # 只查不改（= CI 那道门）

⚠️ **为什么把「跑生成器」留给 shell**：生成器是 `npm run …` ⇒ `npm` 是
`.cmd` ⇒ **Windows 的 Python 找不到它**（实测 FileNotFoundError）⇒
⇒ 由 `.githooks/pre-commit`（sh）去跑 npm，本脚本只负责**判断**与**暂存**。
"""
from __future__ import annotations

import argparse
import fnmatch
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LANG_REPO = ROOT.parent / "JiHuiYiYou"

# 任务集的生成器（改了它们 ⇒ 任务集一定该重刷）
BUILDER_TRIGGERS = [
    "scripts/eval/build-tasks.ts",
    "scripts/eval/tasks.ts",
    "scripts/eval/gen-paired-tasks.py",
]

# 语言仓里**决定题目内容**的东西（它们比任务集新 ⇒ 任务集过期）
CORPUS_INPUTS = [
    LANG_REPO / "bench" / "difftest.py",
    LANG_REPO / "bench" / "seeds" / "ci.txt",
]

TASK_FILES = ["eval/tasks.json", "eval/tasks-paired.json"]


def changed_files() -> list[str]:
    """**暂存 + 未暂存 + 未跟踪**的文件名（不只是暂存区！）。

    ⚠️ **为什么要把未暂存的也算进来**：`--check` 模式（CI 用）跑的时候
    改动可能还没进暂存区 ⇒ 只看暂存区会**漏判**「生成器变了 ⇒ 产物过期」。
    """
    names: set[str] = set()
    try:
        for args in (["git", "diff", "--cached", "--name-only"],
                     ["git", "diff", "--name-only"]):
            out = subprocess.run(args, cwd=str(ROOT), capture_output=True, text=True,
                                 encoding="utf-8", errors="replace")
            names.update(ln.strip() for ln in out.stdout.splitlines() if ln.strip())
        out = subprocess.run(["git", "ls-files", "--others", "--exclude-standard"],
                             cwd=str(ROOT), capture_output=True, text=True,
                             encoding="utf-8", errors="replace")
        names.update(ln.strip() for ln in out.stdout.splitlines() if ln.strip())
    except OSError:
        pass
    return sorted(names)


def builders_changed(files: list[str]) -> bool:
    return any(any(fnmatch.fnmatch(f, p) for p in BUILDER_TRIGGERS) for f in files)


def corpus_is_newer() -> bool:
    """语言仓的语料比任务集**新** ⇒ 任务集过期。

    ⚠️ **优先用「语料指纹」**（内容哈希）：产物里记着生成时的指纹
      ⇒ 现在重算一次比对 ⇒ **精确**，且**不依赖 mtime**
      ⇒ ⇒ CI 里（全是 checkout 时间）也判得出来 ⇒ ⇒ 能当门用。
    ⇒ 产物里没有指纹（旧产物）⇒ 退回 **mtime** 判（不精确，但够用）。
    """
    fp = fingerprint_mismatch()
    if fp is True:
        return True
    if fp is False:
        # ⚠️ **指纹对得上就是最新** —— **不要再看 mtime**！
        #   CI 里两个仓是**分两次 checkout** 的 ⇒ 语言仓的语料**必然比**
        #   IDE 仓的任务集**新** ⇒ 用 mtime 判 ⇒ **永远判成「过期」**
        #   ⇒ 门在 CI 上恒红（2026-11-15 实测踩过）。
        # ⇒ 指纹（内容哈希）是**内容**的判据；mtime 只是**没有指纹时**的兜底。
        return False
    # 指纹判不了（产物是旧的 / import 失败）⇒ 退回 mtime 兜底
    newest_task = 0.0
    for f in TASK_FILES:
        p = ROOT / f
        if p.exists():
            newest_task = max(newest_task, p.stat().st_mtime)
    if newest_task == 0.0:
        return True
    for p in CORPUS_INPUTS:
        if p.exists() and p.stat().st_mtime > newest_task:
            return True
    return False


def fingerprint_mismatch() -> bool | None:
    """产物里记的语料指纹 == 现在的语料指纹？

    ⇒ `True`  = **对不上**（过期）
    ⇒ `False` = 对得上（最新）
    ⇒ `None`  = 判不了（产物里没有指纹，或生成器 import 失败）
    """
    import json

    meta = ROOT / "eval" / "tasks-paired.json"
    if not meta.exists():
        return None
    try:
        recorded = json.loads(meta.read_text(encoding="utf-8")).get("corpusSha256")
    except Exception:
        return None
    if not recorded:
        return None
    try:
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "gen_paired_tasks", ROOT / "scripts" / "eval" / "gen-paired-tasks.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        current = mod.corpus_fingerprint()
    except Exception as e:
        print(f"[refresh-artifacts] ⚠️ 指纹算不出来：{e!r}", file=sys.stderr)
        return None
    if recorded != current:
        # ⚠️ **对不上时把每个输入的哈希都打出来** —— 否则只能猜
        #   （2026-11-15 实测：CI 上对不上，本地一模一样 ⇒ 光看「对不上」没用，
        #   得知道**是哪一个输入**不同）。
        print(f"[refresh-artifacts] ✗ 语料指纹对不上：记录 {recorded} ≠ 现在 {current}",
              file=sys.stderr)
        try:
            import hashlib

            for name in ("difftest.py", "ci.txt", "tasks.ts", "gen-paired-tasks.py"):
                for base in (ROOT.parent / "JiHuiYiYou", ROOT):
                    for cand in base.rglob(name):
                        if cand.is_file() and ("bench" in str(cand) or "scripts" in str(cand)):
                            raw = cand.read_bytes()
                            h = hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()[:12]
                            print(f"[refresh-artifacts]    {cand}  len={len(raw)}  sha={h}",
                                  file=sys.stderr)
        except Exception as e:
            print(f"[refresh-artifacts] ⚠️ 诊断也失败了：{e!r}", file=sys.stderr)
    return recorded != current


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--should-refresh", action="store_true",
                    help="只判断：该刷吗？（退出码 0 = 该刷）")
    ap.add_argument("--stage", action="store_true", help="把产物 git add 进去")
    ap.add_argument("--check", action="store_true", help="只查不改（CI 那道门）")
    args = ap.parse_args()

    if args.stage:
        for f in TASK_FILES:
            subprocess.run(["git", "add", "--", f], cwd=str(ROOT))
        subprocess.run(["git", "add", "--", "eval/tasks-paired"], cwd=str(ROOT))
        print("[refresh-artifacts] ✓ 任务集已进暂存区")
        return 0

    stale = builders_changed(changed_files()) or corpus_is_newer()

    if args.should_refresh:
        if stale:
            print("[refresh-artifacts] 评测任务集过期了 ⇒ 要重刷")
        return 0 if stale else 1

    if args.check:
        if stale:
            print("[refresh-artifacts] ✗ 评测任务集**过期**了"
                  "（改了生成器，或语言仓的语料更新了）⇒ 跑 "
                  "`npm run eval:tasks && npm run eval:tasks:paired`", file=sys.stderr)
            return 1
        print("[refresh-artifacts] OK —— 任务集是最新的")
        return 0

    # 默认：自己刷（Windows 的 Python 跑不了 npm ⇒ 交给 shell）
    print("[refresh-artifacts] ⚠️ 请用 `.githooks/pre-commit`（或 `sh -c`）跑刷新 —— "
          "生成器是 `npm run …`，Windows 的 Python 找不到 npm。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
