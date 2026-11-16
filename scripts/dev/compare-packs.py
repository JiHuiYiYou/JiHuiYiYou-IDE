#!/usr/bin/env python3
"""**新旧知识包**的对比（零 API 成本，只读 jsonl）。

    python scripts/dev/compare-packs.py <旧包.jsonl> <新包.jsonl>

⚠️ **口径**：新包通常是 n=1、旧包是 n=3 ⇒ **不能**直接比「总数」，
⇒ 只比**每次运行的均值**（轮数 / 查规范次数）⇒ 那两个是**率**，可比。

⇒ 另给**逐题**对照（每题取中位）⇒ 看**方向**（哪几题变好/变差），
⇒ **注意 n=1 的噪声很大**（实测 ±5 轮/题）⇒ 逐题只当**线索**，
⇒ **结论看均值 + 查规范率**。
"""

import json
import sys
from collections import Counter, defaultdict
from statistics import median


def load(path):
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def turns(rec):
    return (rec.get("usage") or {}).get("turns") or 0


def kinds(rec):
    return Counter(t.get("kind") for t in (rec.get("trajectory") or []))


def summary(recs, label):
    n = len(recs)
    t = sum(turns(r) for r in recs)
    k = Counter()
    for r in recs:
        k.update(kinds(r))
    spec = k.get("mcp:spec", 0)
    ledger = k.get("mcp:ledger", 0)
    find = k.get("find-tool", 0)
    print("%-10s 记录=%-3d 总轮=%-5d 均轮=%-6.2f 查规范=%-3d (%.2f/次) "
          "查台账=%-2d 找工具=%-3d (%.2f/次)"
          % (label, n, t, t / n, spec, spec / n, ledger, find, find / n))
    return {"n": n, "turns": t, "spec": spec, "ledger": ledger, "find": find}


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    old = load(sys.argv[1])
    new = load(sys.argv[2])
    print("════ 总体（比的是**每次运行的均值**）════")
    a = summary(old, "旧包")
    b = summary(new, "新包")
    print("%-10s Δ均轮=%+.2f (%+.1f%%)   Δ查规范/次=%+.2f (%+.1f%%)   "
          "Δ找工具/次=%+.2f"
          % ("", b["turns"] / b["n"] - a["turns"] / a["n"],
             (b["turns"] / b["n"] - a["turns"] / a["n"]) / (a["turns"] / a["n"]) * 100,
             b["spec"] / b["n"] - a["spec"] / a["n"],
             (b["spec"] / b["n"] - a["spec"] / a["n"]) / (a["spec"] / a["n"]) * 100,
             b["find"] / b["n"] - a["find"] / a["n"]))
    print()

    print("════ 逐题（每题中位；**n=1 噪声大，只当线索**）════")
    ta = defaultdict(list)
    tb = defaultdict(list)
    for r in old:
        ta[r["taskId"]].append(turns(r))
    for r in new:
        tb[r["taskId"]].append(turns(r))
    print("%-34s %7s %7s %8s" % ("题", "旧包", "新包", "Δ"))
    up = down = 0
    for t in sorted(set(ta) & set(tb)):
        ma, mb = median(ta[t]), median(tb[t])
        mark = ""
        if mb < ma:
            up += 1
            mark = " ✓"
        elif mb > ma:
            down += 1
            mark = " ✗"
        print("%-34s %7d %7d %8d%s" % (t[:34], ma, mb, mb - ma, mark))
    print("⇒ 变好 %d 题 / 变差 %d 题（n=1 ⇒ 只当线索）" % (up, down))
    return 0


if __name__ == "__main__":
    sys.exit(main())
