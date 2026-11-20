#!/usr/bin/env python3
"""诊断：把题库里**编译不过**的题逐个编译一遍，打印第一��错误。

    python scripts/dev/quiz-diag.py [题id ...]

⚠️ **为什么要有这个** —— 生成器一次只报「哪道题不行」，
   ⇒ 加题时**一轮只修几道** ⇒ ⇒ 这个脚本**一次看全** ⇒ 改得快。
"""

import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVAL = HERE.parent / "eval"
sys.path.insert(0, str(EVAL))
# ⚠️ 生成器的文件名带连字符 ⇒ 不能直接 import ⇒ 用 importlib 按路径加载
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("gen_quiz_tasks", EVAL / "gen-quiz-tasks.py")
_gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_gen)
HELPER, QUIZ = _gen.HELPER, _gen.QUIZ
from quiz_bank import BREADTH  # noqa: E402

JHY = Path(__file__).resolve().parents[3] / "JiHuiYiYou" / "compiler" / "build" / "bin" / "jhyy.exe"

ALL = QUIZ + BREADTH
want = set(sys.argv[1:])


def build(q):
    imports = "".join(l + "\n" for l in q.get("imports", []))
    return (
        imports
        + HELPER
        + q.get("extra", "")
        + q["code"]
        + "\nfn main_jhyy() -> i32 {\n    print_i64(f());\n    return 0;\n}\n"
    )


def main():
    tmp = Path(tempfile.mkdtemp(prefix="jhdiag-"))
    bad = 0
    for q in ALL:
        if want and q["id"] not in want:
            continue
        path = tmp / (q["id"].replace("/", "_") + ".jhyy")
        path.write_text(build(q), encoding="utf-8")
        r = subprocess.run(
            [str(JHY), "compile", str(path), "-o", str(tmp / "out")],
            capture_output=True, text=True, errors="replace", timeout=120,
        )
        if r.returncode != 0:
            bad += 1
            errs = [ln for ln in (r.stderr or "").splitlines() if "error" in ln]
            print("✗ %-34s %s" % (q["id"], (errs[0] if errs else "?")[:120]))
    print("⇒ 编译不过的：%d 道" % bad)
    return 0


if __name__ == "__main__":
    sys.exit(main())
