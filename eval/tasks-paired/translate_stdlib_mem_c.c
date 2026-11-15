/* 手写翻译题 —— 字节块：memcpy / memcmp / memset */
#include <stdio.h>
#include <string.h>

int main(void) {
    char a[16];
    char b[16];
    for (int i = 0; i < 16; i++) a[i] = (char)(i + 1);
    memcpy(b, a, 16);
    memset(b, 0, 4);
    printf("%d\n", memcmp(a, b, 16) < 0 ? 1 : 0);
    int s = 0;
    for (int i = 0; i < 16; i++) s += (int)(unsigned char)b[i];
    printf("%d\n", s);
    printf("%d\n", (int)(unsigned char)b[4]);
    return 0;
}
