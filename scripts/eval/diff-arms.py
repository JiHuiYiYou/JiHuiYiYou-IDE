"""逐题对比两个评测臂（零 API 成本）：**只统计跑完的题**，把「跑挂的」单列。

    python scripts/eval/diff-arms.py <a.jsonl> <b.jsonl>

## 为什么必须把「跑挂的」单列

评测里 `finalPass=False` 有两种完全不同的原因：

| 原因 | 含义 | 该不该算模型的错 |
|---|---|---|
| 模型写错了 | 真·能力问题 | **该算** |
| **这次运行被掐断**（超时 / CLI 崩 / usage 空） | 基础设施故障 | **不该算** |

⇒ 混在一起 ⇒ **把超时算成模型的锅** ⇒ 结论全歪。

⚠️ **实测踩过（2026-11-13）**：默认超时只有 300 秒 ⇒ 每个臂都有 **6~8/29 题**
   被掐断（答案停在半路）⇒ 「hook 让正确率掉 10%」这个结论**完全是超时造成的假象**
   —— hook 臂退步的 5 题**全部**是被掐断的题。

⇒ 结论：**评测的默认超时必须够长**，而且**正确率只在跑完的题上统计**。
"""

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path


def load(path):
    recs = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        recs[r["taskId"]] = r
    return recs


def usage(r):
    return r.get("usage") or {}


def hung(r):
    """这次运行**没跑完** —— usage 空 ⇒ 没跑到 harness 收数的时候。

    ⚠️ **判据**：usage 整个为空（连 turns 都没有）⇒ CLI 没正常结束。
       （有 turns 只是 turns=0 的那种另说。）
    """
    return not usage(r)


def turns(r):
    return usage(r).get("turns", 0)


def cost(r):
    return usage(r).get("costUsd", 0.0)


def kinds(r):
    c = Counter()
    for t in r.get("trajectory") or []:
        c[t.get("kind", "?")] += 1
    return c


def compile_errors(r):
    """这道题里模型**撞到的编译错误**（按错误文本归并）。

    ⚠️ **为什么要有这个指标** —— 「通过率」是 29 个 0/1 的和 ⇒ n=1 噪声 ±5 题
    ⇒ ⇒ 「hook 让正确率掉 5 题」这种结论**判不了**。
    ⇒ 而**错型频率**是**事件计数**（几十次）⇒ 噪声 ±1~2 ⇒ ⇒
    ⇒ **「某条规则有没有消掉它对应的那个坑」用 n=1 就能回答** ✓
    """
    c = Counter()
    for t in r.get("trajectory") or []:
        # ⚠️ **只取到引号/反斜杠/换行为止** —— 工具结果里的 JSON 尾巴
        #   （`\\n`、`C:\\Users\\...`）会把同一种错误拆成好几行
        #   （「type mismatch in binary\nsemantic errors\n」和
        #   「type mismatch in binary\nC:\Users\...」其实是同一种）。
        for m in re.finditer(r'error: ([^"\\\n\r]{3,60})', str(t.get("result", ""))):
            c[m.group(1).strip()] += 1
    return c


def report(tag, recs, common):
    """一个臂的统计。"""
    done = [t for t in common if not hung(recs[t])]
    passed = [t for t in done if recs[t].get("finalPass")]
    return {
        "done": len(done),
        "hung": len(common) - len(done),
        "pass": len(passed),
        "rate": (len(passed) / len(done) * 100) if done else 0.0,
        "turns": sum(turns(recs[t]) for t in done),
        "turns_done_avg": (sum(turns(recs[t]) for t in done) / len(done)) if done else 0.0,
        "cost": sum(cost(recs[t]) for t in done),
    }


