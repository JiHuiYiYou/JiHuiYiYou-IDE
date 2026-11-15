/* 手写翻译题 —— 区间端点：闭区间 vs 半开区间 */
#include <stdio.h>

/* 闭区间：[0,10] 与 [11,20] —— 两端都含 */
static int classify(int x) {
    if (x >= 0 && x <= 10) return 1;
    if (x >= 11 && x <= 20) return 2;
    return 3;
}

int main(void) {
    printf("%d:%d\n", 0, classify(0));
    printf("%d:%d\n", 9, classify(9));
    printf("%d:%d\n", 10, classify(10));
    printf("%d:%d\n", 11, classify(11));
    printf("%d:%d\n", 20, classify(20));
    printf("%d:%d\n", 21, classify(21));
    /* 半开区间：[0,10) —— 不含 10 */
    int s = 0;
    for (int i = 0; i < 10; i++) s += i;
    printf("%d:%d\n", s, 0);
    return 0;
}
