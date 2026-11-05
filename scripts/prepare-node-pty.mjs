#!/usr/bin/env node
/**
 * 准备 node-pty —— 让它能**按 Electron 的 ABI** 编出来。
 *
 * ## 为什么需要这个脚本
 *
 * node-pty 是**原生模块**：npm 装下来的是给 **Node.js** ABI 预编译的 `.node`，
 * 而 Electron 用的是**另一套 ABI** ⇒ 必须重编（这要 **MSVC**）。
 *
 * ⚠️ **这里不用 `@electron/rebuild`** —— 它会先 `npm rebuild` 把包**恢复原样**
 * （从 tarball 里重新解出来），**我们的补丁会被冲掉** ⇒ 所以自己来：
 * **打补丁 → 直接调 node-gyp** ✓。
 *
 * ## 三个补丁（都是这台机器上「装 MSVC 之后仍然编不出来」的原因）
 *
 * 1. **`cd shared && X.bat` ⇒ 要带 `.\\`**
 *    —— Windows 默认**不把当前目录放进 exe 搜索路径**（注册表项
 *    `NoDefaultCurrentDirectoryInExePath`）⇒ cmd 报
 *    「'GetCommitHash.bat' 不是内部或外部命令」⇒ node-gyp 在 **configure 阶段**
 *    就挂 ⇒ **连 conpty 那个 target 都编不出来**（gyp 是整张图一起 configure 的）。
 *
 *    ⚠️ **gyp 文件是 Python 读的** ⇒ 反斜杠是 **Python 转义** ⇒ 文件里要写
 *    **两个**（`\\`）⇒ Python 还原成一个 ⇒ cmd 拿到 `.\X.bat` ✓。
 *    写一个的话，Python 会把 `\U` 当成 unicode 转义的开头 ⇒
 *    `SyntaxError: truncated \UXXXXXXXX escape` ✗。
 *
 * 2. **关掉 Spectre 缓解**
 *    —— node-pty 默认设了 `'SpectreMitigation': 'Spectre'` ⇒ MSBuild 要求
 *    「Spectre 缓解库」那个可选组件（好几 GB）⇒ 没装就报
 *    `MSB8040: 此项目需要缓解了 Spectre 漏洞的库` ⇒ 构建挂掉。
 *    缓解库只是**额外的**安全加固 ⇒ 去掉不影响功能 ✓。
 *    ⚠️ **两个 gyp 都有**：`binding.gyp`（node-pty 自己那份）+ `winpty.gyp` 两处
 *    ⇒ 只改一个的话 MSBuild 照样报 MSB8040。
 *
 * 3. **兜底：补上 winpty 的 `shared/GetCommitHash.bat`**
 *    —— 正常情况下 npm 的 tarball 里**是有**这个脚本的 ✓（实测有）⇒ 这条
 *    只是**兜底**（万一某个版本的 tarball 缺了它 ⇒ 脚本压根跑不起来）。
 *
 * ⚠️ **失败不能报错退出** —— 没有 MSVC 的机器（CI、别人的开发机）也得能
 *    `npm install` ⇒ 失败就**退回管道版终端**（功能少一点，但能用）✓。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const ptyDir = join(root, 'node_modules', 'node-pty')

/** 反斜杠（用 fromCharCode 写出来，免得源码里出现一堆转义）。 */
const BS = String.fromCharCode(92)

/** node-pty 没装（可选依赖没装上）⇒ 没什么好准备的。 */
if (!existsSync(ptyDir)) {
  console.log('[node-pty] 没装 —— 终端用管道版')
  process.exit(0)
}

/** ① 把 winpty.gyp 里的 `cd shared && X.bat` 改成带 `.\\` 的写法。 */
function patchWinptyGyp() {
  const gyp = join(ptyDir, 'deps', 'winpty', 'src', 'winpty.gyp')
  if (!existsSync(gyp)) return
  const src = readFileSync(gyp, 'utf8')
  // 前面可能带 `.` 或 `\`（各种版本不一样）⇒ 一律先剥掉，再统一补 `.\`
  const patched = src.replace(
    /(cd shared && )[\\.]*([A-Za-z0-9_]+\.bat)/g,
    (_m, head, bat) => head + '.' + BS + BS + bat,
  )
  if (patched === src) return
  writeFileSync(gyp, patched, 'utf8')
  console.log('[node-pty] 已修 winpty.gyp（.bat 要带当前目录才找得到）')
}

/**
 * ② 关掉 Spectre 缓解（那个可选组件没装 ⇒ MSB8040 ⇒ 构建挂）。
 *
 * ⚠️ **两个 gyp 都要改** —— `binding.gyp` 里是空的（node-pty 自己那份），
 * 但 `deps/winpty/src/winpty.gyp` 里**还有两处**（winpty-agent / winpty）⇒
 * 只改一处的话 MSBuild 照样报 MSB8040。
 */
