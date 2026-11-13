/* difftest 生成 —— C 侧 */
#include <stdio.h>
#include <stdint.h>

static uint32_t f0(uint32_t p0_0, uint32_t p0_1) {
    uint32_t a0 = 1701057193u;
    uint32_t v1 = 1724820278u;
    if ((2305023086u < p0_1)) {
        v1 = ((uint32_t)(3040360229582995239ULL));
    } else {
        uint32_t v2 = ((uint32_t)(((~(uint64_t)(4800841617172907184ULL)))));
        v1 = a0;
    }
    return 2602114036u;
}

static uint32_t f1(uint32_t p1_0, uint32_t p1_1) {
    uint32_t a1 = (1062240841u << (p1_0 & 31u));
    printf("%d\n", (long long)((uint32_t)(3027552232u) & 0x7FFFFFFFu));
    printf("%d\n", (long long)((uint32_t)((p1_1 | p1_0))));
    uint32_t v3 = 3424767624u;
    return 198951482u;
}

int main(void) {
    uint32_t r = f1(4284109553u, 2296183107u);
    printf("%d\n", (long long)((uint32_t)r & 0x7FFFFFFFu));
    return 0;
}
