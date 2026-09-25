#!/usr/bin/env python3
"""ev_notifier.py 静态 lint（巨型单文件专用）。

检查两类 py_compile 查不出、但线上会静默出错的问题：

1. **被丢弃的字符串字面量**：多行字符串拼接没加括号时，只有第一行进了赋值，
   后面几行变成被静默丢弃的表达式语句。
   真实案例：消息页的「没有未读消息」空态 HTML 曾经整段消失，面板看起来就是坏的。

2. **函数内赋值遮蔽模块级全局**（没写 `global`）：
   - 先读后写 → `UnboundLocalError`（`_flush_receipts` 踩过）
   - 只写不读 → 全局变量永远不生效（`_get_client_id` 踩过）

运行: python3 tools/ev-notifier/tests/test_static_lint.py
"""
import ast
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import Checker  # noqa: E402

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ev_notifier.py")


def find_dropped_strings(tree):
    """返回 [(lineno, 片段)]：不是 docstring 的裸字符串表达式语句。"""
    doc_ids = set()
    for n in ast.walk(tree):
        if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            b0 = n.body[0] if n.body else None
            if isinstance(b0, ast.Expr) and isinstance(b0.value, ast.Constant) \
                    and isinstance(b0.value.value, str):
                doc_ids.add(id(b0))
    out = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant) \
                and isinstance(n.value.value, str) and id(n) not in doc_ids:
            out.append((n.lineno, n.value.value[:70]))
    return out


def module_level_names(tree):
    names = set()
    for n in tree.body:
        if isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Name):
                    names.add(t.id)
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
            names.add(n.target.id)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(n.name)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                names.add((a.asname or a.name).split(".")[0])
    return names


def find_global_shadowing(tree, mod_names):
    """返回 [(lineno, 函数名, 变量名)]：函数内给模块级名字赋值却没声明 global。"""
    hits = []

    def scan(fn):
        declared, assigned = set(), {}
        for sub in ast.walk(fn):
            if isinstance(sub, ast.Global):
                declared.update(sub.names)
            if isinstance(sub, ast.Assign):
                for t in sub.targets:
                    if isinstance(t, ast.Name) and isinstance(t.ctx, ast.Store):
                        assigned.setdefault(t.id, sub.lineno)
            elif isinstance(sub, (ast.AugAssign, ast.AnnAssign)) and isinstance(sub.target, ast.Name):
                assigned.setdefault(sub.target.id, sub.lineno)
            elif isinstance(sub, ast.For) and isinstance(sub.target, ast.Name):
                assigned.setdefault(sub.target.id, sub.lineno)
            elif isinstance(sub, ast.NamedExpr) and isinstance(sub.target, ast.Name):
                assigned.setdefault(sub.target.id, sub.lineno)
        for name, ln in assigned.items():
            if name in mod_names and name not in declared:
                hits.append((ln, fn.name, name))

    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            scan(n)
    return sorted(hits)


c = Checker()

# ── 自检：lint 本身必须能抓到这两类问题 ──────────────────────────
FIXTURE = '''
STATE = []
def a():
    body = 'line1'
    'line2'
    'line3'
    return body
def b():
    items = list(STATE)
    STATE = []
    return items
def c():
    STATE.append(1)
'''
ftree = ast.parse(FIXTURE)
c.check("自检：能检出被丢弃的字符串", len(find_dropped_strings(ftree)) == 2,
        find_dropped_strings(ftree))
hits = find_global_shadowing(ftree, module_level_names(ftree))
c.check("自检：能检出未声明 global 的赋值", any(n == "STATE" and f == "b" for _, f, n in hits), hits)
c.check("自检：只读取不赋值不算问题（c 函数）", not any(f == "c" for _, f, _ in hits), hits)

# ── 真实文件必须干净 ──────────────────────────────────────────────
tree = ast.parse(open(TARGET, encoding="utf-8").read())
dropped = find_dropped_strings(tree)
c.check("ev_notifier.py 无被丢弃的字符串字面量", not dropped, dropped[:5])

shadow = find_global_shadowing(tree, module_level_names(tree))
c.check("ev_notifier.py 无未声明 global 的全局赋值", not shadow, shadow[:5])

sys.exit(c.done())
