/* 手写翻译题 —— `as` 的优先级：跟 `*` 同级（左结合） */
#include <stdio.h>
#include <stdint.h>

int main(void) {
    uint32_t a = 3000000000u;
    uint32_t b = 2u;
    /* ① 两个操作数**各自**转成 u64 之后再乘 */
    uint64_t w = (uint64_t)a * (uint64_t)b;
    printf("%llu\n", (unsigned long long)w);
    /* ② 先在 u32 里乘（**回绕**）再转 u64 */
    uint64_t v = (uint64_t)(a * b);
    printf("%llu\n", (unsigned long long)v);
    return 0;
}
