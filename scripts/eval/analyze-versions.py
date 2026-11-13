"""一次性分析脚本：用**已有的 grades 数组**（零 API 成本）把「轮数」拆成
**试错开销**（到第一次通过为止）和 **过度验证开销**（通过之后还在改）。

    python scripts/eval/analyze-versions.py <a.jsonl> [<b.jsonl> ...]

为什么拆：**总轮数**这个数字混了两件事 ——
  · **试错**：改了 N 版才编译过 ⇒ 知识不够
  · **过度验证**：编译过了还在改 ⇒ 边界不清 / 怕改错

⇒ 两者的优化方向**相反**：
  · 试错多 ⇒ 要**更多知识**（知识包 / 错误索引 / 更好的报错）
  · 过度验证多 ⇒ 要**更清楚的任务边界**（收紧措辞 / hook 自动验）
"""

import json
import sys
from pathlib import Path


def load(path):
    return [
        json.loads(l)
        for l in Path(path).read_text(encoding="utf-8").splitlines()
        if l.strip()
    ]


def stats(recs):
    trial = []       # 到第一次通过为止，试了几版
    over = []        # 通过之后又多改了几版
    total = []
    first_rate = 0
    final_rate = 0
    for r in recs:
        grades = r.get("grades") or []
        passes = [i for i, g in enumerate(grades) if g.get("passed")]
        total.append(len(grades))
        if passes:
            first_rate += 1
            final_rate += 1
            trial.append(passes[0] + 1)
            over.append(len(grades) - passes[-1] - 1)
        else:
            trial.append(len(grades))
            over.append(0)
    n = len(recs) or 1

    def avg(xs):
        return sum(xs) / len(xs) if xs else 0.0

    return {
        "n": len(recs),
        "first": first_rate,
        "final": final_rate,
        "trial": avg(trial),
        "over": avg(over),
        "total": avg(total),
        "n_total": sum(total),
    }


def main():
    files = sys.argv[1:]
    if not files:
        print(__doc__)
        sys.exit(1)
    print("%-46s %5s %8s %8s %8s %8s" % ("run", "题", "首过", "试错版", "过度改", "总版"))
    for f in files:
        s = stats(load(f))
        print(
            "%-46s %5d %8s %8.1f %8.1f %8.1f"
            % (
                Path(f).name[:44],
                s["n"],
                "%d/%d" % (s["first"], s["n"]),
                s["trial"],
                s["over"],
                s["total"],
            )
        )


if __name__ == "__main__":
    main()
