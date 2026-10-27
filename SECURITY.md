# Security Policy（安全策略）

## Supported versions（受支持的版本）

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Reporting a vulnerability（报告漏洞）

**Please do not open a public issue for a security problem.**
Email the maintainer instead, or use GitHub's
[private vulnerability reporting](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/security/advisories/new).

Please include: what you did, what you expected, what happened instead, and the IDE
version plus the OS.

You can expect an acknowledgement within a few days. Please give the maintainer a
reasonable window to release a fix before disclosing publicly.

## Scope（适用范围）

The IDE runs code on your machine, so a few things are worth spelling out:

- **The IDE executes the programs you open.** That is its job — running a `.jhyy` file
  runs native code. Do not open programs you do not trust.
- **The embedded Claude Code can read and write files** in the project directories you
  give it, and can run commands. It is the same `claude` CLI you use in the terminal,
  with the same permissions.
- **The IDE spawns the local `jhyy.exe`** and the local `claude` CLI. Both are located
  automatically; the compiler search order is documented in the
  [wiki](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/wiki/Getting-Started).
- **The installer is not code-signed.** Windows SmartScreen will warn about it.

Vulnerabilities in the **JHYY language or the compiler** belong to the
[compiler repository](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler).
