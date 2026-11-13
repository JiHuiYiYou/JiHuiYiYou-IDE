/* difftest 生成 —— C 侧 */
#include <stdio.h>
#include <stdint.h>

static uint32_t f0(uint32_t p0_0, uint32_t p0_1) {
    uint32_t a0 = ((3733318544u * 967067425u) * (559260700u * 304199074u));
    printf("%lld\n", (long long)((uint32_t)(542440065u)));
    printf("%lld\n", (long long)((uint32_t)(1184710264u)));
    printf("%lld\n", (long long)((uint32_t)(((uint32_t)(((~(uint64_t)(15243749935849402904ULL)))))) & 0xFFFFFFFFu));
    return p0_1;
}

static uint32_t f1(uint32_t p1_0) {
    uint32_t a1 = f0(p1_0, (2422956812u << (4215173526u & 31u)));
    uint32_t i1 = 4239796143u;
    while (i1 < 7u) {
        a1 = i1;
        printf("%lld\n", (long long)((uint32_t)((2625036114u << (3214402848u & 31u)))));
        i1 = i1 + 1u;
    }
    uint32_t v2 = ((870274772u % (770568482u | 1u)) ^ (1593916546u % (1973361475u | 1u)));
    return 1203177851u;
}

static uint32_t f2(uint32_t p2_0, uint32_t p2_1) {
    uint32_t a2 = f1((1012230693u >> (3808009002u & 31u)));
    uint32_t i3 = 1848471621u;
    while (i3 < 3u) {
        i3 = i3 + 1u;
    }
    return (i3 ^ f0(965958745u, 608792547u));
}

int main(void) {
    uint32_t r = f2((2744722529u ^ 1089630213u), 1775929902u);
    printf("%lld\n", (long long)((uint32_t)r & 0xFFFFFFFFu));
    return 0;
}
