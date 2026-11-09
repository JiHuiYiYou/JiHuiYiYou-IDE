import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalShell } from '@shared/terminal'

/**
 * **Shell 集成** —— 往 shell 里注入一段脚本，让它用 **OSC 633** 报状态。
 *
 * ## 为什么要有
 *
 * IDE 光看终端里滚过去的字节，**猜不出** shell 的状态 ⇒ 只能瞎猜：
 * - 「shell 现在在哪个目录？」⇒ 猜的办法是往 shell 里发一条 `cd`
 *   （**污染历史**、有延迟、路径格式对不上还会报错）
 * - 「shell 是不是空闲（停在提示符上）？」⇒ 猜的办法是记「用户这一行有没有输入」
 * - 「上一条命令的退出码？」⇒ 根本没有
 *
 * ⇒ 猜不准 ⇒ 终端里就出现「多一行空白」「提示符位置对不上」「一堆空提示符」
 *   这些怪现象（用户报过好几次）。
 *
 * ## 注入方式
 *
 * | shell | 怎么注入 |
 * |---|---|
 * | bash | `--init-file <脚本>` —— ⚠️ 它**取代**了 `~/.bashrc` ⇒ 脚本自己把 `~/.bashrc` source 回来 |
 * | powershell | `-Command "…; . '<脚本>'"` —— 用户的 profile 照常加载 |
 * | cmd | **不支持**（VS Code 也不支持） |
 *
 * ## 脚本为什么是「字符串」而不是仓库里的文件
 *
 * 因为打包后代码在 **asar** 里 —— **bash 读不了 asar 里的文件**（asar 是虚拟
 * 文件系统，只有 Electron 自己认）⇒ 脚本必须在运行时**写到真正的临时文件**里
 * ⇒ 所以它得先存在于 JS 里 ✓。
 */

/**
 * bash 的集成脚本。
 *
 * ⚠️ **不要用 `${…}`** —— 这段是 JS 模板字符串，`${` 会被当成插值 ⇒
 *    要写的话得转义成 `\${` ⇒ 干脆一个都不用，省得踩坑。
 */
