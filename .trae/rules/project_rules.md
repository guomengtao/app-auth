# Project Rules

> Consolidated from all `.trae/rules/*.md` and user_rules.
> Last updated: 2026-09-17

---

## 1. Versioning

- **Format**: `x.y.z`, each release increments by +1
- **Where**: `package.json` → `version` field
- Always update version before publishing

## 2. Git

- Every change → `git push` to remote
- Commit messages in English

## 3. Terminal

- **Must use tmux** for all terminal operations (avoid interference)
- **Keep only one terminal open at a time**; close old ones with `tmux kill-session` before opening new ones
- High-risk commands (`pkill`, `rm`, delete, etc.) → run directly, no confirmation prompt needed

## 4. Notifications (macOS Dialog)

- **All operations** (file delete, command execution, etc.) → must use `osascript -e 'display dialog'`
- Do NOT notify inside conversation text (user switches tabs and can't see)
- **Generic prompt** (standardized):
  ```bash
  res=$(osascript -e 'display dialog "操作已完成，是否需要继续？" buttons {"取消","继续"} default button "继续" with icon caution')
  if [[ $res == *"继续"* ]]; then
    echo "User chose continue"
  else
    echo "User cancelled"
  fi
  ```
- Show dialog at **start and end** of each conversation turn

## 5. Code Standards

- All code written in **USA English**; no Chinese in code
- Markdown documents (`.md`) → written in **Chinese**
- Page development: **capsule/band screen first**, square screen second
- Vercel: **Serverless Functions ≤ 10**; if exceeded, merge into existing ones

## 6. QA Management

- **REPLY.md** located at project root (`/REPLY.md`)
- Update daily with 3 categories:
  - ✅ Fixed
  - 🔄 In Progress
  - ⏳ Pending

## 7. Database

- Product detail pages can connect to online DB as needed (no restriction)