#!/usr/bin/env python3
"""**语料锁** —— 「派生产物是不是最新的」这件事的**唯一**判据。

## 本仓的派生产物

| 产物 | 生成器 |
|---|---|
| `eval/tasks.json`（破坏题） | `npm run eval:tasks`（`scripts/eval/build-tasks.ts`） |
| `eval/tasks-paired.json` + `eval/tasks-paired/`（配对/翻译题） | `npm run eval:tasks:paired`（`scripts/eval/gen-paired-tasks.py`） |

它们是**从语言仓的语料算出来的、但要进仓**的文件 ⇒ 语料（或生成器）变了
就得重刷 ⇒ 忘了 ⇒ **评测在旧题上跑** ⇒ 结论对不上 reality，而且**没人会发现**
（CI 里没有「任务集是最新的」这道门）。

## 判据：**内容哈希**，不是 mtime

`eval/corpus-lock.json`（进仓）记着生成时的内容哈希：

| 字段 | 是什么 |
|---|---|
| `corpusSha256` | 所有输入（语言仓的语料 + 本仓的生成器）的**聚合**哈希 |
| `groups` | 每个输入**组**单独的哈希（诊断用：到底是哪一组变了） |
| `artifacts` | 产物文件自己的哈希（抓「手改产物」/「产物没跟着重刷」） |

⚠️ **为什么不用 mtime**：CI 里两个仓是**分两次 checkout** 的 ⇒ 语言仓的语料
**必然比** IDE 仓的任务集**新** ⇒ 用 mtime 判 ⇒ **永远判成「过期」** ⇒
门在 CI 上恒红（2026-11-15 实测踩了两次）。内容哈希跟 checkout 时间无关。

⚠️ **为什么锁是**单独一个文件**、而不是把指纹塞进产物里**：
两个产物由**两个不同语言的生成器**产出（TS / Python）⇒ 指纹算法塞进产物里
就得写两遍 ⇒ **两份实现漂移**（一处改了另一处没改 ⇒ 门永远判「过期」）。
锁文件由**这一个脚本**写 ⇒ **只有一份实现** ⇒ 生成器不用改。

## 用法

    python scripts/dev/refresh-artifacts.py --should-refresh   # 该刷吗？（退出码 0 = 该刷）
    python scripts/dev/refresh-artifacts.py --write-lock       # 重刷后：把锁写下来
    python scripts/dev/refresh-artifacts.py --stage            # 把产物 + 锁 git add 进去
    python scripts/dev/refresh-artifacts.py --check            # 只查不改（= CI 那道门）

⚠️ **为什么把「跑生成器」留给 shell**：生成器是 `npm run …` ⇒ `npm` 是
`.cmd` ⇒ **Windows 的 Python 找不到它**（实测 FileNotFoundError）⇒
⇒ 由 `.githooks/pre-commit`（sh）去跑 npm，本脚本只负责**判断**与**记账**。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCK_REL = "eval/corpus-lock.json"

# 产物（进仓，但都是从语料算出来的）
ARTIFACT_FILES = ["eval/tasks.json", "eval/tasks-paired.json"]
ARTIFACT_DIRS = ["eval/tasks-paired"]

# 本仓里**决定产物内容**的生成器（改了就可能改产物）
GENERATORS = [
    "scripts/eval/build-tasks.ts",
    "scripts/eval/tasks.ts",
    "scripts/eval/mutations.ts",
    "scripts/eval/gen-paired-tasks.py",
    "tests/helpers/repo.ts",
]

# 语言仓里**决定产物内容**的语料（相对语言仓根）
LANG_FILES = [
    "bench/difftest.py",
    "bench/seeds/ci.txt",
]
# 语言仓的「破坏题语料」目录（递归；`_` 开头的**不进**语料 —— 跟
# `tests/helpers/repo.ts:collectJhyyFiles` 同口径）
LANG_EXAMPLES = "compiler/tests/examples"

# 语言仓的候选目录名（CI 里 checkout 成 `JiHuiYiYou`，本地可能叫别的）
LANG_DIR_NAMES = ["JiHuiYiYou", "JiHuiYiYou-compiler"]


# ── 语言仓在哪 ──────────────────────────────────────────────────────

def find_lang_repo() -> Path | None:
    """语言仓（JiHuiYiYou）的位置。

    ⚠️ **为什么不能只认「兄弟目录」**：CI 里两个仓是**分两次 checkout** 的
    ⇒ 兄弟目录名取决于 workflow 怎么写 ⇒ 认死了 ⇒ 门在 CI 上「找不到语料」
    ⇒ 恒红（2026-11-15 实测）。

    ⇒ 找法依次是：
      1. 环境变量 `JHY_LANG_REPO`（显式指定，最优先）
      2. 兄弟目录 / 祖先目录下的 `JiHuiYiYou` / `JiHuiYiYou-compiler`
         （**认「有语料」**，不认名字 ⇒ 名字变了也不怕）
    """
    env = os.environ.get("JHY_LANG_REPO")
    if env:
        p = Path(env)
        if _looks_like_lang_repo(p):
            return p
    # 从本仓往上找（最多 6 层）——跟 `tests/helpers/repo.ts:findLangRepo` 同口径
    base = ROOT
    for _ in range(6):
        for name in LANG_DIR_NAMES:
            cand = base / name
            if _looks_like_lang_repo(cand):
                return cand
        if base.parent == base:
            break
        base = base.parent
    return None


def _looks_like_lang_repo(p: Path) -> bool:
    """这个目录**像**语言仓吗？（看有没有语料，不看名字）"""
    return (p / "bench" / "difftest.py").exists() or (p / "compiler" / "src0" / "main.jhyy").exists()


# ── 指纹 ────────────────────────────────────────────────────────────

def _norm(raw: bytes) -> bytes:
    """归一化行尾（CRLF → LF）。

    ⚠️ **为什么必须归一**：CI（Windows checkout，`core.autocrlf=true`）与
    本机的**行尾结束符可能不同** ⇒ 按原始字节算指纹 ⇒ 平台不一致 ⇒
    门在 CI 上假红（2026-11-15 实测踩过一次）。
    """
    return raw.replace(b"\r\n", b"\n")


def _sha(raw: bytes) -> str:
    return hashlib.sha256(_norm(raw)).hexdigest()[:16]


def _sha_tree(root: Path) -> str:
    """一个目录的聚合哈希（按相对路径排序 ⇒ 与文件系统顺序无关）。"""
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        h.update(p.relative_to(root).as_posix().encode("utf-8"))
        h.update(b"\x00")
        h.update(_norm(p.read_bytes()))
        h.update(b"\x00")
    return h.hexdigest()[:16]


def corpus_groups() -> tuple[dict[str, str], list[str]]:
    """⇒ (每组的哈希, 找不到的组)

    组 = 判「什么变了」的**最小单位**（组太细则锁文件大，组太粗则诊断没处下嘴）。
    """
    groups: dict[str, str] = {}
    missing: list[str] = []

    lang = find_lang_repo()
    if lang is None:
        missing.append("语言仓（设 `JHY_LANG_REPO` 或把它放在本仓的兄弟/祖先目录）")
    else:
        for rel in LANG_FILES:
            p = lang / rel
            if p.exists():
                groups[f"lang/{rel}"] = _sha(p.read_bytes())
            else:
                missing.append(f"lang/{rel}")
        ex = lang / LANG_EXAMPLES
        if ex.is_dir():
            files = [p for p in sorted(ex.rglob("*.jhyy")) if not p.name.startswith("_")]
            if not files:
                missing.append(f"lang/{LANG_EXAMPLES}（一个 .jhyy 都没有）")
            else:
                h = hashlib.sha256()
                for p in files:
                    h.update(p.relative_to(ex).as_posix().encode("utf-8"))
                    h.update(b"\x00")
                    h.update(_norm(p.read_bytes()))
                    h.update(b"\x00")
                groups[f"lang/{LANG_EXAMPLES}"] = h.hexdigest()[:16]
        else:
            missing.append(f"lang/{LANG_EXAMPLES}")

    for rel in GENERATORS:
        p = ROOT / rel
        if p.exists():
            groups[f"ide/{rel}"] = _sha(p.read_bytes())
        else:
            missing.append(f"ide/{rel}")

    return groups, missing


def corpus_sha(groups: dict[str, str]) -> str:
    """所有组的**聚合**哈希（组的键排序 ⇒ 与文件系统顺序无关）。"""
    h = hashlib.sha256()
    for k in sorted(groups):
        h.update(k.encode("utf-8"))
        h.update(b"\x00")
        h.update(groups[k].encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()[:16]


def artifact_hashes() -> dict[str, str]:
    """产物自己的哈希（抓「手改产物」/「产物没跟着重刷」）。"""
    out: dict[str, str] = {}
    for rel in ARTIFACT_FILES:
        p = ROOT / rel
        if p.exists():
            out[rel] = _sha(p.read_bytes())
    for rel in ARTIFACT_DIRS:
        d = ROOT / rel
        if d.is_dir():
            out[rel + "/"] = _sha_tree(d)
    return out


# ── 锁 ──────────────────────────────────────────────────────────────

def read_lock() -> dict | None:
    p = ROOT / LOCK_REL
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[refresh-artifacts] ⚠️ 锁文件读不出来：{e!r}", file=sys.stderr)
        return None
    return data if isinstance(data, dict) else None


def write_lock() -> int:
    groups, missing = corpus_groups()
    if missing:
        print("[refresh-artifacts] ✗ 找不到输入：\n  - " + "\n  - ".join(missing),
              file=sys.stderr)
        return 1
    lock = {
        "version": 1,
        "builtAt": __import__("datetime").datetime.now().isoformat(),
        "note": ("语料锁 —— 改了语料或生成器就要重刷任务集"
                 "（npm run eval:tasks && npm run eval:tasks:paired）"),
        "corpusSha256": corpus_sha(groups),
        "groups": groups,
        "artifacts": artifact_hashes(),
    }
    p = ROOT / LOCK_REL
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + "\n",
                 encoding="utf-8", newline="")
    print(f"[refresh-artifacts] ✓ 锁已写：{LOCK_REL}（corpusSha256={lock['corpusSha256']}）")
    return 0


# ── 判据 ────────────────────────────────────────────────────────────

def diagnose() -> tuple[bool, list[str]]:
    """⇒ (是不是最新, 人类能读的说明行)"""
    groups, missing = corpus_groups()
    lock = read_lock()
    lines: list[str] = []
    ok = True

    # ⚠️ **先说「在哪儿找的」** —— CI 上找不到语言仓是最常见的事故，
    #   而「找不到」如果没有下文，就只能猜（2026-11-15 在 CI 上白找了一轮）。
    lang = find_lang_repo()
    lines.append(f"语言仓：`{lang}`" if lang else "语言仓：**没找到**")
    lines.append(f"本仓：`{ROOT}`")

    if missing:
        ok = False
        lines.append("**找不到输入**：")
        lines += [f"- {m}" for m in missing]

    if lock is None:
        ok = False
        lines.append(f"**没有锁文件**（{LOCK_REL}）⇒ 产物是「没有指纹的旧流程」"
                     "生成的 ⇒ 重刷一次就有了。")
        return ok, lines

    current = corpus_sha(groups) if groups else ""
    recorded = lock.get("corpusSha256")
    if recorded != current:
        ok = False
        lines.append(f"**语料指纹对不上**：锁里 `{recorded}` ≠ 现在 `{current}`")
        old_groups = lock.get("groups") or {}
        for k in sorted(set(old_groups) | set(groups)):
            a, b = old_groups.get(k), groups.get(k)
            if a != b:
                lines.append(f"- `{k}`：{a} → {b}")
    else:
        lines.append(f"语料指纹对得上（`{current}`）")

    old_art = lock.get("artifacts") or {}
    new_art = artifact_hashes()
    for k in sorted(set(old_art) | set(new_art)):
        a, b = old_art.get(k), new_art.get(k)
        if a != b:
            ok = False
            if a is None:
                lines.append(f"- 产物 `{k}`：**锁里没有**（新加的？）")
            elif b is None:
                lines.append(f"- 产物 `{k}`：**文件不见了**")
            else:
                lines.append(f"- 产物 `{k}`：{a} → {b}（产物被改过，或没跟着重刷）")
    if not old_art:
        ok = False
        lines.append("- 锁里**没有产物哈希** ⇒ 旧版锁 ⇒ 重刷一次就有了。")

    # 附上当前各组的哈希 —— 绿了也要看得见「到底比的是啥」
    lines.append("各输入组（现在）：")
    lines += [f"- `{k}` = `{v}`" for k, v in sorted(groups.items())]
    lines.append("各产物（现在）：")
    lines += [f"- `{k}` = `{v}`" for k, v in sorted(new_art.items())]

    return ok, lines


def report(ok: bool, lines: list[str]) -> None:
    """把结论说清楚 —— **stderr**（CI 日志）+ **注解**（公开可读）+ **step summary**。"""
    head = "✅ 任务集是最新的" if ok else "❌ 任务集**过期**了"
    body = "\n".join(lines)
    print(f"[refresh-artifacts] {head}\n{body}", file=sys.stderr)

    if not ok:
        # ⚠️ **发一条 GitHub 注解** —— 注解在 PR 的「Checks」页里**直接能看**，
        #   而且 `check-runs` 的公开 API 能读到（**日志要鉴权，注解不要**）
        #   ⇒ 门红的时候，不登录也能知道**差在哪**（2026-11-15 实测踩过：
        #   日志读不到 ⇒ 只能靠猜）。
        msg = (head + "：" + " / ".join(lines))[:1500]
        print("::error title=评测任务集过期::" + _gh_escape(msg), file=sys.stderr)

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        try:
            with open(summary, "a", encoding="utf-8") as f:
                f.write(f"## {head}\n\n{body}\n\n")
        except OSError as e:
            print(f"[refresh-artifacts] ⚠️ step summary 写不进去：{e!r}", file=sys.stderr)


def _gh_escape(s: str) -> str:
    """GitHub 工作流命令的转义：`%` → `%25`，换行 → `%0A`。"""
    return s.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--should-refresh", action="store_true",
                    help="只判断：该刷吗？（退出码 0 = 该刷）")
    ap.add_argument("--write-lock", action="store_true", help="把当前的指纹写进锁")
    ap.add_argument("--stage", action="store_true", help="把产物 + 锁 git add 进去")
    ap.add_argument("--check", action="store_true", help="只查不改（CI 那道门）")
    args = ap.parse_args()

    if args.stage:
        for f in ARTIFACT_FILES + [LOCK_REL]:
            subprocess.run(["git", "add", "--", f], cwd=str(ROOT))
        subprocess.run(["git", "add", "--", "eval/tasks-paired"], cwd=str(ROOT))
        print("[refresh-artifacts] ✓ 产物 + 锁已进暂存区")
        return 0

    if args.write_lock:
        return write_lock()

    ok, lines = diagnose()

    if args.should_refresh:
        if not ok:
            print("[refresh-artifacts] 评测任务集过期了 ⇒ 要重刷")
        return 0 if not ok else 1

    if args.check:
        report(ok, lines)
        if not ok:
            print("[refresh-artifacts] ⇒ 跑 `npm run eval:tasks && npm run eval:tasks:paired`"
                  "（重刷完再 `python scripts/dev/refresh-artifacts.py --write-lock`）",
                  file=sys.stderr)
        return 0 if ok else 1

    # 默认：自己刷（Windows 的 Python 跑不了 npm ⇒ 交给 shell）
    print("[refresh-artifacts] ⚠️ 请用 `.githooks/pre-commit`（或 `sh -c`）跑刷新 —— "
          "生成器是 `npm run …`，Windows 的 Python 找不到 npm。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