export const BASH_INTEGRATION_SCRIPT = `# ── JHYY IDE 的 shell 集成（OSC 633）──────────────────────────────
#
# 这个脚本由 IDE 用 --init-file 注入 ⇒ 它**取代**了 ~/.bashrc
# ⇒ 第一件事：把用户的 ~/.bashrc source 回来 ✓
#
# 协议跟 VS Code 一样（OSC 633）：
#   A         提示符开始（shell 空闲了）
#   B         提示符结束
#   C         命令开始执行
#   D         命令执行完（**没有退出码** ⇒ 这一行敲的是空的）
#   D;<code>  命令执行完（退出码）
#   E;<cmd>   这条命令**是什么**（IDE 靠它认出「哪条命令跑完了」）
#   P;Cwd=<d> 当前目录

if [ -n "$JHY_IDE_SHELL_INTEGRATION" ]; then
	builtin return
fi
JHY_IDE_SHELL_INTEGRATION=1

# ── 用户的 rc（--init-file 把它顶掉了 ⇒ 自己 source 回来）────────
if [ -r ~/.bashrc ]; then
	. ~/.bashrc
fi

# ── 发一条 OSC 633 序列 ─────────────────────────────────────────
__jhyy_seq() {
	builtin printf '\\e]633;%s\\a' "$1"
}

# ── 当前目录 ────────────────────────────────────────────────────
#
# ⚠️ MSYS2 的 $PWD 是 /c/Users/… ⇒ IDE 那边认的是 Windows 路径
#    ⇒ 用 cygpath -m 换过来（Linux 上没有 cygpath ⇒ 原样返回）✓
__jhyy_cwd() {
	builtin local cwd="$PWD"
	if command -v cygpath >/dev/null 2>&1; then
		builtin local conv
		conv="$(cygpath -m "$PWD" 2>/dev/null)"
		if [ -n "$conv" ]; then cwd="$conv"; fi
	fi
	builtin printf '%s' "$cwd"
}

# ── 提示符（开始 / 结束）────────────────────────────────────────
__jhyy_prompt_start() {
	builtin printf '\\e]633;A\\a'
}

__jhyy_prompt_end() {
	builtin printf '\\e]633;B\\a'
}

# ── 状态 ───────────────────────────────────────────────────────
__jhyy_first_prompt=""
__jhyy_command_ran=""
__jhyy_status=0
__jhyy_in_command_execution="1"
__jhyy_original_PS1="$PS1"
__jhyy_custom_PS1=""

# 把 OSC 序列**包在提示符的两头**
#
# ⚠️ 用 \\[ \\] 包起来 —— bash 才不会把这些字符算进提示符的宽度
#    （不算的话提示符的列数会算错 ⇒ 换行位置就歪了）。
__jhyy_wrap_prompt() {
	if [ "$__jhyy_custom_PS1" != "$PS1" ]; then
		__jhyy_original_PS1="$PS1"
		__jhyy_custom_PS1="\\[$(__jhyy_prompt_start)\\]$__jhyy_original_PS1\\[$(__jhyy_prompt_end)\\]"
		PS1="$__jhyy_custom_PS1"
	fi
}

# ── 命令跑完了 ⇒ 报退出码 + 当前目录 ───────────────────────────
__jhyy_precmd() {
	if [ -z "$__jhyy_first_prompt" ]; then
		# 第一次画提示符之前 ⇒ 还没有命令跑过
		__jhyy_first_prompt=1
	else
		if [ -n "$__jhyy_command_ran" ]; then
			__jhyy_seq "D;$__jhyy_status"
		else
			__jhyy_seq "D"
		fi
		__jhyy_command_ran=""
	fi
	__jhyy_seq "P;Cwd=$(__jhyy_cwd)"
	__jhyy_wrap_prompt
	__jhyy_in_command_execution="0"
}

# ── 命令开始执行了 ─────────────────────────────────────────────
__jhyy_preexec() {
	__jhyy_command_ran=1
	__jhyy_seq "C"
	# ⚠️ **报一下这条命令是什么** ——
	#    IDE 靠它认出「哪条命令跑完了」——
	#    不然用户自己敲的命令会被当成 IDE 跑的那条 ⇒ 退出码张冠李戴 ✗
	#
	#    ⚠️ **$BASH_COMMAND 只能在函数外取** —— 进了函数它就变成
	#    「函数自己」了 ⇒ 由调用方传进来 ✓
	if [ -n "$1" ]; then
		__jhyy_seq "E;$1"
	fi
}

# ── DEBUG trap：每条**顶层**命令执行前都会触发 ──────────────────
#
# ⚠️ bash 默认**不把 DEBUG trap 传进函数**（除非 set -T）⇒
#    只有用户真正敲的命令会触发 ⇒ 不会自激 ✓
#
# ⚠️ PROMPT_COMMAND 自己也是个顶层命令 ⇒ 也会触发 ⇒ 得靠 BASH_COMMAND 认出来
#    （BASH_COMMAND 在 trap 里就是「马上要执行的那条命令」）✓
__jhyy_preexec_only() {
	case "$BASH_COMMAND" in
		__jhyy_prompt*) builtin return ;;
	esac
	if [ "$__jhyy_in_command_execution" = "0" ]; then
		__jhyy_in_command_execution="1"
		__jhyy_preexec "$BASH_COMMAND"
	fi
}

# 用户自己可能已经有 DEBUG trap ⇒ 别覆盖人家的（要链上）
__jhyy_original_debug_trap="$(trap -p DEBUG | sed -e "s/^trap -- '//" -e "s/' DEBUG.*//")"

# ── PROMPT_COMMAND ────────────────────────────────────────────
__jhyy_original_prompt_command="$PROMPT_COMMAND"

__jhyy_prompt_cmd_original() {
	__jhyy_status=$?
	# 用户自己的 PROMPT_COMMAND 也要跑
	if [ -n "$__jhyy_original_prompt_command" ]; then
		builtin eval "$__jhyy_original_prompt_command"
	fi
	__jhyy_precmd
	builtin return $__jhyy_status
}

__jhyy_prompt_cmd() {
	__jhyy_status=$?
	__jhyy_precmd
	builtin return $__jhyy_status
}

if [ -n "$__jhyy_original_prompt_command" ]; then
	PROMPT_COMMAND=__jhyy_prompt_cmd_original
else
	PROMPT_COMMAND=__jhyy_prompt_cmd
fi

# 装 trap（放在最后 ⇒ 装它的那条命令自己不会触发）
if [ -n "$__jhyy_original_debug_trap" ]; then
	trap "__jhyy_preexec_only; builtin eval \\"$__jhyy_original_debug_trap\\"" DEBUG
else
	trap '__jhyy_preexec_only' DEBUG
fi

# 提示符先包好（第一次画之前就得包好）
__jhyy_wrap_prompt
`

