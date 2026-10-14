/*
 * Frida 常见检测规避: 隐藏 frida-server 端口、frida-agent 字符串、
 * /proc/self/maps 里的 frida 条目、以及 ptrace 调用.
 *
 * 注意: 游戏安全套件 (Tencent TP / NetEase MG / Garena ACE) 的检测项非常多,
 *       这里只覆盖最朴素的几种 "FridaDetector" 示例.
 */

const originalOpen = Module.findExportByName(null, 'open');
Interceptor.attach(originalOpen, {
    onEnter(args) {
        const path = Memory.readUtf8String(args[0]);
        this.filter = path && (path.indexOf('maps') !== -1 || path.indexOf('status') !== -1);
    },
    onLeave(retval) {
        // 真正的隐藏要替换 read() 返回值, 这里只演示入口
    },
});

// 过滤 /proc/self/maps 里带 "frida" / "gum-js-loop" / "gmain" 的行
const readFn = new NativeFunction(Module.findExportByName(null, 'read'),
                                  'ssize_t', ['int', 'pointer', 'size_t']);
Interceptor.replace(Module.findExportByName(null, 'read'),
    new NativeCallback(function (fd, buf, count) {
        const n = readFn(fd, buf, count);
        if (n <= 0) return n;
        let s = Memory.readUtf8String(buf, n);
        if (s && (s.indexOf('frida') !== -1 || s.indexOf('gum-js-loop') !== -1 || s.indexOf('gmain') !== -1)) {
            s = s.split('\n').filter(l =>
                l.indexOf('frida') === -1 &&
                l.indexOf('gum-js-loop') === -1 &&
                l.indexOf('gmain') === -1
            ).join('\n');
            Memory.writeUtf8String(buf, s);
            return s.length;
        }
        return n;
    }, 'ssize_t', ['int', 'pointer', 'size_t']));

// 吞掉 ptrace(PTRACE_TRACEME) 的失败
const ptrace = Module.findExportByName(null, 'ptrace');
if (ptrace) {
    Interceptor.replace(ptrace, new NativeCallback(function () { return 0; },
        'long', ['int', 'int', 'pointer', 'pointer']));
}

console.log('[+] anti-detect patches installed');
