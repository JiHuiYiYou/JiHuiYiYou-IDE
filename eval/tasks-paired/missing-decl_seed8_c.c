/* difftest 生成 —— C 侧 */
#include <stdint.h>

static uint32_t f0(uint32_t p0_0, uint32_t p0_1) {
    uint32_t a0 = ((uint32_t)(807570059310326234ULL));
    uint32_t v1 = ((uint32_t)((558820675835493740ULL | 8990981361419012682ULL)));
    return v1;
}

static uint32_t f1(uint32_t p1_0, uint32_t p1_1, uint32_t p1_2) {
    uint32_t a1 = 3567061697u;
    uint32_t v2 = 85862000u;
    uint32_t i3 = 1620083717u;
    while (i3 < 7u) {
        f0((417330067u % (4258899853u | 1u)), f0(2663601089u, 3562813859u));
        i3 = i3 + 1u;
    }
    return 249341164u;
}

int main(void) {
    uint32_t r = f1(2969113350u, 3880038990u, (2497680444u / (3472020225u | 1u)));
    printf("%lld\n", (long long)((uint32_t)r & 0x7FFFFFFFu));
    return 0;
}
