"""看**一道题**的完整工具轨迹（零 API 成本）。

    python scripts/eval/show-task.py <run.jsonl> <taskId 子串>
"""

import json
import sys
from pathlib import Path


def main():
    path, needle = sys.argv[1], sys.argv[2]
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if needle not in str(r.get("taskId")):
            continue
        print("=" * 78)
        print("task:", r.get("taskId"), " mut:", r.get("mutationId"))
        u = r.get("usage") or {}
        print("usage:", json.dumps(u, ensure_ascii=False))
        print("firstPass:", r.get("firstPass"), "finalPass:", r.get("finalPass"))
        print("reason:", str(r.get("reason"))[:300])
        traj = r.get("trajectory") or []
        print("工具调用 %d 次：" % len(traj))
        for i, t in enumerate(traj):
            what = str(t.get("what", "")).replace("\n", " ")[:120]
            res = str(t.get("result", "")).replace("\n", " ")[:160]
            print("  %3d [%-12s] %-12s %s" % (i, t.get("kind"), t.get("tool"), what))
            if res.strip():
                print("       → %s" % res)
        print()
        print("答案（截断 3000 字）：")
        print(str(r.get("answer"))[:3000])


if __name__ == "__main__":
    main()
