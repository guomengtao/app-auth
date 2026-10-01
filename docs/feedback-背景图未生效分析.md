# feedback.html 背景图「没生效」分析

> 页面：`https://app-auth.gudq.com/feedback.html`（`vercel.json` 里也映射了 `/feedback`、`/feedback/`）
> 文件：`ev/app-auth/feedback.html`
> 分析时间：2026-10-02

---

## 一、结论（先说答案）

**这个页面从头到尾就没有引用过任何背景图。它现在的「背景」是纯 CSS 渐变，不是图片。**

所以不是「图加载失败 / 没生效」，而是「根本没有图」。你看到的差异，要么是把某种效果误当成图片，要么是改动没有落到代码里（工作区是干净的，没有未提交改动）。

---

## 二、证据

| 检查项 | 结果 |
|---|---|
| `feedback.html` 里所有 `url(` | 只有 3 处，全部是 `canvas.toDataURL()` / `FileReader.readAsDataURL()`（截图压缩上传用），与背景无关 |
| 全仓库 HTML 中的 `background-image` | **0 处**（18 个页面全部没有） |
| `images/` 目录内容 | 只有 `ev-schedule/` 一棵子树（107 个已入库文件），**没有任何 feedback 相关的背景图** |
| 线上 vs 本地 | `curl https://app-auth.gudq.com/feedback.html` → HTTP 200，18181 字节，与本地 `feedback.html`、`.vercel/output/static/feedback.html` **逐字节一致**（`diff` 无差异） |
| 假定图片路径探测 | `/images/feedback-bg.png` → **404**；对照组 `/images/ev-schedule/apk/01-home-top.jpg` → **200 image/jpeg**（说明静态目录本身是通的，图确实不存在） |
| git 状态 | 工作区干净，无未提交改动；`feedback.html` 全部历史只有 4 个提交 |

### 关键：最后一次改动就是「渐变」，不是图

```
60d6138 ui(feedback): 大背景渐变美化；FAQ 折叠改纯 JS 驱动
```

这次提交把原来的 `background:var(--bg);`（纯色 `#f3f4f8`）换成了现在的三层渐变。**所谓「大背景」一直是 CSS 画的，历史上从来没有引用过图片资源。**

---

## 三、为什么「看起来像没有背景」

就算不谈图片，现在这三层渐变本身也几乎看不见，原因有 4 个，全部在 `feedback.html:16-20`：

```css
body { ...
  background:
    radial-gradient(900px 300px at 15% -60px, rgba(108,99,255,0.10), transparent 70%),
    radial-gradient(700px 260px at 90% -40px, rgba(53,196,214,0.08), transparent 70%),
    linear-gradient(180deg, #eef1fb 0%, #f4f5fa 340px, #f3f4f8 100%);
  background-attachment: scroll; min-height:100vh; }
```

1. **渐变中心画到了页面上边界外面**：`-60px` / `-40px` 意味着圆心在 body 顶边再往上，垂直半径只有 300px / 260px，绝大部分落在可视区外，只漏出最下面一条边。
2. **透明度太低**：紫色 0.10、青色 0.08，叠在 `#eef1fb` 上，肉眼基本分辨不出。
3. **被 sticky 顶栏压住**：`.topbar`（`:22` 行）背景是 `rgba(243,244,248,0.94)` + `backdrop-filter:blur(6px)`，正好是最亮的那一段位置，直接被遮住（页面顶部约 45px）。
4. **内容区被白卡占满**：`.wrap` 最大宽 760px，里面全是白色不透明 `.card`；手机端一张卡几乎吃满屏宽，能露出来的边距非常窄，自然「看不到背景」。

补充一个容易被忽略的机制：**背景向 canvas 传播**。`html` 元素没有设置 background，浏览器会把 `body` 的背景提升绘制到整个画布上，此时背景层的定位与尺寸是相对**整个画布**而不是 body 盒子计算的。页面很长（FAQ 折叠后更是一屏装不下），往下滚之后除了那条 `#f3f4f8` 底色，其它装饰层早就不在视口里了——这也是「往下看完全没背景」的原因。

---

## 四、如果你要真加一张背景图：这 5 个坑会让它「加了也白加」

按本仓库的实际情况，按踩坑概率排序：

### 1. 必须用绝对路径 `/images/...`（本仓库最容易踩）

`vercel.json` 里同时存在两条路由：

```json
{ "source": "/feedback",  "destination": "/feedback.html" },
{ "source": "/feedback/", "destination": "/feedback.html" }
```

如果写相对路径 `url(images/feedback-bg.webp)`：
- 在 `/feedback` 下解析成 `/images/feedback-bg.webp` ✅
- 在 `/feedback/` 下解析成 `/feedback/images/feedback-bg.webp` ❌ 404

**写 `url("/images/feedback-bg.webp")` 才两种入口都稳。**

### 2. 图片必须提交进 git 并触发部署

- `images/` 目录已入库且线上可访问（已验证 200），不是被 `.gitignore` 拦掉的。
- ⚠️ `.vercel/output/static/` 是**本地构建产物快照**（本次 10-02 00:16 生成，`.vercel` 已在 `.gitignore`），**它不是发布源**。改那里没用。
- 正确流程：改 `feedback.html` → `git commit` → `git push` → Vercel 重新部署 → 强刷（`Cmd+Shift+R`）。

### 3. App 内 WebView 的兼容兜底

这个页面会被 APK 内的 WebView 打开（脚本里 `QP.src === 'app'` 就是这条路径）。老版本 Android System WebView 上：