/**
 * PowerShell 的集成脚本。
 *
 * ⚠️ **只能报「提示符开始/结束」「退出码」「当前目录」** ——
 *    PowerShell 没有 bash 那种「命令执行前」的钩子（VS Code 靠劫持
 *    `PSConsoleHostReadLine` 才行，那要 PSReadLine）⇒ 我们就不报
 *    `C`（命令开始执行）了 ⇒ IDE 那边「命令在跑」这个状态就靠
 *    「提示符开始」和「命令执行完」夹出来 ✓。
 */
export const POWERSHELL_INTEGRATION_SCRIPT = `# ── JHYY IDE 的 shell 集成（OSC 633）──────────────────────────
#
# 由 IDE 用 -Command ". '<脚本>'" 注入（跟 VS Code 一个路子）。
#
# 协议：
#   A         提示符开始（shell 空闲了）
#   B         提示符结束
#   E;<cmd>   这条命令**是什么**（IDE 靠它认出「哪条命令跑完了」）
#   D;<code>  命令执行完（退出码）
#   P;Cwd=<d> 当前目录
#
# ⚠️ **退出码取 $LASTEXITCODE**（原生程序的真实退出码）——
#    不用 VS Code 那套「$? 的反面」（只有 0/1）⇒ 我们分得出
#    「Ctrl+C 中断（0xC000013A）」和「真崩了」✓

$Global:__JhyyOriginalPrompt = $function:Prompt
$Global:__JhyyLastHistoryId = -1

# ⚠️ **记下「装脚本的时候」最后一条历史** ——
#    不然第一次画提示符就会报一次「命令执行完，退出码 0」
#    （那一条命令其实是 IDE 自己起的，不是用户敲的）✓
$__jhyyInitial = Get-History -Count 1
if ($null -ne $__jhyyInitial) {
	$Global:__JhyyLastHistoryId = $__jhyyInitial.Id
}

function Global:Prompt() {
	# ⚠️⚠️ **$? 必须第一个读** ——
	#    $? 反映的是**上一条命令**的结果，而函数里随便执行一条命令
	#    就会把它覆盖掉 ⇒ 以前这里先做了 Set-StrictMode + 两句赋值
	#    ⇒ 读到的时候 $? 已经是 True ⇒ **失败也报 0** ✗✗
	#
	#    ⇒ 后果：Set-Location（cd）失败也报成功 ⇒ IDE 的
	#    「cd 失败 ⇒ 停下整条序列」那道护栏**永远不触发** ⇒
	#    编译会在**用户的项目目录**里跑 ⇒ 凭空造出 compiler/build/obj/ 垃圾 ✗
	#
	#    实测（这台机器，PowerShell 5.1）：
	#    - 把 $? 放在函数**第一条** ⇒ 拿到的就是调用者的值 ✓
	#      （cd 失败 ⇒ False ⇒ fakeCode = 1 ✓）
	$ok = $?
	# $LastHistoryEntry 为 null 时，严格模式会直接抛 —— 关掉
	Set-StrictMode -Off
	$esc = [char]0x1b
	$bel = [char]0x07
	# ⚠️ **退出码要准** —— 原生程序（.exe）的**真实**退出码在 $LASTEXITCODE 里，
	#    而 $? 只能给出 0/1（VS Code 的脚本就是这样的 ⇒ 它分不出
	#    「Ctrl+C 中断」和「真崩了」⇒ 用户报过「程序崩溃：NTSTATUS0xC000013A 是什么鬼」）。
	#    ⇒ 优先用 $LASTEXITCODE；读完**立刻清掉**（免得下一条 cmdlet
	#      读到过期的值）✓
	#    实测（这台机器，PowerShell 5.1）：
	#    - 用调用运算符跑 exe（& 'C:\path\prog.exe'）⇒ $LASTEXITCODE = 42 ✓
	#    - Ctrl+C 打断 ⇒ $LASTEXITCODE = -1073741510（= 0xC000013A）✓
	$realCode = $global:LASTEXITCODE
	$global:LASTEXITCODE = $null
	# 上一条命令的退出码（VS Code 那一套：用 $? 的反面）
	$fakeCode = [int]!$ok
	$exitCode = if ($null -ne $realCode) { $realCode } else { $fakeCode }
	$result = ""

	# 只有**真的跑过一条命令**才报退出码（空回车 ⇒ 不报）
	$last = Get-History -Count 1
	if ($null -ne $last -and $last.Id -ne $Global:__JhyyLastHistoryId) {
		$Global:__JhyyLastHistoryId = $last.Id
		# ⚠️ **报一下这条命令是什么** ——
		#    IDE 靠它认出「哪条命令跑完了」——
		#    不然用户自己敲的命令会被当成 IDE 跑的那条 ⇒ 退出码张冠李戴 ✗
		$result += "$esc]633;E;$($last.CommandLine)$bel"
		$result += "$esc]633;D;$exitCode$bel"
	}

	# 提示符开始
	$result += "$esc]633;A$bel"

	# 当前目录
	if ($pwd.Provider.Name -eq 'FileSystem') {
		$result += "$esc]633;P;Cwd=$($pwd.ProviderPath)$bel"
	}

	# 原来的提示符
	$result += & $Global:__JhyyOriginalPrompt

	# 提示符结束
	$result += "$esc]633;B$bel"
	$result
}
`

