/* difftest 生成 —— C 侧 */
#include <stdio.h>
#include <stdint.h>

static uint32_t f0(uint32_t p0_0, uint32_t p0_1, uint32_t p0_2) {
    uint32_t a0 = ((uint32_t)(((~(uint64_t)(9368018003224643702ULL)))));
    uint32_t v1 = ((uint32_t)(14627841482399967213ULL));
    uint32_t v2 = p0_1;
    uint32_t v3 = ((uint32_t)((18118270698365290187ULL + 17796639924064796018ULL)));
    return v2;
}

static uint32_t f1(uint32_t p1_0, uint32_t p1_1, uint32_t p1_2) {
    uint32_t a1 = (2269380278u >> (153127525u & 31u));
    printf("%lld\n", (long long)((uint32_t)(f0(p1_1, (2146509353u % (19730086u | 1u)), (2812351632u ^ 1194700572u)))));
    return p1_0;
}

static uint32_t f2(uint32_t p2_0, uint32_t p2_1, uint32_t p2_2) {
    uint32_t a2 = 3255542466u;
    if (((1719704081u - 463010788u) < f1(287017642u, 4114760733u, 72544005u))) {
        uint32_t v4 = 3909588191u;
        uint32_t v5 = a2;
        a2 = (578087448u - 1058228190u);
    } else {
        uint32_t v6 = (p2_2 % (a2 | 1u));
        a2 = (257240212u + 1996901420u);
    }
    return f0((1921675215u / (2185560420u | 1u)), 3143461704u, f1(2764735410u, 1648201399u, 500398015u));
}

int main(void) {
    uint32_t r = f2(4252242025u, 1158760585u, f2(1306293448u, 4285963831u, 3800466732u));
    printf("%lld\n", (long long)((uint32_t)r & 0xFFFFFFFFu));
    return 0;
}
