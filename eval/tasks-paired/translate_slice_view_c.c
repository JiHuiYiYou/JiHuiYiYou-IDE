/* 手写翻译题 —— 切片：区间半开 + 写穿透到原数组 */
#include <stdio.h>

static int sum3(const int *a) {
    return a[0] + a[1] + a[2];
}

int main(void) {
    int arr[4] = {10, 20, 30, 40};
    printf("%d\n", sum3(arr));        /* 60 */
    int *mid = arr + 1;
    printf("%d\n", sum3(mid));        /* 20 + 30 + 40 = 90 */
    *mid = 99;
    printf("%d\n", arr[1]);           /* 99 */
    printf("%d\n", sum3(arr));        /* 10 + 99 + 30 = 139 */
    return 0;
}
