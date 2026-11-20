#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""**推理题的广度批** —— 覆盖知识包里剩下的规则。

    被 scripts/eval/gen-quiz-tasks.py import 进去。

## 为什么单独一个文件

「第一批 18 道」是**核心的反直觉点**（每一道都是「按 C 的直觉答就会错」）。
这一批是**广度**（覆盖包里剩下的规则）⇒ ⇒ 目的不同 ⇒ 分开放。

## 每道题的字段

| 字段 | 含义 |
|---|---|
| `id` | 题 id |
| `title` | 题面小标题 |
| `rule` | 对应哪条规则（知识包里的那句话） |
| `code` | 给模型的**一段函数**（没有 `main_jhyy` ⇒ 跑不起来） |
| `extra` | 可选：**顶层**声明（`type` / `const` / `let`）⇒ 放在 `code` 前面 |
| `imports` | 可选：import 行 ⇒ 放在最前面 |

⚠️ **期望值不由这里给** —— 生成器**真编译真跑**算出来 ⇒ ⇒
⇒ 这里写错语义，生成器会算出一个「错的但自洽的」期望值 ⇒ ⇒
⇒ **语义对不对，要靠人读一遍**（生成器只保证「这段代码的行为被如实记录」）。

⚠️⚠️ **写题时自己的两个坑**（都咬过我一遍）：
1. **`as` 与 `*` 同级** ⇒ `r as i64 * 10` 是 `r as (i64 * 10)` ⇒ **必须加括号**。
2. **i64 表达式里的整数字面量也要带 `i64` 后缀** ⇒ `x as i64 * 100` 里的 `100` 是
   **i32** ⇒ `i64 * i32` ⇒ **type mismatch in binary**。

