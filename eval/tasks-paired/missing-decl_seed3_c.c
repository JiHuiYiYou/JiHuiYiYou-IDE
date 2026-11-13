/* difftest 生成 —— C 侧 */
#include <stdint.h>

static uint32_t f0(uint32_t p0_0, uint32_t p0_1, uint32_t p0_2) {
    uint32_t a0 = (((uint32_t)(11542502259579130526ULL)) & (56556069u >> (3903345311u & 31u)));
    a0 = 3080127366u;
    if (((996097414u * 2726705791u) >= 3976433076u)) {
        a0 = (4112418594u - (3350403033u % (133194446u | 1u)));
        printf("%lld\n", (long long)((uint32_t)(((1696354899u | 3127277235u) | ((uint32_t)(17784390617415200626ULL)))) & 0x7FFFFFFFu));
        a0 = ((uint32_t)(661991620512760860ULL));
    } else {
        a0 = 931951836u;
    }
    return 2886395106u;
}

static uint32_t f1(uint32_t p1_0, uint32_t p1_1) {
    uint32_t a1 = f0(p1_1, (2512874164u << (1750525019u & 31u)), (2929090963u & 3933033799u));
    printf("%lld\n", (long long)((uint32_t)(((4143066945u & 2326866994u) * f0(3065820751u, 2815399127u, 906774905u)))));
    return (534443557u >> (3667655052u & 31u));
}

int main(void) {
    uint32_t r = f1((380182329u ^ 1477813205u), f1(3852998683u, 647532367u));
    printf("%lld\n", (long long)((uint32_t)r & 0x7FFFFFFFu));
    return 0;
}
