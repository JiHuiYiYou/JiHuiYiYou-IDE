/* 手写翻译题 —— 枚举 + match（穷尽性检查 / arm 是独立作用域） */
#include <stdio.h>

enum Shape { CIRCLE, SQUARE, TRIANGLE };

static int sides(enum Shape s) {
    switch (s) {
    case CIRCLE: return 0;
    case SQUARE: return 4;
    case TRIANGLE: return 3;
    }
    return -1;
}

int main(void) {
    printf("%d\n", sides(CIRCLE));
    printf("%d\n", sides(SQUARE));
    printf("%d\n", sides(TRIANGLE));
    return 0;
}
