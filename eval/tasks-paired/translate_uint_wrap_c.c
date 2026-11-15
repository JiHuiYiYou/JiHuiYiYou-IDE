/* 手写翻译题 —— 无符号整型：回绕 / 字面量后缀 / 零扩展 */
#include <stdio.h>
#include <stdint.h>

int main(void) {
    uint32_t max = 4294967295u;      /* u32 的上界 */
    uint32_t w = max + 1u;            /* 溢出 ⇒ 回绕到 0 */
    printf("%u\n", (unsigned)w);
    uint32_t big = 3000000000u;       /* 比 i32 上界还大 */
    printf("%u\n", (unsigned)big);
    printf("%lld\n", (long long)(int64_t)big);  /* u32 → i64 是零扩展 */
    int32_t neg = -1;
    printf("%lld\n", (long long)(int64_t)neg);  /* i32 → i64 是符号扩展 */
    uint32_t d = big / 3u;            /* 无符号除法 */
    printf("%u\n", (unsigned)d);
    int32_t n = -7;
    printf("%d\n", n / 2);             /* 有符号除法 ⇒ 向 0 截断 */
    printf("%d\n", n % 2);
    return 0;
}
