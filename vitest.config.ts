import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@lang': resolve(root, 'src/lang'),
      '@shared': resolve(root, 'src/shared'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // 一致性测试要跑真实编译器 + 编译 284 个例子，很慢
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
