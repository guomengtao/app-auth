# Resend 邮件服务配置

## 一、概述

使用 Resend 作为邮件发送服务，替代原有的 QQ SMTP。域名 `ev.mail.gudq.com` 已通过 Resend 验证，可直接使用。

## 二、环境变量

在 `.env` 文件或 Vercel 环境变量中添加：

| 变量名 | 值 | 说明 |
|:---|:---|:---|
| `RESEND_API_KEY` | `re_xxx...` | Resend API 密钥 |
| `RESEND_FROM` | `系统告警 <notify@ev.mail.gudq.com>` | 发件人地址，域名必须已验证 |

**注意：密钥不能提交到 GitHub，必须放在 `.env` 或 Vercel 环境变量中。** `.env` 文件已在 `.gitignore` 中排除。

## 三、发件地址规则

- 域名 `ev.mail.gudq.com` 已验证通过
- 任意前缀的邮箱均可直接使用，无需提前创建：`notify@ev.mail.gudq.com`、`alert@ev.mail.gudq.com` 等
- 发件人格式：`系统告警 <notify@ev.mail.gudq.com>`

## 四、连通性测试

### curl 测试命令

```bash
curl -X POST https://api.resend.com/emails \
-H "Authorization: Bearer $RESEND_API_KEY" \
-H "Content-Type: application/json" \
-d '{
  "from":"系统告警 <notify@ev.mail.gudq.com>",
  "to":["guomengtao@gmail.com"],
  "subject":"Resend连通性测试",
  "text":"测试邮件，如果收到代表服务完全正常"
}'
```

### 测试结果

```
返回: {"id":"900de180-a3bd-4b99-82f3-f9fd0ff0b880"}
```

`id` 返回代表提交成功，邮件已发送。

## 五、Vercel Edge Runtime 代码示例

```typescript
// app/api/send-alert/route.ts
import { Resend } from "resend";
export const runtime = "edge";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST() {
  const { error } = await resend.emails.send({
    from: "系统告警 <notify@ev.mail.gudq.com>",
    to: ["接收邮箱@xxx.com"],
    subject: "Ev课程表系统通知",
    text: "通知内容"
  });
  if (error) return Response.json({ error }, { status: 500 });
  return Response.json({ ok: true });
}
```

## 六、免费额度

| 限制项 | 额度 |
|:---|:---|
| 每日上限 | 100 封 |
| 每月上限 | 3000 封 |
| 区域 | ap-northeast-1（东京） |

对于 1-2 人的告警通知完全够用。

## 七、发送日志查看

Resend 后台左侧菜单 `Logs` 可查看：
- 发送成功记录
- 退信记录
- 拒收记录
- 垃圾箱原因

## 八、安全提醒

1. 密钥绝对不能提交到代码仓库
2. 密钥不能公开分享
3. 网盘备份密钥时注意不要公开分享文件
4. 密钥泄露会被别人刷邮件消耗额度
5. 如收到垃圾箱，可后续配置 DMARC 记录提升送达率