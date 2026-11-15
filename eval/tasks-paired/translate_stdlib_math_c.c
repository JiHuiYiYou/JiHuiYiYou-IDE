/* 手写翻译题 —— 浮点：整数↔浮点不能隐式转 */
#include <stdio.h>
#include <math.h>

static double f(double x) {
    return x * x + 1.5;
}

int main(void) {
    double v = f(3);
    printf("%d\n", (int)(v * 2.0));
    printf("%d\n", (int)sqrt(16.0));
    printf("%d\n", (int)pow(2.0, 10.0));
    return 0;
}
