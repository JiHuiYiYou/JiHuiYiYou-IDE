/* difftest 生成 —— C 侧 */
#include <stdio.h>
#include <stdint.h>

static uint32_t f0(uint32_t p0_0) {
    uint32_t a0 = (4236295699u + 236000768u);
    uint32_t v1 = (1452032918u & a0);
    v1 = p0_0;
    printf("%d\n", (long long)((uint32_t)(3972150168u)));
    return (1956515703u | ((uint32_t)(1456541858784596882ULL)));
}

static uint32_t f1(uint32_t p1_0, uint32_t p1_1) {
    uint32_t a1 = (p1_1 & f0(1739893064u));
    if ((739569764u > (1231011249u + 2276271103u))) {
        uint32_t v2 = f0(p1_0);
        a1 = p1_0;
    } else {
        uint32_t i3 = 2147789736u;
        while (i3 < 5u) {
            f0(4072200062u);
            i3 = i3 + 1u;
        }
        a1 = p1_0;
    }
    return f0(p1_1);
}

int main(void) {
    uint32_t r = f1(1896436369u, f1(2037733535u, 610528164u));
    printf("%d\n", (long long)((uint32_t)r & 0x7FFFFFFFu));
    return 0;
}
