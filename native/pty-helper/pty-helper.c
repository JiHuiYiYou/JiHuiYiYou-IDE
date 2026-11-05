/*
 * pty-helper.exe —— 给子进程一个**真控制台**（Windows ConPTY）。
 *
 * ⚠️⚠️ **状态：已被 node-pty 取代 —— 留在这儿当「踩坑记录」。** ⚠️⚠️
 *
 * ## 为什么当初需要它
 *
 *   VS Code 的集成终端是**真控制台**（node-pty → ConPTY）⇒ 跑在里面的程序
 *   `isatty(1)` 是 TRUE ⇒ C 运行时**不缓冲** stdout ⇒
 *   `printf("请输入一个数字: ")` 立刻显示；`vim`/`top` 这类 TUI 也能接管屏幕。
 *
 *   而管道（`stdio: ['pipe','pipe','pipe']`）里的程序 `isatty(1)` 是 FALSE ⇒
 *   C 运行时**全缓冲** ⇒ 提示憋在 4KB 缓冲区里，直到程序退出才吐出来；
 *   TUI 程序直接拒绝运行。
 *
 *   当时 node-pty 装不上（原生模块，要 MSVC；这台机器没装）⇒ 自己写这一个。
 *
 * ## 现在的结论（2026-10-31，MSVC 装上之后）
 *
 *   **MSVC Build Tools 装好了 ⇒ node-pty 按 Electron 的 ABI 编出来了** ⇒
 *   IDE 的终端后端换成了 **node-pty（ConPTY）** ⇒ 验收点全过：
 *   - 孩子的 `GetFileType(stdout) == 2`（FILE_TYPE_CHAR，真控制台）✓
 *   - ConPTY 的渲染通道**有字节** ✓（`请输入一个数字: ` 在 +300ms 就到了，
 *     **在输入之前**）
 *   - `tty` → `/dev/cons0`、`stty size` → `30 100`（尺寸实时对得上）✓
 *
 *   ⇒ **这个助手不用再修了**，但**根因值得记下来**（下面）。
 *
 * ## 根因：这个助手跟 node-pty 差在哪（实测结论，别重走一遍）
 *
 *   2×2 的接线矩阵全试过了（管道方向 × bInheritHandles），**孩子的 stdout
 *   始终不是控制台**：
 *   - `WriteConsole(stdout)` 返回 `ERROR_INVALID_HANDLE`（6）
 *   - `GetFileType(stdout)` = 1（FILE_TYPE_DISK，不是 CHAR=2）
 *   - ConPTY 的**渲染通道一个字节都收不到**（输出泵一直阻塞在 ReadFile）
 *
 *   而 stdin **有时**能拿到控制台（`GetFileType=2`、`isatty=64`）。
 *
 *   ⇒ 真正的差别在**管道的种类**：
 *   - **这个助手**：`CreatePipe`（**匿名管道**）⇒ ConPTY 接不上客户端 ⇒
 *     渲染通道永远是空的。
 *   - **node-pty**（`src/win/conpty.cc` 的 `CreateNamedPipesAndPseudoConsole`）：
 *     **命名管道**（`CreateNamedPipe` + `ConnectNamedPipe`）⇒ ConPTY 才认。
 *
 *   另外 node-pty 的 `CreateProcess` 是这么写的（跟直觉相反）：
 *   - `dwFlags |= STARTF_USESTDHANDLES`，但三个 std 句柄**都传 NULL**
 *     （真控制台由 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 接管）
 *   - `bInheritHandles = false`
 *
 * ## 这个助手留下的好处
 *
 *   终端后端抽成了接口（`src/main/pty.ts` 的 `PtySession`）⇒ 管道版只是
 *   其中一种实现 ⇒ 换后端时上层一行都不用动 ✓（这次换后端就是这么换的）。
 *   而且**用户报的那个症状**（提示要等输入完才出现）已经在**语言仓库**那边
 *   从根上修了（`compiler/runtime/runtime.c` 的 `setvbuf(stdout, NULL, _IONBF, 0)`）
 *   ⇒ 不管终端是管道还是真控制台，提示都立刻可见 ✓。
 *
 * 用法（接口定好了，但**没接通** —— 生产路径走 node-pty）：
 *   pty-helper.exe <cols> <rows> <cmd> [args...]
 *
 * 数据流：
 *   自己的 stdout  ← ConPTY 的**渲染输出**（UTF-16 ⇒ 转成 UTF-8 送出去）
 *   自己的 stdin   → ConPTY 的输入（UTF-8 ⇒ 转成 UTF-16 写进去）
 *   fd 3           ← 尺寸变化（两个 uint32：cols, rows）⇒ ResizePseudoConsole
 *
 * 退出码 = 子进程的退出码。
 *
 * ⚠️ 字符串字面量**必须 ASCII** —— mingw 的 L"..." 不是 UTF-8 感知的
 *    （中文会变成乱码）。注释随便写。
 *
 * 编译：gcc -O2 -municode -o pty-helper.exe pty-helper.c
 */

