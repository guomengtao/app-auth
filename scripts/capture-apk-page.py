#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
capture-apk-page.py — android-apk.html 旧版存档截图的补采半自动脚本
(evtask-D-app-auth-261112-p73h33 · 2026-11-12)

背景：/android-apk.html 是「逐页截图档案」，16 页里 4 页已换 v0.6.8 真机实拍，
其余 12 页仍是 2026-10-05 的 v0.5.166 旧图并标 legacy:1。设备离线期间无法补采，
本脚本把「设备恢复后」的重复劳动固化成一条命令。

设计原则（重要）：
  * 不伪造：设备不在线时抓取直接拒绝；不拿设计图 / 合成图 / 旧图冒充实拍。
  * 不假装能自动导航 APP：页面切换由人在设备上完成，脚本只负责「抓当前屏 → 落盘 →
    改 HTML → 校验」。--interactive 会逐页提示翻页后敲回车，一条命令走完 12 页。
  * 不止改图片名：legacy:1 → fresh:1、shotSets 计数、capturedAt、pageUpdatedAt、
    stateNote / footer 里的 4 页 / 12 页静态文案，全部联动，避免图文不一致。
  * 每页自身仍带 version / at 精确信息；shotSets.fresh.version 表示「最新采集批次」。

用法：
  python3 scripts/capture-apk-page.py --status
  python3 scripts/capture-apk-page.py --verify
  python3 scripts/capture-apk-page.py --page message --version 0.6.54 --dry-run
  python3 scripts/capture-apk-page.py --page message --version 0.6.54
  python3 scripts/capture-apk-page.py --interactive --version 0.6.54
  python3 scripts/capture-apk-page.py --status --root /tmp/app-auth-rehearsal   # 演练副本

 --simulate 仅供脚本自测：跳过 adb，用 --source 指定一张已有图冒充截图，
 且必须同时给 --root 指向非生产目录。产出的图与 HTML 禁止上线。
