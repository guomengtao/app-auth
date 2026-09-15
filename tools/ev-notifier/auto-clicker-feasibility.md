# Accessibility API 自动点击方案 - 可行性深度分析

## 调研实测

MacBook Air（8GB）三轮技术验证:

| 轮次 | 方法 | 结果 |
|------|------|------|
| 1 | pyobjc + Quartz | AXUIElementCreateApplication 未暴露 |
| 2 | ctypes + ApplicationServices | 遍历 Electron 子元素 SIGTRAP 崩溃 |
| 3 | AppleScript + System Events | 成功, VSCode 窗口发现 3 个 AXButton |

VSCode/AIoT IDE 在 System Events 中均为 "Electron" 进程。

## 内存

Python 主进程 30-50MB + 每实例 2-5MB = 合计约 50MB。
MacBook Air 8GB 无压力。ev-notifier 参考 90MB。

## CPU

空闲 <1%, 活跃 <2%, OCR降级 3-5%。

## 稳定性

System Events 跨桌面、不受分辨率影响、基于元素树而非坐标。

## 接口

枚举窗口/按钮列表/读标题状态/模拟点击/事件监听，均已验证可用。

## 核心风险

唯一待验证: Electron webview 内部 HTML 按钮对 AX 是否可见。

VSCode有无障碍支持(editor.accessibilitySupport: on)，Trae IDE继承此特性。

## 技术修正

AXUIElement C API -> osascript + System Events (ctypes在Electron上SIGTRAP崩溃)

## 验证命令

VSCode出现确认按钮后运行:

```bash
osascript -e '
tell application "System Events"
    tell process "Code"
        set allElems to entire contents of window 1
        repeat with elem in allElems
            try
                set t to title of elem
                set r to role of elem
                if length of t > 0 then
                    log "[" & r & "] " & t
                end if
            end try
        end repeat
    end tell
end tell'
```

输出含按钮文本 -> 可行。无输出 -> OCR降级。

## 结论

内存 ~50MB, CPU <3%, System Events稳定, 接口完整。
整体可行性高, 前提通过webview验证。