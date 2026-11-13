/* difftest 生成 —— C 侧 */
#include <stdio.h>
#include <stdint.h>

static uint32_t f0(uint32_t p0_0, uint32_t p0_1, uint32_t p0_2) {
    uint32_t a0 = p0_0;
    printf("%lld\n", (long long)((uint32_t)((2380573511u >> (((uint32_t)(754393686946194550ULL)) & 31u))) & 0xFFFFFFFFu));
    return ((4085678676u ^ 3114132053u) * p0_1);
}

static uint32_t f1(uint32_t p1_0) {
    uint32_t a1 = 568763503u;
    printf("%lld\n", (long long)((uint32_t)(2956830465u)));
    a1 = f0((3820700083u | 376721805u), f0(1703138836u, 1207677876u, 1467417502u), f0(3044275909u, 3807057864u, 22641345u));
    printf("%lld\n", (long long)((uint32_t)(a1) & 0xFFFFFFFFu));
    return 1016761845u;
}

static uint32_t f2(uint32_t p2_0, uint32_t p2_1) {
    uint32_t a2 = (((uint32_t)(2236343751116975461ULL)) - f0(3845299022u, 3660155614u, 872106831u));
    uint32_t v1 = 2318292094u;
    f0((3955348434u << (851157092u & 31u)), v1, 3285210637u);
    return 2490222688u;
}

int main(void) {
    uint32_t r = f2(4036047192u, (232672148u + 1159617587u));
    printf("%lld\n", (long long)((uint32_t)r & 0xFFFFFFFFu));
    return 0;
}
