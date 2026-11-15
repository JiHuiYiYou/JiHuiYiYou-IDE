/* 手写翻译题 —— 回调：JHYY 没有函数指针类型 ⇒ 只能重构 */
#include <stdio.h>

static int apply_twice(int (*f)(int, int), int base, int k) {
    int v = base;
    for (int i = 0; i < 2; i++) v = f(v, k);
    return v;
}

static int add(int x, int k) { return x + k; }
static int times(int x, int k) { return x * k; }

int main(void) {
    printf("%d\n", apply_twice(add, 3, 5));    /* 3 → 8 → 13 */
    printf("%d\n", apply_twice(times, 3, 5));  /* 3 → 15 → 75 */
    return 0;
}