function stripSpectre(file) {
  if (!existsSync(file)) return
  const src = readFileSync(file, 'utf8')
  const patched = src.replace(
    /'msvs_configuration_attributes'\s*:\s*\{\s*'SpectreMitigation'\s*:\s*'Spectre'\s*\}\s*,?/g,
    '',
  )
  if (patched === src) return
  writeFileSync(file, patched, 'utf8')
  console.log('[node-pty] 已关掉 Spectre 缓解：', file)
}

/** ③ 万一 winpty 的 shared/ 是空的 ⇒ 补一个占位的 hash 脚本。 */
function ensureCommitHashScript() {
  const shared = join(ptyDir, 'deps', 'winpty', 'src', 'shared')
  const bat = join(shared, 'GetCommitHash.bat')
  if (existsSync(bat)) return
  try {
    mkdirSync(shared, { recursive: true })
    writeFileSync(
      bat,
      [
        '@echo off',
        'rem 这个脚本只是给 winpty 的版本头一个 commit hash。',
        'rem npm 的 tarball 里没有 winpty 的 git 仓库 ⇒ 用一个固定的占位值。',
        'echo 0000000000000000000000000000000000000000',
        '',
      ].join('\r\n'),
      'ascii',
    )
    console.log('[node-pty] 补上了 deps/winpty/src/shared/GetCommitHash.bat')
  } catch (err) {
    console.log('[node-pty] 补 GetCommitHash.bat 失败：', err.message)
  }
}

/** 按 Electron 的 ABI 直接调 node-gyp（绕开 electron-rebuild 的重新解包）。 */
function rebuild() {
  let electronVersion = ''
  try {
    electronVersion = JSON.parse(
      readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
    ).version
  } catch {
    console.log('[node-pty] 读不到 electron 的版本 —— 跳过重编')
    return
  }
  const common = [
    `--target=${electronVersion}`,
    '--arch=x64',
    '--dist-url=https://electronjs.org/headers',
  ]
  /**
   * ⚠️ **直接用 node 跑 node-gyp 的 CLI**（别用 `npx`）——
   *    `npx` 是 .cmd ⇒ 非交互执行要么得开 shell（Node 会警告 DEP0190，
   *    而且参数不被转义），要么在 Node ≥ 18.20 上直接报 EINVAL。
   */
  const gypCli = join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
  const gyp = (args) =>
    execFileSync(process.execPath, [gypCli, ...args], { cwd: ptyDir, stdio: 'inherit' })

  try {
    gyp(['rebuild', ...common])
    console.log(`[node-pty] 已按 Electron ${electronVersion} 的 ABI 重编 ✓`)
    return
  } catch {
    /*
     * ⚠️ **`rebuild` = 先 clean 再 build** ⇒ clean 要**删掉**旧的 .node ——
     *    而**正在跑的 IDE 正加载着它**（Windows 上加载过的 DLL 删不掉）⇒
     *    `EPERM: unlink` ⇒ 整个重编挂掉（实测踩过）。
     *
     * ⇒ 退一步用 `configure` + `build`：**不 clean** ⇒ 只重链「缺了/过期」的
     *    目标 ⇒ 那个被锁住的文件原样跳过 ✓，其余的照常补上 ✓。
     */
    console.log('[node-pty] rebuild 失败（可能 IDE 正开着、.node 被锁）—— 试 configure+build')
    try {
      gyp(['configure', ...common])
      gyp(['build', ...common])
      console.log(`[node-pty] 已按 Electron ${electronVersion} 的 ABI 重编 ✓（configure+build）`)
      return
    } catch {
      /*
       * ⚠️ **「部分成功」也是成功** —— `configure + build` 会把**缺了的**目标
       *    全补上，只是**被锁住的那个**（`conpty.node` —— 正被 IDE 加载着）
       *    重链不了（`LNK1104`）。
       * ⇒ 那个文件本来就是对的（上次编出来的）⇒ 能用 ✓。
       */
      if (existsSync(join(ptyDir, 'build', 'Release', 'conpty.node'))) {
        console.log(
          '[node-pty] 有一个文件被占用（多半是 IDE 正开着、那个 .node 加载着）——',
          '没能重链它，但已有的二进制能用 ✓（关掉 IDE 再跑一次就能全量重编）。',
        )
        return
      }
      console.log(
        '[node-pty] 没按 Electron 的 ABI 重编（多半是没装 MSVC）——',
        '终端会退回管道版：程序仍是「假终端」，但提示语照样立刻可见',
        '（语言仓库的 runtime.c 里加了 setvbuf）。',
      )
    }
  }
}

patchWinptyGyp()
stripSpectre(join(ptyDir, 'binding.gyp'))
stripSpectre(join(ptyDir, 'deps', 'winpty', 'src', 'winpty.gyp'))
ensureCommitHashScript()
rebuild()