⚠️ **只收「语义题」** —— 「这段代码能编译吗」那一类**不在这里**
（判分口径不一样：那个要判「模型说了什么」，容易变成**文字游戏**）。
⇒ ⇒ 编译类的规则由**翻译题**覆盖（模型自己写 ⇒ 编不过就撞上真错误）。
"""

BREADTH = [
    {
        "id": "quiz/shift-left-wrap",
        "title": "左移溢出",
        "rule": "`<<` 溢出是回绕（不报错）",
        "code": """fn f() -> i64 {
    let a: i32 = 1;
    return (a << 31) as i64;
}""",
    },
    {
        "id": "quiz/not-vs-tilde",
        "title": "`!` 与 `~` 不是一回事",
        "rule": "`!` 是逻辑非；`~` 是按位取反",
        "code": """fn f() -> i64 {
    let c: bool = false;
    let n: bool = !c;
    let t: i32 = ~0i32;
    if n {
        return (t as i64) * 10i64 + 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/as-narrow-truncate",
        "title": "`as` 窄化会截断",
        "rule": "`as` 到更窄的类型 ⇒ 截断",
        "code": """fn f() -> i64 {
    let x: u32 = 3000000000u32;
    return (x as i32) as i64;
}""",
    },
    {
        "id": "quiz/u64-to-i64",
        "title": "u64 拓宽到 i64",
        "rule": "u64 → i64 是零扩展（装不下就当无符号读）",
        "code": """fn f() -> i64 {
    let x: u64 = 18446744073709551615u64;
    return x as i64;
}""",
    },
    {
        "id": "quiz/u32-to-u64",
        "title": "u32 拓宽到 u64",
        "rule": "u32 → u64 是零扩展",
        "code": """fn f() -> i64 {
    let x: u32 = 4294967295u32;
    let y: u64 = x as u64;
    return y as i64;
}""",
    },
    {
        "id": "quiz/u8-literal-overflow",
        "title": "u8 字面量**超出范围**",
        "rule": "字面量超出声明类型范围 ⇒ **不报错**（W-228）",
        "code": """fn f() -> i64 {
    let x: u8 = 300u8;
    return x as i64;
}""",
    },
    {
        "id": "quiz/i32-literal-overflow",
        "title": "i32 字面量**超出范围**",
        "rule": "字面量超出声明类型范围 ⇒ **不报错**（W-228）",
        "code": """fn f() -> i64 {
    let x: i32 = 2147483648;
    return x as i64;
}""",
    },
    {
        "id": "quiz/short-circuit-and",
        "title": "`&&` 短路：右边**不求值**",
        "rule": "`&&` / `||` 是短路逻辑",
        "code": """fn side() -> i32 {
    print_i64(999 as i64);
    return 1;
}

fn f() -> i64 {
    let c: bool = false && (side() == 1);
    if c {
        return 0i64;
    }
    return 1i64;
}""",
    },
    {
        "id": "quiz/short-circuit-or",
        "title": "`||` 短路：右边**不求值**",
        "rule": "`&&` / `||` 是短路逻辑",
        "code": """fn side() -> i32 {
    print_i64(999 as i64);
    return 1;
}

fn f() -> i64 {
    let c: bool = true || (side() == 1);
    if c {
        return 7i64;
    }
    return 1i64;
}""",
    },
    {
        "id": "quiz/slice-write-through",
        "title": "切片写**穿透**到原数组",
        "rule": "切片是视图 ⇒ 写穿透",
        "code": """fn f() -> i64 {
    let mut arr: [i32; 4] = [10 as i32, 20 as i32, 30 as i32, 40 as i32];
    let base: [*]i32 = arr as [*]i32;
    let sub: [*]i32 = base[1..3];
    sub[0] = 99;
    return arr[1] as i64;
}""",
    },
    {
        "id": "quiz/len-array",
        "title": "`len()` 对数组",
        "rule": "`len()` 只接受切片 / 数组",
        "code": """fn f() -> i64 {
    let arr: [i32; 4] = [10 as i32, 20 as i32, 30 as i32, 40 as i32];
    return len(arr) as i64;
}""",
    },
    {
        "id": "quiz/alignof-enum",
        "title": "`alignof(enum)`",
        "rule": "`alignof(enum)` **恒为 4**（与布局算出来的不一致）",
        "code": """fn f() -> i64 {
    return (alignof(i64) as i64) * 100i64 + (alignof(Shape) as i64);
}""",
        "extra": """type Shape = enum {
    Circle,
    Square,
}
""",
    },
    {
        "id": "quiz/struct-eq-by-value",
        "title": "struct 的 `==` 按**值**比",
        "rule": "聚合类型的相等比较按值",
        "code": """type P = struct {
    x: i32,
    y: i32,
}

fn f() -> i64 {
    let a: P = P { x: 1 as i32, y: 2 as i32 };
    let b: P = P { x: 1 as i32, y: 2 as i32 };
    if a == b {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/match-arm-scope",
        "title": "match 的 arm 是**独立作用域**",
        "rule": "arm 的模式绑定**遮住**外层同名变量",
        "code": """type E = enum {
    A(i32),
    B,
}

fn f() -> i64 {
    let x: i32 = 7;
    let r: i32 = match E::A(3) {
        E::A(x) => x,
        E::B => 0,
    };
    return (r as i64) * 10i64 + x as i64;
}""",
    },
    {
        "id": "quiz/negative-zero",
        "title": "负零向 0 截断",
        "rule": "负零（`-0.0`）向 0 截断得 0",
        "code": """fn f() -> i64 {
    let z: f64 = -0.0;
    return (z as i32) as i64;
}""",
    },
    {
        "id": "quiz/u32-div-vs-i32",
        "title": "u32 除法是**无符号**的",
        "rule": "整数 `/` 按操作数类型分流（无符号 ⇒ 无符号语义）",
        "code": """fn f() -> i64 {
    let a: u32 = 4294967295u32;
    let q: u32 = a / 2u32;
    return q as i64;
}""",
    },
    {
        "id": "quiz/u32-mod",
        "title": "u32 取模",
        "rule": "整数 `%` 按操作数类型分流",
        "code": """fn f() -> i64 {
    let a: u32 = 4294967295u32;
    let m: u32 = a % 10u32;
    return m as i64;
}""",
    },
    {
        "id": "quiz/i32-rem-negative-divisor",
        "title": "负数作除数时取模的符号",
        "rule": "整数取模**向 0 截断**",
        "code": """fn f() -> i64 {
    let a: i32 = 7;
    let b: i32 = -3;
    return (a % b) as i64;
}""",
    },
    {
        "id": "quiz/u32-shift-right-31",
        "title": "u32 右移是**逻辑**的",
        "rule": "u32 的 `>>` 是逻辑右移（零填充）",
        "code": """fn f() -> i64 {
    let a: u32 = 2147483648u32;
    return (a >> 31u32) as i64;
}""",
    },
    {
        "id": "quiz/i32-shift-left",
        "title": "i32 左移",
        "rule": "`<<` 恒为逻辑左移",
        "code": """fn f() -> i64 {
    let a: i32 = 3;
    return (a << 4) as i64;
}""",
    },
    {
        "id": "quiz/struct-value-return",
        "title": "struct 按值返回",
        "rule": "struct 按值传参/返回是支持的（递归复制）",
        "code": """type P = struct {
    x: i32,
}

fn make(v: i32) -> P {
    return P { x: v };
}

fn f() -> i64 {
    let p: P = make(42);
    return p.x as i64;
}""",
    },
    {
        "id": "quiz/for-with-variable-end",
        "title": "`for` 的区间上界可以是**变量**",
        "rule": "for 的区间半开（上界不含）",
        "code": """fn f() -> i64 {
    let n: i32 = 4;
    let mut s: i32 = 0;
    for i in 0..n {
        s = s + i;
    }
    return s as i64;
}""",
    },
    {
        "id": "quiz/match-literal-patterns",
        "title": "match 的字面量 pattern",
        "rule": "match 支持字面量 pattern",
        "code": """fn f() -> i64 {
    let x: i32 = 2;
    let r: i32 = match x {
        0 => 10,
        1 => 20,
        2 => 30,
        _ => 40,
    };
    return r as i64;
}""",
    },
    {
        "id": "quiz/if-else-expression",
        "title": "if/else 是**表达式**",
        "rule": "if/else 的分支体是表达式不是语句块",
        "code": """fn f() -> i64 {
    let x: i32 = 5;
    let r: i32 = if x > 3 { 1 } else { 0 };
    return r as i64;
}""",
    },
    {
        "id": "quiz/float-to-int-in-range",
        "title": "浮点转整数（**在范围内**）",
        "rule": "浮点 → 整数是饱和语义（范围内按向 0 截断）",
        "code": """fn f() -> i64 {
    let x: f64 = 2.9;
    return (x as i32) as i64;
}""",
    },
    {
        "id": "quiz/int-to-float",
        "title": "整数转浮点",
        "rule": "整数 → 浮点要显式 `as`",
        "code": """fn f() -> i64 {
    let x: i32 = 3;
    let y: f64 = x as f64;
    return (y as i32) as i64;
}""",
    },
    {
        "id": "quiz/closure-no-capture-reads",
        "title": "闭包能读**字面量**",
        "rule": "闭包只能用**自己的参数**和字面量",
        "code": """fn f() -> i64 {
    let g = |v: i32| { v + 1 };
    return g(41) as i64;
}""",
    },
    {
        "id": "quiz/u16-narrow",
        "title": "u16 窄化",
        "rule": "`as` 到更窄的类型 ⇒ 截断",
        "code": """fn f() -> i64 {
    let x: u32 = 70000u32;
    let y: u16 = x as u16;
    return y as i64;
}""",
    },
    {
        "id": "quiz/i8-sign",
        "title": "i8 的符号",
        "rule": "有符号窄化 ⇒ 保留符号位",
        "code": """fn f() -> i64 {
    let x: i32 = 200;
    let y: i8 = x as i8;
    return y as i64;
}""",
    },
    {
        "id": "quiz/slice-sub-of-sub",
        "title": "切片的切片",
        "rule": "子切片是视图（半开）",
        "code": """fn f() -> i64 {
    let arr: [i32; 5] = [1 as i32, 2 as i32, 3 as i32, 4 as i32, 5 as i32];
    let base: [*]i32 = arr as [*]i32;
    let sub: [*]i32 = base[1..4];
    let sub2: [*]i32 = sub[0..2];
    return (len(sub2) as i64) * 10i64 + sub2[0] as i64;
}""",
    },
    {
        "id": "quiz/enum-in-struct",
        "title": "struct 里放 enum",
        "rule": "struct 字段可以是 enum",
        "code": """type E = enum {
    A,
    B,
}

type W = struct {
    e: E,
    n: i32,
}

fn f() -> i64 {
    let w: W = W { e: E::B, n: 5 };
    let r: i32 = match w.e {
        E::A => 1,
        E::B => 2,
    };
    return (r as i64) * 10i64 + w.n as i64;
}""",
    },
    {
        "id": "quiz/ptr-deref-read",
        "title": "经指针**读**",
        "rule": "`&x` 的类型是 `*T`",
        "code": """fn f() -> i64 {
    let x: i32 = 9;
    let p: *i32 = &x;
    return *p as i64;
}""",
    },
    {
        "id": "quiz/ptr-arith-read",
        "title": "经指针**算术**",
        "rule": "指针算术按元素大小走",
        "code": """fn f() -> i64 {
    let arr: [i32; 3] = [10 as i32, 20 as i32, 30 as i32];
    let p: *i32 = &arr[0];
    let q: *i32 = p + 1;
    return *q as i64;
}""",
    },
    {
        "id": "quiz/bool-not",
        "title": "`!` 作用在 bool 上",
        "rule": "`!` 是逻辑非",
        "code": """fn f() -> i64 {
    let b: bool = true;
    let c: bool = !b;
    if c {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/i64-min-plus-one",
        "title": "i64 的下界附近",
        "rule": "i64 的范围",
        "code": """fn f() -> i64 {
    let x: i64 = -9223372036854775807i64;
    return x as i64;
}""",
    },
    {
        "id": "quiz/match-underscore",
        "title": "match 的 `_` 兜底",
        "rule": "match 支持通配符 `_`",
        "code": """fn f() -> i64 {
    let x: i32 = 77;
    let r: i32 = match x {
        0 => 1,
        _ => 2,
    };
    return r as i64;
}""",
    },
    {
        "id": "quiz/nested-arith-precedence",
        "title": "算术优先级",
        "rule": "`+`/`-` 比 `*`/`/` 松",
        "code": """fn f() -> i64 {
    let r: i32 = 2 + 3 * 4;
    return r as i64;
}""",
    },
    {
        "id": "quiz/bitwise-vs-shift",
        "title": "位运算与移位的优先级",
        "rule": "移位比位运算紧",
        "code": """fn f() -> i64 {
    let a: i32 = 1;
    let b: i32 = 3;
    let r: i32 = a << b | 1;
    return r as i64;
}""",
    },
    {
        "id": "quiz/compare-chain",
        "title": "比较运算符的优先级",
        "rule": "比较比算术松",
        "code": """fn f() -> i64 {
    let a: i32 = 1;
    let b: i32 = 2;
    let c: i32 = 3;
    let r: bool = a + b == c;
    if r {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/unary-precedence",
        "title": "一元运算符的优先级",
        "rule": "一元比二元紧",
        "code": """fn f() -> i64 {
    let a: i32 = 0;
    let r: i32 = -a + 1;
    return r as i64;
}""",
    },
    {
        "id": "quiz/assign-vs-compare",
        "title": "比较的结果是 **bool**",
        "rule": "比较运算符产出 bool（不是 0/1）",
        "code": """fn f() -> i64 {
    let b: i32 = 1;
    let r: bool = b == 1;
    if r {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/slice-of-bytes",
        "title": "字节切片",
        "rule": "切片可以放 u8",
        "code": """fn f() -> i64 {
    let bytes: [u8; 3] = [65u8, 66u8, 67u8];
    let s: [*]u8 = bytes as [*]u8;
    return (s[0] as i64) * 100i64 + (s[2] as i64);
}""",
    },
    {
        "id": "quiz/cast-precedence-with-call",
        "title": "`as` 与函数调用",
        "rule": "`as` 的优先级跟 `*` 一样",
        "code": """fn two() -> u32 {
    return 2u32;
}

fn f() -> i64 {
    let a: u32 = 3000000000u32;
    let v: u64 = a * two() as u64;
    return v as i64;
}""",
    },
    {
        "id": "quiz/negative-literal-i32",
        "title": "负数字面量",
        "rule": "负号 + 字面量",
        "code": """fn f() -> i64 {
    let x: i32 = -2147483648;
    return x as i64;
}""",
    },
    {
        "id": "quiz/u32-max-plus-one",
        "title": "u32 上界 + 1",
        "rule": "u32 溢出回绕",
        "code": """fn f() -> i64 {
    let m: u32 = 4294967295u32;
    let w: u32 = m + 1u32;
    return w as i64;
}""",
    },
    {
        "id": "quiz/u32-literal-in-array",
        "title": "数组里的 u32 字面量",
        "rule": "整数字面量默认 i32（数组元素类型要对得上）",
        "code": """fn f() -> i64 {
    let arr: [u32; 3] = [1u32, 2u32, 3u32];
    return arr[2] as i64;
}""",
    },
    {
        "id": "quiz/i64-literal",
        "title": "i64 字面量",
        "rule": "整数字面量后缀",
        "code": """fn f() -> i64 {
    let x: i64 = 9223372036854775807;
    return x;
}""",
    },
    {
        "id": "quiz/u64-literal-max",
        "title": "u64 字面量上界",
        "rule": "各整数字面量后缀的取值范围",
        "code": """fn f() -> i64 {
    let x: u64 = 18446744073709551615u64;
    if x > 0u64 {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/i64-negative-min",
        "title": "i64 下界",
        "rule": "负号 + 量值 = 2⁶³ 是合法的",
        "code": """fn f() -> i64 {
    let x: i64 = -9223372036854775808i64;
    return x;
}""",
    },
    {
        "id": "quiz/hex-literal",
        "title": "十六进制字面量",
        "rule": "字面量的进制",
        "code": """fn f() -> i64 {
    let x: i32 = 0xFF;
    return x as i64;
}""",
    },
    {
        "id": "quiz/octal-literal",
        "title": "前导零 = 八进制",
        "rule": "前导零按八进制解释",
        "code": """fn f() -> i64 {
    let x: i32 = 077;
    return x as i64;
}""",
    },
    {
        "id": "quiz/binary-literal",
        "title": "二进制字面量",
        "rule": "字面量的进制",
        "code": """fn f() -> i64 {
    let x: i32 = 0b1010;
    return x as i64;
}""",
    },
    {
        "id": "quiz/defer-order",
        "title": "defer 的执行顺序",
        "rule": "defer 在函数返回前按**逆序**执行",
        "code": """fn f() -> i64 {
    print_i64(1 as i64);
    defer print_i64(2 as i64);
    defer print_i64(3 as i64);
    return 0i64;
}""",
    },
    {
        "id": "quiz/defer-not-triggered",
        "title": "末表达式的隐式返回**不触发** defer",
        "rule": "函数体末表达式的隐式返回不触发 defer",
        "code": """fn g() -> i64 {
    defer print_i64(5 as i64);
    0 as i64
}

fn f() -> i64 {
    let r: i64 = g();
    return r;
}""",
    },
    {
        "id": "quiz/defer-nested",
        "title": "嵌套函数的 defer",
        "rule": "defer 在**自己那个**函数返回前执行",
        "code": """fn inner() -> i64 {
    defer print_i64(1 as i64);
    return 0i64;
}

fn outer() -> i64 {
    defer print_i64(2 as i64);
    let r: i64 = inner();
    return r;
}

fn f() -> i64 {
    let r: i64 = outer();
    return r;
}""",
    },
    {
        "id": "quiz/struct-field-mut",
        "title": "struct 字段要 `let mut` 才能改",
        "rule": "要改的绑定必须 `let mut`",
        "code": """type P = struct {
    x: i32,
}

fn f() -> i64 {
    let mut p: P = P { x: 1 as i32 };
    p.x = 2;
    return p.x as i64;
}""",
    },
    {
        "id": "quiz/array-elem-mut",
        "title": "数组元素要 `let mut` 才能改",
        "rule": "要改的绑定必须 `let mut`",
        "code": """fn f() -> i64 {
    let mut arr: [i32; 2] = [1 as i32, 2 as i32];
    arr[0] = 9;
    return arr[0] as i64;
}""",
    },
    {
        "id": "quiz/slice-elem-mut",
        "title": "切片元素要 `let mut` 才能改",
        "rule": "要改的绑定必须 `let mut`",
        "code": """fn f() -> i64 {
    let mut arr: [i32; 2] = [1 as i32, 2 as i32];
    let s: [*]i32 = arr as [*]i32;
    s[0] = 9;
    return arr[0] as i64;
}""",
    },
    {
        "id": "quiz/pointer-to-mut",
        "title": "指针指向可变绑定",
        "rule": "经指针写要目标可变",
        "code": """fn f() -> i64 {
    let mut x: i32 = 5;
    let p: *i32 = &x;
    *p = 8;
    return x as i64;
}""",
    },
    {
        "id": "quiz/pointer-to-immutable",
        "title": "指针指向**不可变**绑定",
        "rule": "写保护未实装 ⇒ 静默不生效",
        "code": """fn f() -> i64 {
    let x: i32 = 5;
    let p: *i32 = &x;
    *p = 8;
    return x as i64;
}""",
    },
    {
        "id": "quiz/struct-pass-by-value",
        "title": "struct 按值传参：callee 改不到调用方的",
        "rule": "只有 struct 才是真按值",
        "code": """type P = struct {
    x: i32,
}

fn bump(p: P) {
    p.x = 99;
}

fn f() -> i64 {
    let mut p: P = P { x: 1 as i32 };
    bump(p);
    return p.x as i64;
}""",
    },
    {
        "id": "quiz/generic-struct",
        "title": "泛型 struct",
        "rule": "泛型要显式实例化",
        "code": """type Pair<T> = struct {
    a: T,
    b: T,
}

fn f() -> i64 {
    let p: Pair<i32> = Pair<i32> { a: 3 as i32, b: 4 as i32 };
    return (p.a as i64) * 10i64 + (p.b as i64);
}""",
    },
    {
        "id": "quiz/generic-fn",
        "title": "泛型函数",
        "rule": "泛型函数调用写 `::<T>`",
        "code": """fn max_of<T>(a: T, b: T) -> i32 {
    return 5;
}

fn f() -> i64 {
    return max_of::<i32>(3, 4) as i64;
}""",
    },
    {
        "id": "quiz/i32-to-f64-precision",
        "title": "i32 → f64",
        "rule": "整数 → 浮点（精确）",
        "code": """fn f() -> i64 {
    let x: i32 = 1000000;
    let y: f64 = x as f64;
    return (y as i32) as i64;
}""",
    },
    {
        "id": "quiz/f64-to-f32",
        "title": "f64 → f32 窄化",
        "rule": "f64 → f32 是值转换（收窄到单精度）",
        "code": """fn f() -> i64 {
    let x: f64 = 1.5;
    let y: f32 = x as f32;
    let z: f64 = y as f64;
    return (z as i32) as i64;
}""",
    },
    {
        "id": "quiz/array-to-slice-len",
        "title": "数组 → 切片（显式）",
        "rule": "数组 → 切片需要显式 `as [*]T`",
        "code": """fn f() -> i64 {
    let arr: [i32; 4] = [1 as i32, 2 as i32, 3 as i32, 4 as i32];
    let s: [*]i32 = arr as [*]i32;
    return len(s) as i64;
}""",
    },
    {
        "id": "quiz/string-literal-no-decay",
        "title": "字符串字面量**没有**隐式 decay",
        "rule": "无隐式 decay ⇒ 要显式 `as [*]u8`",
        "code": """fn f() -> i64 {
    let s: [*]u8 = "hello" as [*]u8;
    return len(s) as i64;
}""",
    },
    {
        "id": "quiz/while-loop",
        "title": "`while` 循环",
        "rule": "while 的条件是 bool",
        "code": """fn f() -> i64 {
    let mut i: i32 = 0;
    let mut s: i32 = 0;
    while i < 5 {
        s = s + i;
        i = i + 1;
    }
    return s as i64;
}""",
    },
    {
        "id": "quiz/break",
        "title": "`break` 跳出循环",
        "rule": "break 立刻跳出循环",
        "code": """fn f() -> i64 {
    let mut i: i32 = 0;
    while true {
        i = i + 1;
        if i > 3 {
            break;
        }
    }
    return i as i64;
}""",
    },
    {
        "id": "quiz/continue",
        "title": "`continue` 跳过本轮",
        "rule": "while 的 continue 直接跳到条件重测",
        "code": """fn f() -> i64 {
    let mut i: i32 = 0;
    let mut s: i32 = 0;
    while i < 6 {
        i = i + 1;
        if i % 2 == 0 {
            continue;
        }
        s = s + i;
    }
    return s as i64;
}""",
    },
    {
        "id": "quiz/shadowing",
        "title": "`let` 会**遮住**同名旧绑定",
        "rule": "只有 `let` 走 shadowing",
        "code": """fn f() -> i64 {
    let x: i32 = 1;
    let x: i32 = 2;
    return x as i64;
}""",
    },
    {
        "id": "quiz/enum-payload",
        "title": "枚举带 payload",
        "rule": "一个变体最多带一个 payload",
        "code": """type E = enum {
    A(i32),
    B,
}

fn f() -> i64 {
    let e: E = E::A(6);
    let r: i32 = match e {
        E::A(v) => v,
        E::B => 0,
    };
    return r as i64;
}""",
    },
    {
        "id": "quiz/enum-eq",
        "title": "枚举的 `==`",
        "rule": "聚合类型的相等比较按值",
        "code": """type E = enum {
    A,
    B,
}

fn f() -> i64 {
    let a: E = E::A;
    let b: E = E::A;
    if a == b {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/ptr-null",
        "title": "`null` 是什么类型",
        "rule": "null 要落到带类型的绑定上",
        "code": """fn f() -> i64 {
    let p: *u8 = null;
    if p == null {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/bool-operators",
        "title": "`&&` / `||` 作用在 bool 上",
        "rule": "短路逻辑",
        "code": """fn f() -> i64 {
    let a: bool = true;
    let b: bool = false;
    let c: bool = a && !b;
    if c {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/bit-operators",
        "title": "`&` / `|` / `^` 是**位**运算",
        "rule": "& | ^ << >> 是位运算",
        "code": """fn f() -> i64 {
    let a: i32 = 12;
    let b: i32 = 10;
    return ((a & b) as i64) * 100i64 + ((a | b) as i64) * 10i64 + ((a ^ b) as i64);
}""",
    },
    {
        "id": "quiz/array-index-assign",
        "title": "数组下标赋值",
        "rule": "数组可以按下标赋值",
        "code": """fn f() -> i64 {
    let mut arr: [i32; 3] = [1 as i32, 2 as i32, 3 as i32];
    arr[1] = 20;
    return arr[1] as i64;
}""",
    },
    {
        "id": "quiz/slice-index-assign",
        "title": "切片下标赋值（穿透）",
        "rule": "切片支持元素赋值（穿透）",
        "code": """fn f() -> i64 {
    let mut arr: [i32; 3] = [1 as i32, 2 as i32, 3 as i32];
    let base: [*]i32 = arr as [*]i32;
    base[2] = 30;
    return arr[2] as i64;
}""",
    },
    {
        "id": "quiz/struct-eq-field-by-field",
        "title": "struct `==` 逐字段比",
        "rule": "聚合类型的相等比较按值",
        "code": """type P = struct {
    x: i32,
    y: i32,
}

fn f() -> i64 {
    let a: P = P { x: 1 as i32, y: 2 as i32 };
    let b: P = P { x: 1 as i32, y: 3 as i32 };
    if a == b {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/nested-struct-literal",
        "title": "嵌套 struct 字面量",
        "rule": "字段值要显式带类型",
        "code": """type Inner = struct {
    v: i32,
}

type Outer = struct {
    inner: Inner,
    n: i32,
}

fn f() -> i64 {
    let o: Outer = Outer { inner: Inner { v: 4 as i32 }, n: 5 as i32 };
    return o.inner.v as i64;
}""",
    },
    {
        "id": "quiz/u32-to-f64",
        "title": "u32 → f64",
        "rule": "无符号拓宽",
        "code": """fn f() -> i64 {
    let x: u32 = 3000000000u32;
    let y: f64 = x as f64;
    return (y as i64) / 1000000000i64;
}""",
    },
    {
        "id": "quiz/float-add-precision",
        "title": "浮点加法",
        "rule": "浮点语义",
        "code": """fn f() -> i64 {
    let a: f64 = 0.5;
    let b: f64 = 0.25;
    return ((a + b) as i32) as i64;
}""",
    },
    {
        "id": "quiz/i32-div-exact",
        "title": "整除",
        "rule": "整数除法向 0 截断",
        "code": """fn f() -> i64 {
    let a: i32 = 7;
    let b: i32 = 2;
    return (a / b) as i64;
}""",
    },
    {
        "id": "quiz/u32-div-exact",
        "title": "无符号整除",
        "rule": "无符号语义",
        "code": """fn f() -> i64 {
    let a: u32 = 7u32;
    let b: u32 = 2u32;
    return (a / b) as i64;
}""",
    },
    {
        "id": "quiz/match-on-bool",
        "title": "match 一个 bool",
        "rule": "match 支持字面量 pattern",
        "code": """fn f() -> i64 {
    let b: bool = false;
    let r: i32 = match b {
        true => 1,
        false => 0,
    };
    return r as i64;
}""",
    },
    {
        "id": "quiz/if-without-else",
        "title": "if 没有 else",
        "rule": "if 的分支块类型 = 最后一条语句的类型",
        "code": """fn f() -> i64 {
    let mut n: i32 = 0;
    if n == 0 {
        n = 5;
    }
    return n as i64;
}""",
    },
    {
        "id": "quiz/sizeof",
        "title": "`sizeof`",
        "rule": "类型尺寸",
        "code": """fn f() -> i64 {
    return (sizeof(i32) as i64) * 100i64 + (sizeof(i64) as i64);
}""",
    },
    {
        "id": "quiz/alignof-i32",
        "title": "`alignof`",
        "rule": "对齐",
        "code": """fn f() -> i64 {
    return (alignof(i32) as i64) * 100i64 + (alignof(i64) as i64);
}""",
    },
    {
        "id": "quiz/struct-sizeof",
        "title": "`sizeof(struct)`",
        "rule": "字段顺序 = 自然对齐的结果",
        "code": """type P = struct {
    a: i32,
    b: i64,
}

fn f() -> i64 {
    return sizeof(P) as i64;
}""",
    },
    {
        "id": "quiz/enum-sizeof",
        "title": "`sizeof(enum)`",
        "rule": "枚举的尺寸",
        "code": """type E = enum {
    A,
    B,
}

fn f() -> i64 {
    return sizeof(E) as i64;
}""",
    },
    {
        "id": "quiz/nested-struct-sizeof",
        "title": "`sizeof(嵌套 struct)`",
        "rule": "字段顺序 = 自然对齐的结果",
        "code": """type Inner = struct {
    v: i32,
}

type Outer = struct {
    inner: Inner,
    n: i32,
}

fn f() -> i64 {
    return sizeof(Outer) as i64;
}""",
    },
    {
        "id": "quiz/i64-add-overflow",
        "title": "i64 加法回绕",
        "rule": "整数溢出是回绕",
        "code": """fn f() -> i64 {
    let m: i64 = 9223372036854775807;
    let w: i64 = m + 1i64;
    return w;
}""",
    },
    {
        "id": "quiz/i64-mul-overflow",
        "title": "i64 乘法回绕",
        "rule": "整数溢出是回绕",
        "code": """fn f() -> i64 {
    let m: i64 = 3037000500i64;
    let w: i64 = m * m;
    return w;
}""",
    },
    {
        "id": "quiz/u64-mul-overflow",
        "title": "u64 乘法回绕",
        "rule": "整数溢出是回绕",
        "code": """fn f() -> i64 {
    let m: u64 = 18446744073709551615u64;
    let w: u64 = m * 2u64;
    return w as i64;
}""",
    },
    {
        "id": "quiz/i32-sub-overflow",
        "title": "i32 减法回绕",
        "rule": "整数溢出是回绕",
        "code": """fn f() -> i64 {
    let m: i32 = -2147483648;
    let w: i32 = m - 1i32;
    return w as i64;
}""",
    },
    {
        "id": "quiz/ptr-add-element-size",
        "title": "指针算术按元素大小",
        "rule": "指针算术按元素大小走",
        "code": """fn f() -> i64 {
    let arr: [i32; 3] = [10 as i32, 20 as i32, 30 as i32];
    let p: *i32 = &arr[0];
    let q: *i32 = p + 2;
    return *q as i64;
}""",
    },
    {
        "id": "quiz/ptr-add-bytes",
        "title": "指针算术按字节（`*u8`）",
        "rule": "指针算术按元素大小走",
        "code": """fn f() -> i64 {
    let bytes: [u8; 4] = [10u8, 20u8, 30u8, 40u8];
    let p: *u8 = &bytes[0];
    let q: *u8 = p + 2;
    return *q as i64;
}""",
    },
    {
        "id": "quiz/nested-fn-call",
        "title": "函数调用结果",
        "rule": "调用",
        "code": """fn g(v: i32) -> i32 {
    return v + 1;
}

fn f() -> i64 {
    return g(g(1)) as i64;
}""",
    },
    {
        "id": "quiz/recursion",
        "title": "递归",
        "rule": "递归函数",
        "code": """fn fact(n: i64) -> i64 {
    if n <= 1 {
        return 1i64;
    }
    return n * fact(n - 1i64);
}

fn f() -> i64 {
    return fact(5i64);
}""",
    },
    {
        "id": "quiz/u8-add-wrap",
        "title": "u8 加法回绕",
        "rule": "整数溢出是回绕",
        "code": """fn f() -> i64 {
    let a: u8 = 250u8;
    let b: u8 = a + 10u8;
    return b as i64;
}""",
    },
    {
        "id": "quiz/i8-add-wrap",
        "title": "i8 加法回绕",
        "rule": "整数溢出是回绕",
        "code": """fn f() -> i64 {
    let a: i8 = 120i8;
    let b: i8 = a + 10i8;
    return b as i64;
}""",
    },
    {
        "id": "quiz/f64-to-i32-range",
        "title": "浮点→整数：下界也饱和",
        "rule": "浮点 → 整数是饱和语义",
        "code": """fn f() -> i64 {
    let x: f64 = -3000000000.0;
    return (x as i32) as i64;
}""",
    },
    {
        "id": "quiz/f64-to-i32-nan",
        "title": "浮点→整数：NaN → 0",
        "rule": "浮点 → 整数：NaN → 0",
        "code": """fn f() -> i64 {
    let a: f64 = 0.0;
    let b: f64 = 0.0;
    let c: f64 = a / b;
    return (c as i32) as i64;
}""",
    },
    {
        "id": "quiz/f32-to-i32",
        "title": "f32 → i32",
        "rule": "浮点 → 整数",
        "code": """fn f() -> i64 {
    let x: f32 = 2.5f32;
    return (x as i32) as i64;
}""",
    },
    {
        "id": "quiz/const-array-index",
        "title": "顶层 `const` 数组（**只有数组行**）",
        "rule": "顶层 const 数组是允许的",
        "code": """fn f() -> i64 {
    return DIGITS[2] as i64;
}""",
        "extra": """const DIGITS: [i32; 3] = [7, 8, 9];
""",
    },
    {
        "id": "quiz/global-var-read",
        "title": "顶层变量的值",
        "rule": "顶层变量的初始化器必须是整数常量表达式",
        "code": """fn f() -> i64 {
    return G as i64;
}""",
        "extra": """let G: i64 = 9;
""",
    },
    {
        "id": "quiz/struct-field-u64",
        "title": "struct 字段是 u64",
        "rule": "字段类型要显式带类型",
        "code": """type W = struct {
    n: u64,
}

fn f() -> i64 {
    let w: W = W { n: 5u64 };
    return w.n as i64;
}""",
    },
    {
        "id": "quiz/enum-in-array",
        "title": "数组里放 enum",
        "rule": "聚合类型可以放数组里",
        "code": """type E = enum { A, B }

fn f() -> i64 {
    let arr: [E; 2] = [E::A, E::B];
    return len(arr) as i64;
}""",
    },
    {
        "id": "quiz/compound-assign",
        "title": "复合赋值",
        "rule": "复合赋值与 `=` 同级",
        "code": """fn f() -> i64 {
    let mut a: i32 = 5;
    a += 3;
    a *= 2;
    return a as i64;
}""",
    },
    {
        "id": "quiz/compound-assign-precedence",
        "title": "复合赋值的优先级",
        "rule": "复合赋值与 `=` 同级（比算术松）",
        "code": """fn f() -> i64 {
    let mut a: i32 = 1;
    let b: i32 = 2;
    a += b * 3;
    return a as i64;
}""",
    },
    {
        "id": "quiz/nested-array",
        "title": "数组里放数组",
        "rule": "聚合类型",
        "code": """fn f() -> i64 {
    let arr: [[i32; 2]; 2] = [[1 as i32, 2 as i32], [3 as i32, 4 as i32]];
    return arr[1][0] as i64;
}""",
    },
    {
        "id": "quiz/index-of-index",
        "title": "二维下标",
        "rule": "下标",
        "code": """fn f() -> i64 {
    let arr: [[i32; 3]; 2] = [[1 as i32, 2 as i32, 3 as i32],
                              [4 as i32, 5 as i32, 6 as i32]];
    return arr[1][2] as i64;
}""",
    },
    {
        "id": "quiz/u32-cmp-u32",
        "title": "u32 比较",
        "rule": "无符号比较",
        "code": """fn f() -> i64 {
    let a: u32 = 4294967295u32;
    let b: u32 = 1u32;
    if a > b {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/i32-cmp-negative",
        "title": "i32 比较（负数）",
        "rule": "有符号比较",
        "code": """fn f() -> i64 {
    let a: i32 = -1;
    let b: i32 = 1;
    if a < b {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/array-eq",
        "title": "数组的 `==` 按值",
        "rule": "聚合类型的相等比较按值",
        "code": """fn f() -> i64 {
    let a: [i32; 2] = [1 as i32, 2 as i32];
    let b: [i32; 2] = [1 as i32, 2 as i32];
    if a == b {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/slice-of-slice-len",
        "title": "子切片的长度",
        "rule": "子切片是视图（半开）",
        "code": """fn f() -> i64 {
    let arr: [i32; 5] = [1 as i32, 2 as i32, 3 as i32, 4 as i32, 5 as i32];
    let base: [*]i32 = arr as [*]i32;
    let sub: [*]i32 = base[2..5];
    return len(sub) as i64;
}""",
    },
    {
        "id": "quiz/closure-call-direct",
        "title": "闭包值**可以直接调用**",
        "rule": "闭包值可直接调用",
        "code": """fn f() -> i64 {
    let g = |v: i32| { v * 2 };
    return g(21) as i64;
}""",
    },
    {
        "id": "quiz/enum-payload-eq",
        "title": "带 payload 的枚举比值",
        "rule": "聚合类型的相等比较按值",
        "code": """type E = enum { A(i32), B }

fn f() -> i64 {
    let a: E = E::A(1);
    let b: E = E::A(1);
    if a == b {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/i32-eq-i32",
        "title": "同类型比较",
        "rule": "比较",
        "code": """fn f() -> i64 {
    let a: i32 = 1;
    let b: i32 = 1;
    if a == b {
        return 1i64;
    }
    return 0i64;
}""",
    },
    {
        "id": "quiz/stdlib-string-len",
        "title": "string 模块要 arena",
        "rule": "`string` 的函数要一个 arena",
        "code": """fn f() -> i64 {
    let mut abuf: [i64; 5] = [0i64, 0i64, 0i64, 0i64, 0i64];
    let a: *u8 = abuf as *u8;
    arena_init(a, 4096 as i64);
    let s: *u8 = str_from_cstr(a, "hello" as *u8);
    return str_len(s) as i64;
}""",
        "imports": ["import arena;", "import string;"],
    },
    {
        "id": "quiz/stdlib-strlen-local",
        "title": "`strlen_local`",
        "rule": "string 模块的 API",
        "code": """fn f() -> i64 {
    let mut abuf: [i64; 5] = [0i64, 0i64, 0i64, 0i64, 0i64];
    let a: *u8 = abuf as *u8;
    arena_init(a, 4096 as i64);
    let s: *u8 = str_from_cstr(a, "hello" as *u8);
    return strlen_local(s) as i64;
}""",
        "imports": ["import arena;", "import string;"],
    },
    {
        "id": "quiz/stdlib-mem-copy",
        "title": "`mem_copy`",
        "rule": "mem 模块的 API",
        "code": """fn f() -> i64 {
    let mut a: [u8; 4] = [1u8, 2u8, 3u8, 4u8];
    let mut b: [u8; 4] = [0u8, 0u8, 0u8, 0u8];
    mem_copy(b as *u8, a as *u8, 4 as i64);
    return b[3] as i64;
}""",
        "imports": ["import mem;"],
    },
    {
        "id": "quiz/stdlib-mem-compare",
        "title": "`mem_compare`",
        "rule": "mem 模块的 API",
        "code": """fn f() -> i64 {
    let mut a: [u8; 4] = [1u8, 2u8, 3u8, 4u8];
    let mut b: [u8; 4] = [1u8, 2u8, 3u8, 4u8];
    if mem_compare(a as *u8, b as *u8, 4 as i64) == 0 {
        return 1i64;
    }
    return 0i64;
}""",
        "imports": ["import mem;"],
    },
    {
        "id": "quiz/stdlib-math-sqrt",
        "title": "`std_math_sqrt`",
        "rule": "math 模块的 API（**仅 f64**）",
        "code": """fn f() -> i64 {
    return (std_math_sqrt(16.0) as i32) as i64;
}""",
        "imports": ["import math;"],
    },
    {
        "id": "quiz/stdlib-math-pow",
        "title": "`std_math_pow`",
        "rule": "math 模块的 API（**仅 f64**）",
        "code": """fn f() -> i64 {
    return (std_math_pow(2.0, 10.0) as i32) as i64;
}""",
        "imports": ["import math;"],
    },
    {
        "id": "quiz/stdlib-fmt-i32",
        "title": "`fmt_i32`",
        "rule": "fmt 模块的 API",
        "code": """fn f() -> i64 {
    let mut buf: [u8; 32] = [0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                              0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                              0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                              0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8];
    let p: *u8 = &buf[0];
    let n: i64 = fmt_i32(p, 1234);
    buf[n] = 10u8;
    buf[n + 1i64] = 0u8;
    std_io_print(p);
    return 0i64;
}""",
    },
    {
        "id": "quiz/stdlib-fmt-hex-u32",
        "title": "`fmt_hex_u32`",
        "rule": "fmt 模块的 API",
        "code": """fn f() -> i64 {
    let mut buf: [u8; 32] = [0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                              0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                              0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                              0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8];
    let p: *u8 = &buf[0];
    let n: i64 = fmt_hex_u32(p, 255u32);
    buf[n] = 10u8;
    buf[n + 1i64] = 0u8;
    std_io_print(p);
    return 0i64;
}""",
    },
    {
        "id": "quiz/stdlib-extern-printf",
        "title": "自己声明 `extern fn printf`",
        "rule": "没有内建 print ⇒ 要自己声明",
        "code": """extern fn printf(fmt: *u8, val: i64) -> i32;

fn f() -> i64 {
    printf("%lld\\n" as *u8, 42 as i64);
    return 0i64;
}""",
    },
    {
        "id": "quiz/alignof-enum-4",
        "title": "`alignof(enum)` 恒为 4",
        "rule": "`alignof(enum)` 恒为 4",
        "code": """type E = enum { A, B }

fn f() -> i64 {
    return alignof(E) as i64;
}""",
    },
    {
        # ⚠️ **这道题测的是一个「已知缺陷」**（台账 W-233）——
        #   字符串字面量 `as [*]u8` 出来的切片，**len 是 0** ⇒
        #   `len(s)` 得 0、`s[0]` 直接**访问违例**（0xC0000005）。
        # ⇒ 「按 C 的直觉答 5」就是错 ⇒ ⇒ 它正好是**反直觉点**。
        "id": "quiz/string-literal-slice-len",
        "title": "字符串字面量转成切片后的长度",
        "rule": "字符串字面量是 `*u8`（NUL 结尾），**不是切片** ⇒ 转出来的切片 len 是 0（W-233）",
        "code": """fn f() -> i64 {
    let s: [*]u8 = "hello" as [*]u8;
    return len(s) as i64;
}""",
    },
    {
        # ⚠️ **这道题测的是一个「已知缺陷」**（台账 W-234）——
        #   顶层 const 数组的元素写成 `1 as i32` ⇒ **静默读出 0**（不报错）
        "id": "quiz/const-array",
        "title": "顶层 `const` 数组（元素带 `as`）",
        "rule": "顶层 const 数组的元素**只认裸字面量**（带 `as` ⇒ 静默读出 0，W-234）",
        "code": """fn f() -> i64 {
    return EARR[1] as i64;
}""",
        "extra": """const EARR: [i32; 3] = [1 as i32, 2 as i32, 3 as i32];
""",
    },
    {
        "id": "quiz/const-array-plain",
        "title": "顶层 `const` 数组（元素是**裸字面量**）",
        "rule": "顶层 const 数组是允许的（**只有数组行**；标量 const 不行）",
        "code": """fn f() -> i64 {
    return EARR[1] as i64;
}""",
        "extra": """const EARR: [i32; 3] = [1, 2, 3];
""",
    },
]