def main():
    a_path, b_path = sys.argv[1], sys.argv[2]
    A, B = load(a_path), load(b_path)
    common = [t for t in A if t in B]
    print("A = %s" % Path(a_path).name)
    print("B = %s" % Path(b_path).name)
    print("共同任务：%d\n" % len(common))

    ra, rb = report("A", A, common), report("B", B, common)

    print("──── 总量（**只统计跑完的题**）────")
    print("%-26s %6s %6s %8s %8s %10s" % ("", "跑完", "掐断", "写对", "正确率", "总轮数"))
    for tag, r in (("A", ra), ("B", rb)):
        print("%-26s %6d %6d %8d %7.1f%% %10d" % (
            tag, r["done"], r["hung"], r["pass"], r["rate"], r["turns"]))
    print("%-26s %6s %6s %8s %8s %10s" % (
        "B - A", "%+d" % (rb["done"] - ra["done"]), "%+d" % (rb["hung"] - ra["hung"]),
        "%+d" % (rb["pass"] - ra["pass"]),
        "%+.1f pt" % (rb["rate"] - ra["rate"]),
        "%+d" % (rb["turns"] - ra["turns"])))
    print()

    # 按错型看
    by_mut = defaultdict(list)
    for t in common:
        by_mut[A[t].get("mutationId", "?")].append(t)
    print("──── 按错型（只算跑完的题）────")
    print("%-16s %3s | %-22s | %-22s" % ("错型", "题", "A 写对/跑完/轮", "B 写对/跑完/轮"))
    for m in sorted(by_mut):
        ts = by_mut[m]
        cells = []
        for recs in (A, B):
            done = [t for t in ts if not hung(recs[t])]
            p = sum(1 for t in done if recs[t].get("finalPass"))
            tr = sum(turns(recs[t]) for t in done)
            cells.append("%d/%d/%d" % (p, len(done), tr))
        print("%-16s %3d | %-22s | %-22s" % (m, len(ts), cells[0], cells[1]))
    print()

    # 工具调用分布
    ka, kb = Counter(), Counter()
    for t in common:
        if hung(A[t]) or hung(B[t]):
            continue
        ka.update(kinds(A[t]))
        kb.update(kinds(B[t]))
    print("──── 工具调用分布（只算两臂都跑完的题，A → B）────")
    print("%-14s %6s %6s %8s" % ("kind", "A", "B", "B-A"))
    for k in sorted(set(ka) | set(kb), key=lambda x: -(kb[x] - ka[x])):
        d = kb[k] - ka[k]
        mark = "  ←↓" if d < 0 else ("  ←↑" if d > 0 else "")
        print("%-14s %6d %6d %+8d%s" % (k, ka[k], kb[k], d, mark))
    print("%-14s %6d %6d %+8d" % ("TOTAL", sum(ka.values()), sum(kb.values()),
                                  sum(kb.values()) - sum(ka.values())))
    print()

    # ── **错型频率**（比通过率灵敏得多 ⇒ n=1 就能用）────────────────
    ea = Counter()
    eb = Counter()
    for t in common:
        if hung(A[t]) or hung(B[t]):
            continue
        ea.update(compile_errors(A[t]))
        eb.update(compile_errors(B[t]))
    print("──── 编译错误**频率**（比通过率灵敏 ⇒ n=1 就能用）────")
    if not ea and not eb:
        print("  （两个臂都没撞到编译错误）")
    else:
        print("  %-42s %5s %5s %6s" % ("错误", "A", "B", "B-A"))
        for k in sorted(set(ea) | set(eb), key=lambda x: -(eb[x] - ea[x])):
            d = eb[k] - ea[k]
            mark = "  ←↓" if d < 0 else ("  ←↑" if d > 0 else "")
            print("  %-42s %5d %5d %+6d%s" % (k[:42], ea[k], eb[k], d, mark))
        print("  %-42s %5d %5d %+6d" % (
            "合计", sum(ea.values()), sum(eb.values()),
            sum(eb.values()) - sum(ea.values())))
    print()

    # 结论变了的题 —— **标明是不是掐断造成的**
    print("──── 结论变了的题 ────")
    for t in common:
        fa, fb = bool(A[t].get("finalPass")), bool(B[t].get("finalPass"))
        if fa == fb:
            continue
        ha, hb = hung(A[t]), hung(B[t])
        why = []
        if ha:
            why.append("A掐断")
        if hb:
            why.append("B掐断")
        print("  %-28s %-14s A→B %s→%s  (%s)" % (
            t[:28], A[t].get("mutationId", ""),
            "对" if fa else "错", "对" if fb else "错",
            "、".join(why) or "两边都跑完了"))


if __name__ == "__main__":
    main()