/** 这个 shell 支持 shell 集成吗？ */
export function supportsShellIntegration(shell: TerminalShell): boolean {
  // ⚠️ **用户可以手动关掉集成**（`JHY_IDE_NO_SHELL_INTEGRATION=1`，
  //    万一注入把 shell 搞坏了）⇒ 那就没有 OSC ⇒
  //    「让 shell 跑命令」等不到结果 ⇒ **整个「运行」会挂住** ✗
  //    ⇒ 得当成「不支持」⇒ 退回老路 ✓
  if (process.env.JHY_IDE_NO_SHELL_INTEGRATION === '1') return false
  return shell === 'bash' || shell === 'powershell'
}

/** 脚本写到哪里了（按 shell 缓存 —— 同一个进程只写一次）。 */
const scriptPaths = new Map<TerminalShell, string | null>()

/**
 * 把集成脚本写到临时文件，返回路径。
 *
 * ⚠️ **必须是真正的文件** —— bash 的 `--init-file` 和 PowerShell 的
 *    `. "<路径>"` 都要一个磁盘上的路径（asar 里的读不了）✓。
 */
export function integrationScriptPath(shell: TerminalShell): string | null {
  if (scriptPaths.has(shell)) return scriptPaths.get(shell) ?? null
  const script = shell === 'bash' ? BASH_INTEGRATION_SCRIPT : POWERSHELL_INTEGRATION_SCRIPT
  const ext = shell === 'bash' ? '.sh' : '.ps1'
  let path: string | null = null
  try {
    const dir = join(tmpdir(), 'jhyy-ide')
    mkdirSync(dir, { recursive: true })
    path = join(dir, `shell-integration${ext}`)
    /*
      ⚠️⚠️ **PowerShell 的脚本必须带 UTF-8 BOM** ——

      Windows PowerShell 5.1 读 .ps1 时，**没有 BOM 就按系统 ANSI 代码页解码**
      （中文机器 = GBK）⇒ 脚本里的中文注释变成乱码 ⇒ **整个脚本被解析坏**
      （实测：提示符的 OSC 序列只剩一半，`A` / `B` 全丢了）⇒
      ⇒ 带 BOM ⇒ 它就知道这是 UTF-8 ✓

      bash 没有这个问题（它本来就是按字节读 UTF-8 的）⇒ 不加 BOM。
    */
    if (shell === 'powershell') {
      // U+FEFF = UTF-8 BOM（写成转义 ⇒ 源码里看不见那个字符，但文件里有）
      writeFileSync(path, `\uFEFF${script}`, 'utf8')
    } else {
      writeFileSync(path, script, 'utf8')
    }
  } catch {
    path = null
  }
  scriptPaths.set(shell, path)
  return path
}

/**
 * 给 shell 的启动参数**加上**集成脚本。
 *
 * @param shell 用哪个 shell
 * @param args  原来的启动参数
 * @returns 加好之后的参数
 */
export function withShellIntegration(shell: TerminalShell, args: string[]): string[] {
  // 用户可以手动关掉（万一注入把 shell 弄坏了）
  if (process.env.JHY_IDE_NO_SHELL_INTEGRATION === '1') return args
  if (!supportsShellIntegration(shell)) return args
  const path = integrationScriptPath(shell)
  if (!path) return args
  if (shell === 'bash') {
    // ⚠️ --init-file **取代** ~/.bashrc ⇒ 脚本自己会把 ~/.bashrc source 回来 ✓
    return ['--init-file', path, ...args]
  }
  // powershell：把 dot-source 拼到 -Command 的最后
  const idx = args.indexOf('-Command')
  if (idx < 0 || idx + 1 >= args.length) return args
  const cmd = args[idx + 1]
  // ⚠️ try/catch 包起来 —— 执行策略不让跑的时候别把整个 shell 弄挂
  args[idx + 1] = `${cmd}; try { . '${path}' } catch {}`
  return args
}

