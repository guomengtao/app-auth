# Mac 弹窗 + 语音通知实现说明

## 一、背景

项目规则要求：**每次对话完成后，用 macOS 弹出通知 + 语音提醒用户**。
现在的实现是在终端执行一条 shell 命令，由两部分组成：

- `osascript` —— 发送系统通知中心弹窗（macOS 原生，无需依赖）；
- `tools/ev-notifier/say-edge.py` —— 语音合成（TTS）朗读，用 **Microsoft Edge TTS（晓晓音色）**，音质接近真人。

两个可执行文件的分工：

| 文件 | 作用 | 依赖 |
| --- | --- | --- |
| `tools/ev-notifier/say-edge.py` | IDE 侧语音朗读（本说明的主角） | Homebrew `python@3.14` + `edge-tts` |
| `tools/ev-notifier/ev_notifier.py` | 应用侧语音播报（收订单消息时自动朗读） | 同上，但代码独立、互不 import |

> 两者**共用**音色与缓存目录 `~/.ev_tts_cache/`，但脚本各自独立（符合「每个 .py 可直接运行」的项目约定）。

---

## 二、一次通知的完整命令

```bash
osascript -e 'display notification "添加课程页已修复：底部不再固定，星期与按钮不再重叠" with title "Ev课程表 · 已修复"' ; ~/Documents/guomengtao/app-auth/tools/ev-notifier/say-edge.py "添加课程页已修复，底部不再固定，星期与按钮不再重叠"
```

拆成两段看：

1. `osascript -e '...'` —— 弹窗；
2. `say-edge.py "..."` —— 语音（Edge TTS 晓晓）；
3. 中间用 **`;`** 连接（不是 `&&`，原因见第五节）。

成功时会打印 `spoken via edge-tts (zh-CN-XiaoxiaoNeural)`；降级时会打印 `spoken via macOS say (fallback)` 并把原因写到 stderr。

---

## 三、弹窗：`osascript`

`osascript -e '<AppleScript 代码>'` 用于执行一段 AppleScript。
`display notification` 由系统的「标准脚本添加（Standard Additions）」提供，语法：

```applescript
display notification "通知正文" with title "标题" subtitle "副标题" sound name "Glass"
```

- `with title`：推荐带上，否则通知可能显示异常；
- `subtitle`、`sound name`：可选，本项目不使用（声音交给 `say-edge.py`）。

只弹窗不出声的最简形式：

```bash
osascript -e 'display notification "正文" with title "标题"'
```

---

## 四、语音：`say-edge.py`（Edge TTS 晓晓）

底层是开源库 [edge-tts](https://github.com/rany2/edge-tts)：**免注册、免 API Key、无调用次数限制**，通过微软 Edge 的在线语音服务合成 mp3，再用 `afplay` 播放。

```bash
say-edge.py "要朗读的文本"
```

### 常用参数

| 参数 | 作用 | 示例 |
| --- | --- | --- |
| 位置参数 | 要朗读的文本（多个参数会用空格拼接） | `say-edge.py "构建完成"` |
| `--voice <名字>` | 指定 Edge TTS 音色 | `say-edge.py --voice zh-CN-YunxiNeural "换成男声"` |
| `--rate <偏移>` | 语速偏移，默认 `+0%` | `say-edge.py --rate +20% "说快一点"` |
| `--fallback-only` | 跳过 Edge TTS，只用系统 `say` | `say-edge.py --fallback-only "断网调试"` |
| `--list-voices` | 列出全部中文音色 | `say-edge.py --list-voices` |

环境变量可改默认值（不改代码就能换音色）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EV_TTS_VOICE` | `zh-CN-XiaoxiaoNeural` | 晓晓，女声，温柔自然 |
| `EV_TTS_RATE` | `+0%` | 语速偏移 |

### 缓存

同一条文本（同音色同语速）只合成一次，mp3 落在 **`~/.ev_tts_cache/`**，文件名 = `sha1(音色|语速|文本)`，超过 300 条按修改时间淘汰。因此「构建完成」「已改好」这类高频短语第二次起是**离线瞬时**播放。

### 降级链（保证永不哑）

```
edge-tts 可用 ──→ 合成 mp3（15s 超时）──→ afplay 播放        ✅ 正常
   │
   └─ 不可用（未安装 / 断网 / 超时 / 播放失败）
              └──→ macOS say（Tingting → Sinji → Meijia → 系统默认）  ✅ 兜底
                        │
                        └─ 全部失败 → 退出码 1 + stderr 报错
```

`say` 的语速会按百分比换算成 `-r <wpm>`（例如 `+20%` → 210 wpm），保持听感一致。

### 本机 `say` 可用的中文语音（仅降级时使用）

用 `say -v '?'` 列出全部语音，本机中文语音如下（语音名区分大小写）：

| 语音名 | 语言 | 备注 |
| --- | --- | --- |
| `Tingting` | zh_CN | 普通话（降级链首选） |
| `Eddy` / `Flo` / `Grandma` / `Grandpa` / `Reed` / `Rocko` / `Sandy` / `Shelley` | zh_CN | 普通话，不同音色/角色 |
| `Meijia` | zh_TW | 台湾腔 |
| `Sinji` | zh_HK | 粤语（善怡） |

> 注意：部分资料里写作 `Ting-Ting`，但本机实际注册名是 **`Tingting`**。

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
  3. `say-edge.py` 的朗读文本；
- 例如：
  ```bash
  osascript -e 'display notification "简述本次改动" with title "Ev课程表 · 已改好"' ; ~/Documents/guomengtao/app-auth/tools/ev-notifier/say-edge.py "简述本次改动"
  ```
- 若当前目录就是 `app-auth`，可简写成 `tools/ev-notifier/say-edge.py "..."`。

---

## 七、注意事项

1. **仅 macOS 有效**：`osascript` / `afplay` / `say` 都是 macOS 专属，其他系统需换用各自的通知机制。
2. **Edge TTS 需要联网**：合成是在线的（这也是它免费且音质好的原因），断网时会降级到 `say`，听感会明显变"机械"。
3. **依赖安装**（换机器必做，详见 `运维手册-换机器与排障.md` §2）：
   ```bash
   brew install python@3.14
   /opt/homebrew/opt/python@3.14/bin/python3.14 -m pip install --break-system-packages edge-tts
   ```
   脚本 shebang 写死了 `/opt/homebrew/opt/python@3.14/bin/python3.14`（该解释器才有 `edge-tts`）。
4. **通知权限**：首次使用可能需要在「系统设置 → 通知」中允许对应终端 / IDE 的通知权限，否则弹窗不显示（但语音仍会响）。
5. **引号转义**：命令用单引号包裹 AppleScript，故正文里如需英文双引号要转义，避免提前截断命令；中文标点不受影响。
6. **音量**：脚本只负责发声，音量大小由系统音量决定。
7. **历史**：本说明早期版本用的是 `say -v Tingting`（纯系统 TTS），2026-09-27 起换成 Edge TTS 晓晓；`say` 退居降级兜底。
