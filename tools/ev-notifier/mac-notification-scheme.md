# Mac 弹窗 + 语音通知实现说明

## 一、背景

项目规则要求：**每次对话完成后，用 macOS 弹出通知 + 语音提醒用户**。
实现方式是在终端执行 shell 命令，调用 macOS 系统自带的两个命令行工具：

- `osascript` —— 发送系统通知中心弹窗；
- `say` —— 语音合成（TTS）朗读。

两者都不需要安装任何第三方依赖，属于 macOS 原生能力。

---

## 二、一次通知的完整命令

```bash
osascript -e 'display notification "添加课程页已修复：底部不再固定，星期与按钮不再重叠" with title "Ev课程表 · 已修复"' ; say -v Tingting "添加课程页已修复，底部不再固定，星期与按钮不再重叠"
```

拆成两段看：

1. `osascript -e '...'` —— 弹窗；
2. `say -v Tingting "..."` —— 语音；
3. 中间用 **`;`** 连接（不是 `&&`，原因见第五节）。

---

## 三、弹窗：`osascript`

`osascript -e '<AppleScript 代码>'` 用于执行一段 AppleScript。
`display notification` 由系统的「标准脚本添加（Standard Additions）」提供，语法：

```applescript
display notification "通知正文" with title "标题" subtitle "副标题" sound name "Glass"
```

- `with title`：推荐带上，否则通知可能显示异常；
- `subtitle`、`sound name`：可选，本项目不使用（声音交给 `say`）。

只弹窗不等语音的最简形式：

```bash
osascript -e 'display notification "正文" with title "标题"'
```

---

## 四、语音：`say`

`say` 是 macOS 内置的文本朗读命令。

```bash
say -v Tingting "要朗读的文本"
```

- `-v <语音名>`：指定发音人；省略则用系统默认语音；
- 文本直接放在参数末尾，通常用双引号包裹。

### 本机实测可用的中文语音

用 `say -v '?'` 列出全部语音，本机的中文语音如下（语音名区分大小写）：

| 语音名 | 语言 | 备注 |
| --- | --- | --- |
| `Tingting` | zh_CN | 普通话（本说明默认使用） |
| `Eddy` / `Flo` / `Grandma` / `Grandpa` / `Reed` / `Rocko` / `Sandy` / `Shelley` | zh_CN | 普通话，不同音色/角色 |
| `Meijia` | zh_TW | 台湾腔 |
| `Sinji` | zh_HK | 粤语（善怡） |

> 注意：部分资料里写作 `Ting-Ting`，但本机实际注册名是 **`Tingting`**。为保证发声可靠，命令里统一用 `-v Tingting`。
> 含空格或括号的语音名（如 `Eddy (Chinese (China mainland))`）需要整体加引号。

### 常用参数

| 参数 | 作用 | 示例 |
| --- | --- | --- |
| `-v <name>` | 指定语音 | `say -v Sinji "粤语播报"` |
| `-r <wpm>` | 语速（词/分钟，默认约 175） | `say -r 220 -v Tingting "更快"` |
| `-o <file>` | 输出到音频文件而不播放 | `say -o out.aiff "文本"` |
| `-v '?'` | 列出所有可用语音 | `say -v '?'` |

---

## 五、为什么用 `;` 而不是 `&&`

- `A && B`：只有 A（弹窗）成功才执行 B（语音）。一旦通知权限被关掉，语音也会一起不响；
- `A ; B`：无论 A 是否成功，B 都会执行。

通知是「锦上添花」，语音是重点提示，因此用 `;` 保证**即使弹窗失败，语音也会照常播放**。

---

## 六、在本项目中的集成方式

- 通过 IDE 的 shell 执行能力运行上述命令（等价于在本机终端执行），命令会请求用户确认后才运行；
- 每次完成实质性改动后，只需替换命令里的三处文案：
  1. 弹窗正文，
  2. 弹窗标题，
  3. `say` 的朗读文本；
- 例如：
  ```bash
  osascript -e 'display notification "简述本次改动" with title "Ev课程表 · 已改好"' ; say -v Tingting "简述本次改动"
  ```

---

## 七、注意事项

1. **仅 macOS 有效**：`osascript` / `say` 是 macOS 专属，其他系统需换用各自的通知机制。
2. **通知权限**：首次使用可能需要在「系统设置 → 通知」中允许对应终端 / IDE 的通知权限，否则弹窗不显示（但语音仍会响）。
3. **语音名以实测为准**：不同 macOS 版本 / 语言包下可用语音不同，写死前先用 `say -v '?'` 确认。
4. **引号转义**：命令用单引号包裹 AppleScript，故正文里如需英文双引号要转义，避免提前截断命令；中文标点不受影响。
5. **音量**：`say` 只负责发声，音量大小由系统音量决定。