/**
 * 剥掉 ANSI 转义序列。
 *
 * ## 为什么需要
 *
 * 走**真控制台**（ConPTY / node-pty）之后，程序的输出是**终端渲染后的流** ——
 * 里面有光标移动、清行、颜色、OSC 标题序列等等。
 *
 * - **终端面板**要的是**原样**（xterm.js 自己会解析这些序列 ⇒ 颜色/光标都对 ✓）
 * - **输出面板**要的是**纯文本**（一行一行给人看）⇒ 得剥一遍 ⇒
 *   否则日志里全是转义序列这种垃圾。
 *
 * ⚠️ 代价很低：**原始字节留着**（终端那份），**需要时再剥**（输出面板那份）✓。
 */

/** ESC（0x1B）。 */
const ESC = '\u001b'
/** CSI（0x9B）—— 8 位控制字符里的那个。 */
const CSI = '\u009b'
/** BEL（0x07）—— OSC 序列的结束符。 */
const BEL = '\u0007'

/**
 * 剥掉 ANSI 转义序列 ⇒ 得到纯文本。
 *
 * 覆盖这几类：
 * - **CSI**（`ESC [ … 末字母`）：颜色、光标移动、清屏
 * - **OSC**（`ESC ] … BEL` 或 `ESC ] … ST`）：窗口标题
 * - **单字符 ESC 序列**（`ESC 7`、`ESC M` …）
 * - **字符集选择**（`ESC ( B`）
 * - **8 位 CSI**（0x9B）
 */
const CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, 'g')
const ESC_SINGLE_RE = new RegExp(`${ESC}[@-Z\\\\-_]`, 'g')
const ESC_CHARSET_RE = new RegExp(`${ESC}[()*+][0-9A-Za-z]`, 'g')
const CSI8_RE = new RegExp(`${CSI}[0-?]*[ -/]*[@-~]`, 'g')

/**
 * 剥掉 ANSI 转义序列 ⇒ 得到纯文本。
 *
 * ⚠️ **不处理退格符**（`\b`）—— 那是「擦掉前一个字符」的终端语义，
 * 剥了它文本会错位；输出面板就当它不存在（反正那是控制字符）。
 */
export function stripAnsi(text: string): string {
  if (!text) return text
  let out = text
  out = out.replace(OSC_RE, '')
  out = out.replace(CSI_RE, '')
  out = out.replace(CSI8_RE, '')
  out = out.replace(ESC_CHARSET_RE, '')
  out = out.replace(ESC_SINGLE_RE, '')
  // 残留的裸 ESC
  out = out.replace(new RegExp(`${ESC}`, 'g'), '')
  return out
}
