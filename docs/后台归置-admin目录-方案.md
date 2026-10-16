# 后台文件归置 /admin/ 目录 + 登录门禁中间件 — 实施方案

> 任务单号：`evtask-D-guomengtao-261016-j23qd8`
> 会话：workbuddy-20261014-2020-a3e6 ｜ 仓库：`ev/app-auth`（独立 git 仓库，含 auth 黑名单 pre-commit 钩子）
> 状态：方案待审核（需用户明确同意后开工）

## 一、目标
1. 在站点新增 `/admin/` 目录，把后台页面统一归置进去。
2. 新增 Vercel 中间件：未登录访问 `/admin/*` 任意页面 → 307 跳登录页；登录页本身豁免。
3. 搬家后所有相关硬编码跳转地址同步修正，保证功能不中断。

## 二、核心约束（已实测确认）
- **Vercel 中间件跑在 Edge runtime**，`crypto.createHmac`（Node 版）不可用 → 中间件验签必须用 **Web Crypto `crypto.subtle`** 重写 HMAC-SHA256 校验。
- `ev/app-auth` 是独立仓库，有自己含 auth 黑名单的 `pre-commit` 钩子；黑名单文件（`auth.js`/`login_aXs12.html`/`oauth.js` 含 "auth" 关键字）编辑前必须认领（认领单 `x37` 已挂在 `ev/app-auth` 仓库下，覆盖本次全部待改文件）。
- **`api/admin/*` 函数不能物理搬**（Vercel 按 `/api/` 目录定路由，搬走即失效）。用户原选「页面+api一起归置」，经纠正后采用：页面进 `/admin/`，api 函数留 `api/admin/`，二者观感上同属后台，且 api 本就在函数层 `requireAuth` 受保护。
- 鉴权 cookie 名 = `token`（HS256，密钥 `process.env.JWT_SECRET`，payload 必须含 `exp`）。前端保护靠中间件，数据保护靠函数层 `requireAuth`，双保险。

## 三、文件级改动清单

### 3.1 移动（git mv）
| 原路径 | 新路径 | 说明 |
|---|---|---|
| `admin_Dx23.html` | `admin/admin_Dx23.html` | 后台首页/大盘 |
| `admin-feedback.html` | `admin/admin-feedback.html` | 反馈管理 |
| `admin-bandbbs.js` | `admin/admin-bandbbs.js` | 米坛运营后台脚本（与首页同搬，相对引用不变） |
| `dash4.html` | `admin/dash4.html` | 数据大屏，被后台首页以新窗口打开，属后台文件，一并归置受保护 |

> `js/lucide.min.js` 为共享库（非后台专属），**不搬**，从 `/admin/` 以 `../js/` 引用。

### 3.2 引用修正（不搬家、改路径）
| 文件:行 | 原值 | 新值 | 原因 |
|---|---|---|---|
| `admin_Dx23.html:5400` | `src="js/lucide.min.js"` | `src="../js/lucide.min.js"` | 相对根上移一层 |
| `admin-feedback.html:46` | `href="/admin_Dx23.html"` | `href="/admin/admin_Dx23.html"` | 回链后台首页 |
| `admin-feedback.html:83` | `href="/admin_Dx23.html"` | `href="/admin/admin_Dx23.html"` | 未登录提示中的回链 |
| `login_aXs12.html:178` | `location.href='/admin_Dx23.html'` | `'/admin/admin_Dx23.html'` | 登录成功跳转 |
| `api/oauth.js:151` | `Location: nextPath \|\| "/admin_Dx23.html"` | `"/admin/admin_Dx23.html"` | **OAuth 回跳（最关键，否则登录后 404）** |
| `sitemap.html:202` | `url:"/admin-feedback.html"` | `"/admin/admin-feedback.html"` | 公开站点地图链接 |
| `sitemap.html:203` | `url:"/admin_Dx23.html"` | `"/admin/admin_Dx23.html"` | 同上 |
| `test/admin-panel.inline-js.test.js:15` | `..', 'admin_Dx23.html'` | `'..', 'admin', 'admin_Dx23.html'` | 单测定位路径 |

> 以下**无需改**：`admin_Dx23.html:5745` 登出跳 `/login_aXs12.html?logout=1`（登录页在根目录，豁免）；`admin_Dx23.html:12839` 引用 `admin-bandbbs.js`（同搬同目录，相对不变）；`admin_Dx23.html:3650` 引用 `dash4.html`（同搬同目录，相对不变）。

### 3.3 新增文件
- `middleware.js`（项目根）：Edge 中间件，matcher `/admin/:path*`，验 `token` cookie（Web Crypto），无效则 `307 → /login_aXs12.html`。

### 3.4 vercel.json 追加（可选但建议）
- `redirects`：`/admin_Dx23.html → /admin/admin_Dx23.html`、`/admin-feedback.html → /admin/admin-feedback.html`（保留旧书签不 404）。

## 四、中间件设计（middleware.js 要点）
```
export const config = { matcher: "/admin/:path*" };
export default async function middleware(req) {
  const token = req.cookies.get("token")?.value;
  if (token && await verifyJwtEdge(token, process.env.JWT_SECRET)) {
    return NextResponse.next();
  }
  const url = new URL("/login_aXs12.html", req.url);
  return NextResponse.redirect(url); // 307
}
```
- `verifyJwtEdge`：用 `crypto.subtle.importKey` + `crypto.subtle.verify`（HMAC-SHA256）替代 Node `createHmac`；base64url 编解码自行实现；校验 `payload.exp` 未过期。
- 不实现 `next` 回跳参数（保持简单低风险）：登录后固定落 `/admin/admin_Dx23.html`。如需 `next` 需再改 `api/oauth.js` 与登录页，列为后续可选。
- `/admin/api/*` 路径当前不存在（未做 rewrite），故 matcher 只命中 HTML 页面，无需排除。

## 五、风险与回滚
- **风险1**：`JWT_SECRET` 未配 → 中间件验签全失败、所有后台页被挡。缓解：部署前确认 Vercel 项目环境变量已设 `JWT_SECRET`（现有登录本就依赖它，假设已设）。
- **风险2**：Edge 运行时 `process.env.JWT_SECRET` 注入时机。Vercel 对敏感变量在 edge 运行时可用。
- **风险3**：搬家漏改某处硬编码路径 → 功能断链。缓解：改动清单已用全仓 grep 穷举（见 3.2），执行后逐一 curl 验证。
- **回滚**：`git -C ev/app-auth revert` 本次 commit 即可；vercel.json redirects 一并回退。

## 六、验收（执行后）
1. `curl -I https://app-auth.gudq.com/admin/admin_Dx23.html` → 307 跳 `/login_aXs12.html`。
2. 登录后访问 `/admin/admin_Dx23.html` → 200，功能正常。
3. `curl -I https://app-auth.gudq.com/admin_Dx23.html`（旧地址）→ 301/307 到新地址（若加 redirect）。
4. `GET /api/admin/health?section=me` 未登录仍 401（函数层保护不变）。
5. 前端页面 JS 资源（`../js/lucide.min.js`）正常加载，无 404。

## 七、不在本次范围
- `/api/admin/*` 物理搬迁（Vercel 路由限制，已说明不搬）。
- `dash4.html` 之外的其它后台子页面（如无）暂不纳入。
- `next` 回跳参数（保持简单，列为后续可选增强）。
