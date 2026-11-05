/**
 * 程序输出的**分行**。
 *
 * ⚠️ 为什么需要自己攒 ——
 *
 * 程序的 stdout 现在是**无缓冲**的（编译器仓库的 `compiler/runtime/runtime.c`
 * 里有 `setvbuf(stdout, NULL, _IONBF, 0)`）⇒ 一次 `printf` 可能被拆成
 * 好几个片段送过来。实测一句提示
 * 「请输入一个数字: 」= 「请输入一」/「个数」/「字: 」**三截**。
 *
 * ⇒ 直接把每段当一行 ⇒ 输出面板会被拆得七零八落 ⇒ 得自己攒：
 * **攒到换行符才当一行**；还没换行的那段（提示语就是这种）单独留着。
 */

/** 输出一行（现在只给 Claude 的上下文用 —— 输出面板已经删了） */
export interface OutputLine {
  kind: 'stdout' | 'stderr' | 'compiler' | 'error'
  text: string
}

/** 一段输出攒完之后的结果。 */
export interface OutputChunk {
  /** 攒到的完整行（空行丢掉 —— 终端里空行没有信息量） */
  lines: string[]
  /** 还没换行的那一段（下一段接在它**后面**） */
  tail: string
}

/**
 * 把新的一段输出接到上一次的尾巴后面。
 *
 * @param prevTail 上一次留下的「还没换行的那段」
 * @param text    新收到的一段
 */
export function accumulateOutput(prevTail: string, text: string): OutputChunk {
  const combined = prevTail + text
  const parts = combined.split('\n')
  const tail = parts.pop() ?? ''
  const lines: string[] = []
  for (const part of parts) {
    // Windows 的程序可能发 \r\n ⇒ 去掉行尾那个 \r
    const clean = part.replace(/\r$/, '')
    if (clean.length > 0) lines.push(clean)
  }
  return { lines, tail }
}
