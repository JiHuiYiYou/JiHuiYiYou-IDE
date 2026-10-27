import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.cur': 'image/x-icon',
  '.mp3': 'audio/mpeg',
}

/**
 * Blockly 的图标 / 精灵图默认从 CDN（`static.blockly.com`）拉 ——
 * 桌面应用不能依赖网络。这里把 `node_modules/blockly/media` 里的 16 个小文件
 * （共 51 KB）在 dev 时用中间件提供、build 时打进产物。
 */
function blocklyMedia(): Plugin {
  const src = join(root, 'node_modules', 'blockly', 'media')
  const files = existsSync(src) ? readdirSync(src) : []

  return {
    name: 'blockly-media',
    configureServer(server) {
      server.middlewares.use('/blockly-media', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\//, '')
        const file = join(src, name)
        if (!file.startsWith(src) || !existsSync(file)) return next()
        const ext = name.slice(name.lastIndexOf('.'))
        res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream')
        res.end(readFileSync(file))
      })
    },
    generateBundle() {
      for (const name of files) {
        const full = join(src, name)
        if (!statSync(full).isFile()) continue
        this.emitFile({
          type: 'asset',
          fileName: `blockly-media/${name}`,
          source: readFileSync(full),
        })
      }
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@lang': resolve(root, 'src/lang'),
        '@shared': resolve(root, 'src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(root, 'src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: {
      alias: {
        '@lang': resolve(root, 'src/lang'),
        '@shared': resolve(root, 'src/shared'),
      },
    },
    plugins: [react(), blocklyMedia()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
      },
    },
  },
})