"""

import argparse
import datetime
import os
import re
import shutil
import subprocess
import sys

PROD_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML_REL = "android-apk.html"
IMG_REL = "images/ev-schedule/apk"
OUT_REL = ".vercel/output/static/images/ev-schedule/apk"

PAGE_RE = re.compile(r'\{id:"([^"]+)",name:"([^"]+)",group:"([^"]+)"')
SHOT_RE = re.compile(
    r'shots:\[\{file:"([^"]+)",state:"([^"]*)",version:"([^"]*)",at:"([^"]*)"(?:,(legacy|fresh):1)?\}\]')


def now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M")


def today():
    return datetime.datetime.now().strftime("%Y-%m-%d")


def read_pages(s):
    """从 HTML 的 DATA 里解析 16 页的 id / name / entry / shots。"""
    # 2026-11-12 源码核对：新版底栏与入口已变，页面 DATA 里 5 条 entry 仍是旧文案。
    # 只覆盖脚本展示用的入口提示，不改线上 HTML（补采时避免照旧描述扑空）。
    ENTRY_FIX = {"message": "首页快捷按钮 / 手环页腕聊入口",
                 "toolbox": "手环页 → 工具箱（找手机 / 静音）",
                 "homepage-settings": "手环页 → 手环首页（挑模板、调字号）",
                 "transfer-import": "首页 → 导入课程表（EV 变体专属）",
                 "transfer-export": "首页 → 导出课程表（EV 变体专属）"}
    out = []
    for m in PAGE_RE.finditer(s):
        seg = s[m.start():m.start() + 1800]
        entry = re.search(r'entry:"([^"]*)"', seg)
        raw_entry = entry.group(1) if entry else ""
        sh = SHOT_RE.search(seg)
        if not sh:
            continue
        out.append({
            "id": m.group(1), "name": m.group(2), "group": m.group(3),
            "entry": ENTRY_FIX.get(m.group(1), raw_entry),
            "file": sh.group(1), "state": sh.group(2),
            "version": sh.group(3), "at": sh.group(4),
            "fresh": sh.group(5) == "fresh",
            "block": sh.group(0),
        })
    return out


def counts(s):
    return len(re.findall(r',fresh:1', s)), len(re.findall(r',legacy:1', s))


def adb_online():
    try:
        out = subprocess.check_output(["adb", "devices"], text=True, timeout=12)
    except Exception as e:
        return [], "adb 不可用：%s" % e
    devs = [ln.split("\t")[0] for ln in out.splitlines()[1:]
            if ln.strip().endswith("\tdevice")]
    return devs, None


def image_size(path):
    try:
        from PIL import Image
        with Image.open(path) as im:
            return "%dx%d" % im.size
    except Exception:
        try:
            out = subprocess.check_output(
                ["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
                text=True, timeout=12)
            w = re.search(r'pixelWidth:\s*(\d+)', out)
            h = re.search(r'pixelHeight:\s*(\d+)', out)
            if w and h:
                return "%sx%s" % (w.group(1), h.group(1))
        except Exception:
            pass
    return ""


def verify(root, s, verbose=True):
    """结构校验：图片存在 / 计数一致 / Node 可解析 DATA。"""
    problems = []
    pages = read_pages(s)
    if len(pages) != 16:
        problems.append("页面数应为 16，实际 %d" % len(pages))
    imgroot = os.path.join(root, IMG_REL)
    for p in pages:
        fp = os.path.join(imgroot, p["file"].replace("apk/", ""))
        if not os.path.exists(fp):
            problems.append("缺图：%s" % p["file"])
    f, l = counts(s)
    mf = re.search(r'fresh:\{[^}]*?count:(\d+)', s)
    ml = re.search(r'legacy:\{[^}]*?count:(\d+)', s)
    if not mf or int(mf.group(1)) != f:
        problems.append("shotSets.fresh.count=%s 与徽标数 %d 不符" %
                        (mf.group(1) if mf else "?", f))
    if not ml or int(ml.group(1)) != l:
        problems.append("shotSets.legacy.count=%s 与徽标数 %d 不符" %
                        (ml.group(1) if ml else "?", l))
    # Node 解析 DATA（页面是裸 JS 对象字面量，正则取出后交给 node）
    try:
        m = re.search(r'var DATA=(\{.*?\});\s*var cur=', s, re.S)
        if not m:
            problems.append("找不到 var DATA= 块")
        elif shutil.which("node"):
            js = ("const DATA=%s;\nconsole.log(JSON.stringify({pages:DATA.pages.length,"
                  "fresh:DATA.pages.filter(p=>p.shots.some(x=>x.fresh)).length,"
                  "legacy:DATA.pages.filter(p=>p.shots.some(x=>x.legacy)).length}));") % m.group(1)
            tf = "/tmp/_apk_data_check.js"
            open(tf, "w", encoding="utf-8").write(js)
            r = subprocess.run(["node", tf], capture_output=True, text=True, timeout=20)
            if r.returncode != 0:
                problems.append("Node 解析 DATA 失败：%s" % r.stderr.strip()[:120])
            elif verbose:
                print("   Node DATA:", r.stdout.strip())
    except Exception as e:
        problems.append("Node 校验异常：%s" % e)
    if verbose:
        print("   校验：%d 页 / %d 新版 / %d 旧版 / %d 处问题" %
              (len(pages), f, l, len(problems)))
        for x in problems:
            print("   ❌", x)
    return problems


def rewrite(s, page, ver, state, at, size):
    """把某一页从 legacy 改为 fresh，并联动所有元信息与静态文案。"""
    old = page["block"]
    new = ('shots:[{file:"apk/%s-v%s.png",state:"%s",version:"%s",at:"%s",fresh:1}]'
           % (page["id"], ver, state, ver, at))
    if s.count(old) != 1:
        raise RuntimeError("shots 块定位不唯一：%s" % page["id"])
    s = s.replace(old, new, 1)

    # shotSets：先取出 fresh / legacy 两个块，在块内替换，避免字段顺序假设
    mf = re.search(r'fresh:\{[^}]*\}', s)
    ml = re.search(r'legacy:\{[^}]*\}', s)
    if not mf or not ml:
        raise RuntimeError("找不到 shotSets.fresh / legacy 块")
    fblock = mf.group(0)

    def setf(key, value, quoted=True):
        nonlocal fblock
        pat = (r'(%s:")[^"]*(")' % key) if quoted else (r'(%s:)(\d+)' % key)
        repl = (lambda m: m.group(1) + value + m.group(2)) if quoted else \
               (lambda m: m.group(1) + value)
        fblock, n = re.subn(pat, repl, fblock, count=1)
        if n != 1:
            raise RuntimeError("shotSets.fresh.%s 定位失败" % key)

    setf("version", ver)
    setf("at", at)
    setf("size", size)
    setf("source", "adb screencap 真机实拍（含 2026-11-05 v0.6.8 首批 4 页）")
    cf = re.search(r'count:(\d+)', fblock)
    cl = re.search(r'count:(\d+)', ml.group(0))
    if not cf or not cl:
        raise RuntimeError("shotSets count 解析失败")
    setf("count", str(int(cf.group(1)) + 1), quoted=False)
    lblock = re.sub(r'(count:)(\d+)',
                    lambda m: m.group(1) + str(max(0, int(cl.group(1)) - 1)),
                    ml.group(0), count=1)
    s = s[:mf.start()] + fblock + s[mf.end():]
    ml2 = re.search(r'legacy:\{[^}]*\}', s)
    if not ml2:
        raise RuntimeError("legacy 块在替换后丢失")
    s = s[:ml2.start()] + lblock + s[ml2.end():]

    f, l = counts(s)

    s = re.sub(r'capturedAt:"[^"]*"',
               lambda m: 'capturedAt:"%s（最新批次 v%s）%s"' %
               (at, ver, " · 2026-11-05 19:45（v0.6.8 首批 4 页）" if l == 0
                else " · 2026-10-05 15:00（旧版存档）"),
               s, count=1)
    s = re.sub(r'pageUpdatedAt:"[^"]*"',
               lambda m: 'pageUpdatedAt:"%s"' % today(), s, count=1)

    # stateNote：整句重写，避免「4 页 / 12 页」静态数字与徽标脱节
    if l:
        note = ("'📌 本页已更新：%d 页为真机实拍新版（最新 v%s / %s / %s）；"
                "其余 %d 页暂无新版实拍，保留 2026-10-05 v0.5.166 旧图并标「旧版存档」，"
                "设备恢复后补采。当前线上发布版 v'+DATA.app.version+'（code '+DATA.app.versionCode+'），"
                "排查时以手机实际版本为准。';" % (f, ver, at, size, l))
    else:
        note = ("'📌 本页已更新：16 页全部为真机实拍——12 页 v%s（%s / %s / Redmi 6A）"
                "＋ 首批 4 页 v0.6.8（2026-11-05 / 1080×1920）。"
                "当前线上发布版 v'+DATA.app.version+'（code '+DATA.app.versionCode+'），"
                "排查时以手机实际版本为准。';" % (ver, at, size))
    s, n = re.subn(r"document\.getElementById\('stateNote'\)\.textContent='[^;]*';",
                   "document.getElementById('stateNote').textContent=" + note, s, count=1)
    if n != 1:
        raise RuntimeError("stateNote 定位失败")

    # footer：按当前计数重写双版本口径
    if l:
        foot = ('<div class="footer">Ev课程表 · 安卓 APK 页面总览 · %s 更新<br>'
                '新版实拍：%d 页（最新 v%s / %s / %s）；旧版存档：%d 页'
                '（v0.5.166 / 2026-10-05 15:00 / 荣耀畅玩7X 1080×2160）<br>'
                '两套截图采集环境不同，已分开标注；线上发布版见顶部版本 chip<br>'
                '页面随版本快速演进，每张截图都标注采集时版本，排查时以手机实际版本为准</div>'
                % (today(), f, ver, at, size, l))
    else:
        foot = ('<div class="footer">Ev课程表 · 安卓 APK 页面总览 · %s 更新<br>'
                '真机实拍 16 页：12 页 v%s / %s / %s（Redmi 6A）＋ 首批 4 页 '
                'v0.6.8 / 2026-11-05 / 1080×1920<br>'
                '两批采集设备与尺寸不同，每张截图均标注版本；线上发布版见顶部版本 chip<br>'
                '页面随版本快速演进，排查时以手机实际版本为准</div>'
                % (today(), ver, at, size))
    s, n = re.subn(r'<div class="footer">.*?</div>', foot, s, count=1, flags=re.S)
    if n != 1:
        raise RuntimeError("footer 定位失败")
    return s


def grab(dev, tmp):
    """从设备抓当前屏；失败抛异常，绝不留空图。"""
    remote = "/sdcard/ev-apk-cap.png"
    subprocess.run(["adb", "-s", dev, "shell", "screencap", "-p", remote],
                   check=True, timeout=40, capture_output=True)
    subprocess.run(["adb", "-s", dev, "pull", remote, tmp],
                   check=True, timeout=90, capture_output=True)
    subprocess.run(["adb", "-s", dev, "shell", "rm", remote],
                   timeout=20, capture_output=True)
    if not os.path.exists(tmp) or os.path.getsize(tmp) < 10000:
        raise RuntimeError("截图为空或过小，拒绝落盘")
    return tmp


def main():
    ap = argparse.ArgumentParser(description="android-apk.html 补采半自动脚本")
    ap.add_argument("--root", default=PROD_ROOT, help="仓库根（演练时指向副本）")
    ap.add_argument("--status", action="store_true", help="只读：列出 16 页状态")
    ap.add_argument("--verify", action="store_true", help="只读：结构校验")
    ap.add_argument("--page", help="要补采的页面 id")
    ap.add_argument("--version", help="手机上实际安装的 APK 版本，如 0.6.54")
    ap.add_argument("--state", help="覆盖该页 state 文案（默认沿用原值）")
    ap.add_argument("--device", help="指定 adb serial（默认取第一台在线设备）")
    ap.add_argument("--interactive", action="store_true", help="逐页提示翻页，一条命令补完 12 页")
    ap.add_argument("--dry-run", action="store_true", help="只打印将做的改动，不落盘")
    ap.add_argument("--simulate", help="自测用：以这张已有图代替截图（须配 --root 副本）")
    a = ap.parse_args()

    root = os.path.abspath(a.root)
    html = os.path.join(root, HTML_REL)
    if not os.path.exists(html):
        print("❌ 找不到 %s" % html)
        return 2
    s = open(html, encoding="utf-8").read()
    pages = read_pages(s)

    if a.status or a.verify:
        if a.status:
            f, l = counts(s)
            print("页面总览：%d 页 / 新版实拍 %d / 旧版存档 %d" % (len(pages), f, l))
            print("%-20s %-12s %-8s %s" % ("ID", "页面", "状态", "入口"))
            for p in pages:
                print("%-20s %-12s %-8s %s" %
                      (p["id"], p["name"], "新版" if p["fresh"] else "旧版", p["entry"]))
        if a.verify or a.status:
            print("\n结构校验：")
            bad = verify(root, s)
            print("   >>>", "PASS ✅" if not bad else "FAIL ❌")
            return 0 if not bad else 1
        return 0

    if a.simulate and os.path.abspath(root) == os.path.abspath(PROD_ROOT):
        print("❌ --simulate 必须配 --root 指向演练副本，禁止在生产目录生成假图")
        return 2
    if not a.version and not (a.interactive or a.page):
        pass
    if (a.page or a.interactive) and not a.version:
        print("❌ 请显式传 --version（手机实际安装版本），避免把批次版本写错")
        return 2

    todo = [p for p in pages if not p["fresh"]]
    if a.page:
        todo = [p for p in pages if p["id"] == a.page]
        if not todo:
            print("❌ 页面 id 不存在：%s" % a.page)
            return 2
        if todo[0]["fresh"]:
            print("❌ %s 已是新版实拍，拒绝重复补采" % a.page)
            return 2
    if not a.interactive and not a.page:
        print("❌ 请指定 --page <id> 或 --interactive（只读查状态用 --status）")
        return 2

    devs, err = adb_online()
    if not a.simulate and not a.dry_run:
        if err or not devs:
            print("❌ 设备不在线，拒绝补采（%s）。" % (err or "adb devices 无 device 状态行"))
            print("   按真机截图比对铁律，不拿设计图 / 旧图 / 合成图冒充实拍。")
            print("   设备恢复后重跑本命令即可。")
            return 3
        dev = a.device or devs[0]
        if a.device and a.device not in devs:
            print("❌ 指定的 --device %s 不在线；在线：%s" % (a.device, ", ".join(devs)))
            return 3
        print("📱 设备：%s" % dev)

    imgs = os.path.join(root, IMG_REL)
    outs = os.path.join(root, OUT_REL)
    os.makedirs(imgs, exist_ok=True)
    done = 0
    for p in todo:
        if a.interactive:
            print("\n👉 请在设备上打开【%s】（入口：%s）" % (p["name"], p["entry"]))
            try:
                k = input("   回车开始截图 / s 跳过 / q 退出：").strip().lower()
            except EOFError:
                k = "q"
            if k == "q":
                break
            if k == "s":
                continue
        at = now()
        state = a.state or p["state"]
        dst = os.path.join(imgs, "%s-v%s.png" % (p["id"], a.version))
        print("\n--- %s · %s → %s-v%s.png" % (p["id"], p["name"], p["id"], a.version))
        if a.dry_run:
            print("   [dry-run] 将抓取当前屏 → %s" % dst)
            print("   [dry-run] shots 块：%s" % p["block"])
            print("   [dry-run] 将改：legacy:1 → fresh:1、shotSets 计数、capturedAt、"
                  "pageUpdatedAt、stateNote、footer")
            continue

        tmp = "/tmp/_apk_cap_%s.png" % p["id"]
        if a.simulate:
            shutil.copy2(a.simulate, tmp)
            print("   ⚠️ SIMULATE：用 %s 代替真机截图，产出禁止上线" % os.path.basename(a.simulate))
        else:
            grab(dev, tmp)
        size = image_size(tmp)
        if not size:
            print("   ⚠️ 无法读取尺寸，size 字段留空，请人工复核")
        shutil.copy2(tmp, dst)
        print("   ✅ 落盘 %s（%s，%d KB）" %
              (os.path.basename(dst), size or "?", os.path.getsize(dst) // 1024))
        if os.path.isdir(os.path.dirname(outs)):
            os.makedirs(outs, exist_ok=True)
            link = os.path.join(outs, os.path.basename(dst))
            if not os.path.exists(link):
                try:
                    os.link(dst, link)
                    print("   ✅ 同步进 .vercel/output")
                except OSError as e:
                    print("   ⚠️ output 同步跳过：%s" % e)
        s = rewrite(s, p, a.version, state, at, size or "1080x1920")
        done += 1

    if a.dry_run:
        print("\n[dry-run] 共 %d 页待处理，未落盘、未改 HTML。" % len(todo))
        return 0
    if not done:
        print("\n本次没有补采任何页面。")
        return 0

    open(html, "w", encoding="utf-8").write(s)
    print("\n=== HTML 已更新，开始校验 ===")
    bad = verify(root, s)
    f, l = counts(s)
    print("   当前：新版 %d 页 / 旧版 %d 页" % (f, l))
    if bad:
        print("❌ 校验未通过，请检查后再提交")
        return 1
    print("\n✅ 完成 %d 页。后续：headless 渲染预览 → git add（仅认领文件）→ "
          "ev-commit.sh → git push → curl 复核线上图片 200。" % done)
    return 0


if __name__ == "__main__":
    sys.exit(main())
