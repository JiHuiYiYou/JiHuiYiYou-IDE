/* difftest 生成 —— C 侧 */
#include <stdio.h>
#include <stdint.h>

static uint32_t f0(uint32_t p0_0) {
    uint32_t a0 = p0_0;
    printf("%lld\n", (long long)((uint32_t)((369140570u << (p0_0 & 31u))) & 0x7FFFFFFFu));
    return 2366729934u;
}

static uint32_t f1(uint32_t p1_0, uint32_t p1_1) {
    uint32_t a1 = 2428605135u;
    f0((212984476u | 4192983756u));
    return 2390857534u;
}

static uint32_t f2(uint32_t p2_0) {
    uint32_t a2 = 619570852u;
    uint32_t v1 = p2_0;
    uint32_t v2 = (v1 / ((255985076u >> (2658625969u & 31u)) | 1u));
    uint32_t v3 = (f1(2514969041u, 3966150535u) | v1);
    return 772092314u;
}

int not_main(void) {
    uint32_t r = f2((351564607u / (2467131055u | 1u)));
    printf("%lld\n", (long long)((uint32_t)r & 0x7FFFFFFFu));
    return 0;
}
