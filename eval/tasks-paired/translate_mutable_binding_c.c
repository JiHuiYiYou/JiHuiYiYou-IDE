/* 手写翻译题 —— 可变绑定：不可变绑定不能赋值；经指针写入**静默不生效** */
#include <stdio.h>

static int bump(int *p) {
    *p = *p + 1;
    return *p;
}

int main(void) {
    int x = 5;
    printf("%d\n", bump(&x));
    printf("%d\n", x);
    int y = 10;
    int *q = &y;
    *q = 20;
    printf("%d\n", y);
    return 0;
}
