/* difftest 生成 —— C 侧 */
#include <stdint.h>

static uint32_t f0(uint32_t p0_0, uint32_t p0_1, uint32_t p0_2) {
    uint32_t a0 = ((uint32_t)(((~(uint64_t)(2175216119781798972ULL)))));
    uint32_t i1 = 1143881027u;
    while (i1 < 8u) {
        a0 = 121751464u;
        printf("%lld\n", (long long)((uint32_t)((2988579416u + 1912923437u)) & 0x7FFFFFFFu));
        i1 = i1 + 1u;
    }
    uint32_t i2 = 131383004u;
    while (i2 < 4u) {
        i2 = i2 + 1u;
    }
    return 2789779421u;
}

static uint32_t f1(uint32_t p1_0, uint32_t p1_1, uint32_t p1_2) {
    uint32_t a1 = 3784870617u;
    uint32_t i3 = 1787479226u;
    while (i3 < 7u) {
        uint32_t v4 = 1880712864u;
        f0(v4, 1973981844u, ((uint32_t)(396415130233965017ULL)));
        i3 = i3 + 1u;
    }
    printf("%lld\n", (long long)((uint32_t)(((519218416u % (3191790602u | 1u)) * i3))));
    return f0((1302957853u / (1220455187u | 1u)), (3634390239u ^ 4041192613u), (3664843848u >> (148287319u & 31u)));
}

int main(void) {
    uint32_t r = f1((1779465077u | 2855051695u), 2357072719u, f1(371375481u, 1885325846u, 2850818054u));
    printf("%lld\n", (long long)((uint32_t)r & 0x7FFFFFFFu));
    return 0;
}
