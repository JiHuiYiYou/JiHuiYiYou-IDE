/* 手写翻译题 —— struct：按值传参 / 返回 + struct 字面量 */
#include <stdio.h>

struct Point {
    int x;
    int y;
};

static struct Point make(int x, int y) {
    struct Point p;
    p.x = x;
    p.y = y;
    return p;
}

static int dist2(struct Point a, struct Point b) {
    int dx = a.x - b.x;
    int dy = a.y - b.y;
    return dx * dx + dy * dy;
}

int main(void) {
    struct Point a = make(3, 4);
    struct Point b = make(1, 1);
    printf("%d\n", a.x + a.y);
    printf("%d\n", dist2(a, b));
    struct Point c = { 10, 20 };
    printf("%d\n", c.x);
    printf("%d\n", c.y);
    return 0;
}
