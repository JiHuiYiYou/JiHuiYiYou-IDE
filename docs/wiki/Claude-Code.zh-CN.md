# Claude Code

IDE 右侧栏里的聊天在跟你机器上**已经装好的** `claude` CLI 说话。它不是另做的一套 API
集成 —— 就是你在终端里用的那个 Claude Code，同一个账号、同一批 MCP server、同一套
skills。

所以它能读写你的项目文件、能跑命令，而且 —— 因为 IDE 把 `jhyy` MCP server 挂上了 ——
**能拿真实编译器检查自己写的 JHYY 代码**，然后自己把错改掉。

## 会话是怎么跑的

IDE spawn 的是**原生** `claude.exe`（不是 npm 的 `.cmd` shim —— Windows 的 `.cmd`
shim 不带 shell 没法 spawn），然后用一条常驻的
`--input-format stream-json` / `--output-format stream-json` 管道跟它说话。

```
IDE ──stdin──▶  {"type":"user","message":{…}}          每轮一行
IDE ◀──stdout──  {"type":"stream_event",…}              增量文本
                 {"type":"assistant","message":{…}}     一整条消息
                 {"type":"user","message":{…}}          工具结果
                 {"type":"result",…}                    这一轮结束了
```

**同一个进程**服务整场对话：session id 不变，`result_index` 记轮次。
关掉 stdin（EOF）就优雅结束会话。

### IDE 用了哪些标志

| 标志 | 为什么 |
|---|---|
| `--input-format stream-json --output-format stream-json` | 一根管道多轮对话 |
| `--verbose` | `--output-format stream-json` **要求**它 |
| `--include-partial-messages` | 增量文本，而不是最后一次性给一大坨 |
| `--replay-user-messages` | 把你的消息回显回来，UI 好确认它收到了 |
| `--session-id <uuid>` | 进程还没起 IDE 就知道 session id |
| `--resume <id>` | 接着聊之前的会话 |
| `--permission-mode acceptEdits` | 文件编辑自动放行 |
| `--permission-prompts none` | **绝不**卡在一个 IDE 画不出来的提问上 |
| `--allowedTools Read,Edit,Write,MultiEdit,Glob,Grep,Bash,mcp__jhyy` | 工具面 |
| `--add-dir <dir>` | 项目目录 |
| `--mcp-config <json> --strict-mcp-config` | 只留 `jhyy` 这一个 MCP server |
| `--append-system-prompt "<JHYY 速查>"` | 教模型这门语言 |

关于 Claude Code **2.1.302**，三件必须知道的事：

- **没有 `--max-turns`。** 要上限就用 `--max-budget-usd`。
- **没有 `--permission-prompt-tool`。** 做不了 IDE 内审批 UI。
  办法是 `--allowedTools` 预先放行，剩下的交给 `--permission-prompts none` 拒掉。
- `--system-prompt` 会**替换**内置 prompt（连工具用法说明一起没）。
  IDE 用的是 `--append-system-prompt`，内置行为保留。

## jhyy MCP server

这是内嵌 Claude 对 JHYY 真正有用的地方：它能拿真实编译器问一句「我刚写的代码对不对」。

IDE **复用你 `~/.claude.json` 里已经配好的 `jhyy` 条目**（`mcpServers.jhyy`）——
不在 IDE 里硬编码一份，所以你改了配置 IDE 自动跟随。没有这个条目时，IDE 会去找语言
仓库里的 `mcp-jhyy/server.py` 和一个装了 `fastmcp` 的 Python。

挂上之后 Claude 能调：

| 工具 | 干什么 |
|---|---|
| `jhyy_check` | 解析 + 语义检查，返回编译器的诊断 |
| `jhyy_run` | 编译并运行 |
| `jhyy_compile` | 只编译 |
| `jhyy_lang_ref` | 搜语言规范 |
| `jhyy_workarounds` | 搜已知限制台账 |

问它「写个斐波那契并跑一下」，它会写文件、用 `jhyy_check` 检查、把编译器抱怨的地方
改掉。

> **MCP 工具必须显式放行。** `--permission-prompts none` 会拒掉一切需要询问的调用
> —— 包括 MCP 工具调用 —— 除非它在 `--allowedTools` 里。这就是 `mcp__jhyy` 在名单里
> 的原因。

## 文件归谁

Claude 能改你项目里的文件。IDE 在监听这些文件，磁盘上一变就重新加载编辑器。

- 你**没有**未保存的改动 —— 静默重新加载。
- 你**有**未保存的改动 —— IDE 先问，再动。

你的缓冲区绝不会被悄悄覆盖。

## 疑难

| 现象 | 原因和办法 |
|---|---|
| Claude 能答，但调不了 `jhyy_check` | `mcp__jhyy` 不在 `--allowedTools` 里 —— 默认是在的；检查 MCP server 找到没有 |
| MCP server 起不来 | `~/.claude.json` 里那个 Python 必须装了 `fastmcp` —— PATH 上的 `python` 通常**没有** |
| Claude 答得慢 | MCP server 每个会话启动一次，第一轮多等一会儿 |
| 各种「被拒绝」 | `--permission-prompts none` 拒掉一切没预先放行的 —— 把工具加进 `--allowedTools` |
| 对话丢了上下文 | 会话重启了 —— 用面板里显示的 session id 恢复 |

另见：[疑难排查](Troubleshooting.zh-CN)。