#define _WIN32_WINNT 0x0A00 /* CreatePseudoConsole 需要 Win10 1809+ */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ConPTY 句柄（全局：尺寸变化那条线程要用）。 */
static HPCON g_hPC = NULL;

/* 两条泵各要两个句柄 ⇒ 用结构体传给线程。 */
typedef struct {
    HANDLE from; /* 从这儿读 */
    HANDLE to;   /* 写到这儿 */
} PipePair;

/* 调试日志（PTY_DEBUG=1 时才打）。写到 stderr **和**一个文件里 ——
 * 因为 ConPTY 建起来之后 stderr 会不会还通到管道里，并不好说。 */
static int g_debug = 0;
static FILE *g_log = NULL;

static void dbg(const wchar_t *msg)
{
    if (!g_debug) return;
    fwprintf(stderr, L"[pty] %s\n", msg);
    if (g_log) {
        fwprintf(g_log, L"[pty] %s\n", msg);
        fflush(g_log);
    }
}

/* UTF-16LE → UTF-8。ConPTY 的输出流是 UTF-16。 */
static DWORD WINAPI pump_output(LPVOID param)
{
    PipePair *p = (PipePair *)param;
    char buf[8192];
    for (;;) {
        DWORD got = 0;
        if (!ReadFile(p->from, buf, sizeof(buf), &got, NULL)) {
            dbg(L"output pump: ReadFile failed");
            break;
        }
        if (got == 0) {
            dbg(L"output pump: EOF");
            break;
        }
        dbg(L"output pump: got data");
        int wchars = (int)(got / sizeof(wchar_t));
        if (wchars <= 0) continue;
        int need = WideCharToMultiByte(CP_UTF8, 0, (const wchar_t *)buf, wchars,
                                       NULL, 0, NULL, NULL);
        if (need <= 0) continue;
        char *utf8 = (char *)malloc((size_t)need);
        if (!utf8) continue;
        WideCharToMultiByte(CP_UTF8, 0, (const wchar_t *)buf, wchars,
                            utf8, need, NULL, NULL);
        DWORD wrote = 0;
        WriteFile(p->to, utf8, (DWORD)need, &wrote, NULL);
        free(utf8);
    }
    return 0;
}

/* 自己的 stdin（UTF-8）→ ConPTY 输入（UTF-16）。 */
static DWORD WINAPI pump_input(LPVOID param)
{
    PipePair *p = (PipePair *)param;
    char buf[4096];
    for (;;) {
        DWORD got = 0;
        if (!ReadFile(p->from, buf, sizeof(buf), &got, NULL)) break;
        if (got == 0) break;
        int need = MultiByteToWideChar(CP_UTF8, 0, buf, (int)got, NULL, 0);
        if (need <= 0) continue;
        wchar_t *wide = (wchar_t *)malloc((size_t)need * sizeof(wchar_t));
        if (!wide) continue;
        MultiByteToWideChar(CP_UTF8, 0, buf, (int)got, wide, need);
        DWORD wrote = 0;
        WriteFile(p->to, wide, (DWORD)(need * sizeof(wchar_t)), &wrote, NULL);
        free(wide);
    }
    return 0;
}