- 多背景层 + `background-size:cover` 支持不一致，建议加 `-webkit-background-size` 兜底写法；
- **不要用 `background-attachment: fixed`**，老 WebView 上要么表现异常、要么滚动卡顿（现在写的 `scroll` 是对的，保持）；
- `.topbar` 的 `backdrop-filter` 在老 WebView 上不生效（会退化成半透明实色），这也是「顶部一块死板」的来源之一。

### 4. 图上去了也可能看不见

`.card` / `.faq-item` / `textarea` / `input` 全是不透明白色，加上 96% 不透明的顶栏，实际能透出来的只有页面左右边距和卡片之间的缝隙。**想让背景有价值，至少同步做两件事**：给 `.topbar` 降透明度（或滚动后才变实色）、给 `.card` 用半透明底色（如 `rgba(255,255,255,0.86)` + `backdrop-filter`）。

### 5. 体积

这类大背景建议 webp ≤ 100KB（参考留言板本身对截图的压缩策略：≤960px、webp q0.7）。平铺型纹理可以用更小的倍图 + `background-repeat`。

---

## 五、最小改动参考片段

把 `feedback.html:16-20` 的 `background` 换成下面这样（图 + 渐变叠加，图在下层）：

```css
html { background:#f3f4f8; }              /* 让 html 接管底色，避免背景传播导致的定位怪异 */
body {
  background-color:#f3f4f8;
  background-image:
    linear-gradient(180deg, rgba(238,241,251,.55) 0%, rgba(243,244,248,.92) 320px),
    radial-gradient(900px 300px at 15% 0, rgba(108,99,255,.14), transparent 70%),
    radial-gradient(700px 260px at 90% 0, rgba(53,196,214,.12), transparent 70%),
    url("/images/feedback-bg.webp");       /* ← 必须是绝对路径 */
  background-repeat:no-repeat, no-repeat, no-repeat, repeat;
  background-position:center top, center top, center top, center top;
  background-size:auto, auto, auto, cover;
  background-attachment:scroll;
}
```

想让它在手机上也看得见，顶栏和卡片同步调整：

```css
.topbar { background:rgba(243,244,248,.72); }   /* 原 .94 → .72，或用 JS 滚动后加实色 class */
.card, .faq-item { background:rgba(255,255,255,.88); }
```

> ⚠️ 注意 `.faq-item` 的背景是 `var(--surface)`，`h2.sec::before`、`.faq-a` 的虚线边框等也会跟着透出来，改完后需在手机和 App WebView 内各看一遍。

---

## 六、验证清单

```bash
# 1) 图片确实可访问（期望 200，而不是 404）
curl -sSI https://app-auth.gudq.com/images/feedback-bg.webp | head -1

# 2) 线上 HTML 里确实带上了引用
curl -s https://app-auth.gudq.com/feedback.html | grep -c 'feedback-bg'

# 3) 线上文件与本地是否同步（应无输出）
curl -s https://app-auth.gudq.com/feedback.html | diff - ./feedback.html
```

浏览器侧：强刷 `Cmd+Shift+R`，分别看 `/feedback`、`/feedback/`、`/feedback.html` 三个入口，再从 APK 里打开一次确认 WebView 表现一致。

---

## 七、修复记录（2026-10-02 已改）

已按第五节方案改 `feedback.html`（**尚未 commit / push，本地改动**）：

| 位置 | 改动 | 目的 |
|---|---|---|
| `:15` 新增 `html { background:#f3f4f8; }` | html 接管底色 | 阻断 body 背景向画布传播导致的定位/尺寸错乱 |
| `:16-31` body 背景重写 | 拆成 4 层：`紫光晕 / 青光晕 / 半透明过渡 / url("/images/feedback-bg.webp")` | 光晕透明度 0.10→0.20、0.08→0.16，半径 300→460、260→380，圆心从 `-60px/-40px` 上移到 `-40px/0px`（不再大半在视口外）；层叠替代不透明 linear 底色，让背景图能被透出来 |
| `:19` `background-color:#f3f4f8` | 兜底纯色 | 老 WebView 不支持多层背景时不至于白屏 |
| `:33` `.topbar` 背景 `.94→.86` + `-webkit-backdrop-filter` | 顶栏更透 | 顶部装饰不再被完全盖住，兼容前缀补上 |
| `url("/images/feedback-bg.webp")` | **绝对路径**且图片当前不存在 | `/feedback` 与 `/feedback/` 两个入口都正确；图缺失时该层被忽略、其余渐变照常显示。以后只要把同名 webp 放进 `images/` 并提交部署即可自动生效 |

验证：CSS 括号平衡 OK，body 规则内 `url(` 仅 1 处（预期的背景图层），无 lint 错误。

**待办**：现在是「更强的渐变」而非真正的照片背景。若要上图 → 放 `images/feedback-bg.webp`（建议 ≤100KB）→ `git commit && git push` → Vercel 部署后强刷验证三个入口（`/feedback`、`/feedback/`、`/feedback.html`）。

---

## 八、一句话总结

> 页面没坏，**它压根儿没有背景图**——最后一次 UI 提交（`60d6138`）把「大背景」实现成了 CSS 渐变，而这个渐变又因为圆心在视口外、透明度只有 0.08~0.10、被 sticky 顶栏和不透明白卡层层遮住，看起来就像「背景没生效」。要真上图，就按第五节改，并注意「绝对路径 + 提交部署 + 把白卡改成半透明」这三件事。
