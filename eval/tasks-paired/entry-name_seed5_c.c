/* difftest 生成 —— C 侧 */
#include <stdio.h>
#include <stdint.h>

static uint32_t f0(uint32_t p0_0, uint32_t p0_1, uint32_t p0_2) {
    uint32_t a0 = p0_2;
    uint32_t i1 = 1635342798u;
    while (i1 < 1u) {
        uint32_t i2 = 1059022248u;
        while (i2 < 4u) {
            uint32_t v3 = 1596840319u;
            i2 = i2 + 1u;
        }
        i1 = i1 + 1u;
    }
    if (((1200367645u | 782009009u) < ((uint32_t)(7183850473961985349ULL)))) {
        a0 = 2651938379u;
    } else {
        a0 = p0_1;
    }
    uint32_t v4 = ((uint32_t)(17711218894991640089ULL));
    return ((uint32_t)(((~(uint64_t)(5785846489742829405ULL)))));
}

static uint32_t f1(uint32_t p1_0) {
    uint32_t a1 = (4159919668u / ((1283288560u | 92643356u) | 1u));
    a1 = 1425304169u;
    a1 = (1526222443u & f0(2991100305u, 1356321087u, 793595014u));
    return (4188020712u * f0(3628735802u, 1736429881u, 77599464u));
}

static uint32_t f2(uint32_t p2_0, uint32_t p2_1, uint32_t p2_2) {
    uint32_t a2 = f1(p2_0);
    uint32_t v5 = 4102466419u;
    f0((1479108632u ^ 2201153626u), v5, 1987924596u);
    return 3214345152u;
}

int not_main(void) {
    uint32_t r = f2(f1(3692358999u), 1859620701u, ((~(uint64_t)(3845839834649694302ULL))));
    printf("%lld\n", (long long)((uint32_t)r & 0x7FFFFFFFu));
    return 0;
}