/* fd 3 上的尺寸变化：两个 uint32（cols, rows）。 */
static DWORD WINAPI pump_resize(LPVOID param)
{
    HANDLE ctl = (HANDLE)param;
    for (;;) {
        DWORD got = 0;
        unsigned int size[2] = {0, 0};
        if (!ReadFile(ctl, size, sizeof(size), &got, NULL)) break;
        if (got < sizeof(size)) break;
        COORD c;
        c.X = (SHORT)size[0];
        c.Y = (SHORT)size[1];
        if (c.X <= 0 || c.Y <= 0) continue;
        ResizePseudoConsole(g_hPC, c);
    }
    return 0;
}

/* 调试探针：3 秒后往 pty 的输入里写一行（UTF-16），看孩子有没有反应。 */
static DWORD WINAPI debug_write(LPVOID param)
{
    PipePair *p = (PipePair *)param;
    Sleep(3000);
    dbg(L"debug: writing to pty input");
    const wchar_t *msg = L"7\r\n";
    DWORD wrote = 0;
    WriteFile(p->to, msg, (DWORD)(wcslen(msg) * sizeof(wchar_t)), &wrote, NULL);
    dbg(L"debug: wrote");
    return 0;
}

int wmain(int argc, wchar_t **argv)
{
    g_debug = getenv("PTY_DEBUG") != NULL;
    if (g_debug) {
        const char *logPath = getenv("PTY_DEBUG_LOG");
        if (logPath && *logPath) {
            /* 转成宽字符打开（路径是 ASCII 的） */
            int n = MultiByteToWideChar(CP_UTF8, 0, logPath, -1, NULL, 0);
            if (n > 0) {
                wchar_t *wlog = (wchar_t *)calloc((size_t)n, sizeof(wchar_t));
                if (wlog) {
                    MultiByteToWideChar(CP_UTF8, 0, logPath, -1, wlog, n);
                    g_log = _wfopen(wlog, L"wb");
                    free(wlog);
                }
            }
        }
    }
    if (argc < 4) {
        fwprintf(stderr, L"usage: pty-helper <cols> <rows> <cmd> [args...]\n");
        return 2;
    }
    int cols = _wtoi(argv[1]);
    int rows = _wtoi(argv[2]);
    if (cols <= 0) cols = 120;
    if (rows <= 0) rows = 30;

    dbg(L"start");
    /* 1) 两根管道：
     *    hInRead   —— ConPTY 从这儿**读**（我们往 hInWrite 写用户的按键）
     *    hOutWrite —— ConPTY 往这儿**写**（我们从 hOutRead 读渲染输出） */
    HANDLE hInRead = NULL, hInWrite = NULL, hOutRead = NULL, hOutWrite = NULL;
    if (!CreatePipe(&hInRead, &hInWrite, NULL, 0) ||
        !CreatePipe(&hOutRead, &hOutWrite, NULL, 0)) {
        fwprintf(stderr, L"CreatePipe failed %lu\n", GetLastError());
        return 1;
    }
    /* 管道默认是「可继承的」⇒ 显式关掉写端/读端的继承，
     * 不然子进程会抱着我们的写端不走（管道永远等不到 EOF）。 */
    SetHandleInformation(hInWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(hOutRead, HANDLE_FLAG_INHERIT, 0);
    dbg(L"pipes ok");

    /* 2) 建伪控制台 */
    COORD size;
    size.X = (SHORT)cols;
    size.Y = (SHORT)rows;
    HRESULT hr = CreatePseudoConsole(size, hInRead, hOutWrite, 0, &g_hPC);
    CloseHandle(hInRead);
    CloseHandle(hOutWrite);
    if (FAILED(hr)) {
        fwprintf(stderr, L"CreatePseudoConsole failed 0x%08lx\n", (unsigned long)hr);
        return 1;
    }
    dbg(L"CreatePseudoConsole ok");
    /* 先按同样的尺寸 resize 一次 —— conhost 的渲染器是这时候才起来的 */
    ResizePseudoConsole(g_hPC, size);

    /* 3) 起子进程，挂到伪控制台上 */
    SIZE_T attrSize = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &attrSize);
    LPPROC_THREAD_ATTRIBUTE_LIST attrs =
        (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attrSize);
    if (!attrs || !InitializeProcThreadAttributeList(attrs, 1, 0, &attrSize) ||
        !UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                   g_hPC, sizeof(HPCON), NULL, NULL)) {
        fwprintf(stderr, L"UpdateProcThreadAttribute failed %lu\n", GetLastError());
        return 1;
    }
    dbg(L"attrs ok");

    /* 命令行：把 argv[3..] 用引号拼起来 */
    size_t need = 1;
    for (int i = 3; i < argc; i++) need += wcslen(argv[i]) + 3;
    wchar_t *cmdline = (wchar_t *)calloc(need, sizeof(wchar_t));
    if (!cmdline) return 1;
    for (int i = 3; i < argc; i++) {
        if (i > 3) wcscat_s(cmdline, need, L" ");
        wcscat_s(cmdline, need, L"\"");
        wcscat_s(cmdline, need, argv[i]);
        wcscat_s(cmdline, need, L"\"");
    }

    STARTUPINFOEXW si;
    ZeroMemory(&si, sizeof(si));
    si.StartupInfo.cb = sizeof(si);
    si.lpAttributeList = attrs;
    /*
     * ⚠️ **不要设 STARTF_USESTDHANDLES** —— 挂了 PSEUDOCONSOLE 属性之后，
     *    conhost 会把子进程的 stdio 接成**这个控制台自己的**（CONIN$/CONOUT$）
     *    ⇒ 它的 `GetFileType(stdout)` 是 FILE_TYPE_CHAR ⇒ `isatty(1)` 为 TRUE
     *    ⇒ C 运行时**不缓冲**它 ⇒ 提示立刻可见、TUI 能跑 ✓
     *    （实测：孩子自己报告 GetFileType(stdout)=2 ✓）
     */
    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(NULL, cmdline, NULL, NULL, FALSE,
                        EXTENDED_STARTUPINFO_PRESENT, NULL, NULL,
                        &si.StartupInfo, &pi)) {
        fwprintf(stderr, L"CreateProcess failed %lu\n", GetLastError());
        return 1;
    }
    dbg(L"child created");
    free(cmdline);

    /* 4) 三条泵 */
    PipePair outPair;
    outPair.from = hOutRead;
    outPair.to = GetStdHandle(STD_OUTPUT_HANDLE);
    PipePair inPair;
    inPair.from = GetStdHandle(STD_INPUT_HANDLE);
    inPair.to = hInWrite;

    HANDLE tOut = CreateThread(NULL, 0, pump_output, &outPair, 0, NULL);
    HANDLE tIn = CreateThread(NULL, 0, pump_input, &inPair, 0, NULL);
    HANDLE tSize = NULL;
    HANDLE ctl = GetStdHandle((DWORD)-11); /* fd 3 */
    if (ctl != NULL && ctl != INVALID_HANDLE_VALUE) {
        tSize = CreateThread(NULL, 0, pump_resize, ctl, 0, NULL);
    }
    dbg(L"pumps started");

    if (getenv("PTY_DEBUG_INPUT")) {
        PipePair dbgPair;
        dbgPair.from = NULL;
        dbgPair.to = hInWrite;
        CreateThread(NULL, 0, debug_write, &dbgPair, 0, NULL);
    }

    /* 等子进程结束 ⇒ 把退出码带出去 */
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    dbg(L"child exited");

    /* 关掉管道 ⇒ 两条泵线程自己会退出（ReadFile 返回 0） */
    CloseHandle(hInWrite);
    CloseHandle(hOutRead);
    ClosePseudoConsole(g_hPC);

    if (tOut) WaitForSingleObject(tOut, 1000);
    if (tIn) WaitForSingleObject(tIn, 1000);
    if (tSize) CloseHandle(tSize);

    return (int)code;
}