/**
 * 各 shell 的「**跑这一条命令然后退出**」的启动参数。
 *
 * ⚠️⚠️ **这是「运行」按钮走的路**（VS Code 的任务终端模型）——
 *   命令**不是敲进终端的 stdin**，而是 **shell 的启动参数**
 *   ⇒ shell 跑完就退出 ⇒
 *   ⇒ **判完成靠「终端进程退出」**、**退出码就是终端的退出码**
 *   ⇒ ⇒ **完全不需要 OSC 633** ⇒ 集成挂了也能跑 ✓
 *   ⇒ ⇒ 也**不用等 shell 集成起来** ⇒ 冷终端也是「shell 一起来就跑」✓
 *
 * @param shell   用哪个 shell
 * @param command 要跑的命令（已经拼好的那一行）
 * @param opts.noProfile **别加载 profile**（PowerShell 专用）
 *   ⇒ ⚠️ **用户的 profile 可能要 9～11 秒**（这台机器上是 `conda init`）
 *     ⇒ 「运行」/「检查」每次都等它 ⇒ **按钮点了半天才有反应** ✗
 *   ⇒ ⇒ profile 的**环境变量**由主进程**导一次、缓存住**（`shellEnv.ts`）
 *     ⇒ 已经**注入到 shell 的 env 里**了 ⇒ ⇒ 不需要再加载 profile ✓
 *   ⇒ ⚠️ **只有「导成功了」才能加这个标志** ⇒ 不然用户的 conda 就没了 ✗
 *     （调用方负责判断 ⇒ 见 `ptyFactory.ts`）
 */
export function shellCommandArgs(
  shell: TerminalShell,
  command: string,
  opts: { noProfile?: boolean } = {},
): string[] {
  switch (shell) {
    case 'powershell': {
      // ⚠️ **不要 `-NoExit`** —— 跑完命令就该退出（不然终端永远不结束）✓
      const setup =
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
        '[Console]::InputEncoding = [System.Text.Encoding]::UTF8'
      /*
        ⚠️⚠️ **退出码要显式带出去** ——
          `powershell -Command "…"` 的进程退出码**默认是 0**
          ⇒ 必须 `exit $LASTEXITCODE` 才拿得到真正的退出码 ✓
          ⇒ VS Code 的 PowerShell 任务也是这么做的 ✓

        ⚠️⚠️ **但 `$LASTEXITCODE` 可能是 `$null`** ——
          「命令压根没跑起来」（路径写错了、程序不存在 ⇒ `CommandNotFoundException`）
          ⇒ `$LASTEXITCODE` **从来没被赋过值** ⇒ 还是 `$null` ⇒
          ⇒ `exit $null` ⇒ **退出码 0** ⇒
          ⇒ IDE 以为「成功」⇒ 而屏幕上只有一条红色的报错 ⇒ **最坏的一种** ✗
          ⇒ 所以 **`$null` ⇒ 退出码 1** ✓
      */
      const script = integrationScriptPath('powershell')
      const dotSource = script ? `try { . '${script}' } catch {}; ` : ''
      const args = ['-NoLogo']
      // ⚠️⚠️ **`-NoProfile` ⇒ 用户的 profile 不加载** ——
      //   它的环境变量已经由主进程**导出来注入**了 ⇒ 不加载也能有 conda ✓
      //   ⇒ 启动从 ~10 秒变成 ~0.5 秒 ✓
      if (opts.noProfile) args.push('-NoProfile')
      args.push(
        '-Command',
        `${setup}; ${dotSource}${command}; exit $(if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE })`,
      )
      return args
    }
    case 'bash':
    default:
      // ⚠️ **不要 `-i`** —— `-c` 才是「跑完就退出」✓
      //    （`bash -i -c "…"` 会进交互模式 ⇒ 跑完不退出 ⇒ 终端永远不结束 ✗）
      //
      // ⚠️ **也不要 `--init-file`** —— bash **只在交互 shell** 里读 init-file
      //    ⇒ `-c` 模式下**根本不读** ⇒ 装了也没用 ⇒ 不如不装
      //    （顺带：不用 source ~/.bashrc ⇒ 不用跑 conda init ⇒ **启动快得多** ✓）
      //    ⇒ VS Code 的任务终端也是这个路子（它靠 `~/.bashrc` + 环境变量注入）✓
      return ['-c', command]
  }
}
