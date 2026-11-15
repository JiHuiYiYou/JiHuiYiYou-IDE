/* 手写翻译题 —— 字符串：strlen / strcmp / strstr */
#include <stdio.h>
#include <string.h>

int main(void) {
    const char *a = "hello";
    const char *b = "world";
    printf("%d\n", (int)strlen(a));
    printf("%d\n", (int)strlen(b));
    printf("%d\n", strcmp(a, b) < 0 ? 1 : 0);
    printf("%d\n", strcmp(b, a) < 0 ? 1 : 0);
    printf("%d\n", strcmp(a, a) == 0 ? 1 : 0);
    const char *hay = "the quick brown fox";
    printf("%d\n", (int)(strstr(hay, "brown") - hay));
    printf("%d\n", strstr(hay, "zzz") == NULL ? 0 : 1);
    return 0;
}
