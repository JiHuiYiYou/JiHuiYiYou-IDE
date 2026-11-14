/* difftest 生成 —— C 侧 */
#include <stdio.h>
#include <stdint.h>

static uint32_t f0(uint32_t p0_0) {
    uint32_t a0 = 3588440356u;
    uint32_t i1 = 2156362607u;
    while (i1 < 5u) {
        uint32_t i2 = 1910634194u;
        while (i2 < 1u) {
            printf("%lld\n", (long long)((uint32_t)((4077622522u << (1597986795u & 31u)))));
            i2 = i2 + 1u;
        }
        i1 = i1 + 1u;
    }
    return 154293798u;
}

static uint32_t f1(uint32_t p1_0) {
    uint32_t a1 = p1_0;
    if ((990430947u == 1396478261u)) {
        a1 = (4289313265u & 2206485312u);
    } else {
        a1 = (4274255539u * 3837860530u);
    }
    if (((3391940284u & 2549001060u) != a1)) {
        a1 = (3571370479u << (3419722722u & 31u));
    } else {
        uint32_t i3 = 3972123491u;
        while (i3 < 8u) {
            i3 = i3 + 1u;
        }
        a1 = a1;
    }
    return f0(a1);
}

int main(void) {
    uint32_t r = f1((4039831280u / (1394435168u | 1u)));
    printf("%lld\n", (long long)((uint32_t)r & 0x7FFFFFFFu));
    return 0;
}
