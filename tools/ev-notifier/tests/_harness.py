"""测试脚手架：在无 GUI / 无 rumps / 无 AppKit 的环境里导入 ev_notifier。

用法:
    from _harness import load_ev
    E = load_ev(home="/tmp/xxx")

默认**离线**：不会打任何网络请求，也不会发任何回执。
需要打真实生产接口时显式 `load_ev(live=True)`（会 POST 回执，慎用）。
"""
import os
import shutil
import sys
import types


def _install_stubs():
    rumps = types.ModuleType("rumps")

    class _App:
        def __init__(self, *a, **k):
            pass

    rumps.App = _App

    def _dec(*a, **k):
        def wrap(f):
            return f
        return wrap

    rumps.clicked = _dec
    rumps.timer = _dec
    rumps.separator = None
    rumps.MenuItem = lambda *a, **k: None
    rumps.notification = lambda *a, **k: None
    rumps.alert = lambda *a, **k: None
    rumps.debug_mode = lambda *a, **k: None
    rumps.rumps = rumps
    sys.modules["rumps"] = rumps

    class _StubMod(types.ModuleType):
        def __getattr__(self, name):
            if name.startswith("__"):
                raise AttributeError(name)
            return type(name, (object,), {})

    sys.modules["Foundation"] = _StubMod("Foundation")
    sys.modules["AppKit"] = _StubMod("AppKit")
    for m in ("WebKit", "webview", "redis"):
        sys.modules[m] = None


def load_ev(home="/tmp/ev_notifier_test_home", live=False):
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home, exist_ok=True)
    os.environ["HOME"] = home
    _install_stubs()

    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    if root not in sys.path:
        sys.path.insert(0, root)

    for name in ("ev_notifier",):
        sys.modules.pop(name, None)
    import ev_notifier as E  # noqa: E402

    # 默认全部打桩：不发网络、不弹通知、不念语音
    E._delivery_callback = lambda *a, **k: None
    E.notify_macos = lambda *a, **k: None
    E.enqueue_voice = lambda *a, **k: None
    if not live:
        # 注意：sync_since 走的是 _api_get_status（要拿状态码区分 401），两个都要打桩
        E._api_get_status = lambda url, timeout=10: (0, None)
        E._api_get_json = lambda url, timeout=10: None
    return E


class Checker:
    def __init__(self):
        self.fails = []
        self.passed = 0

    def check(self, name, cond, extra=""):
        if cond:
            self.passed += 1
            print("PASS  " + name)
        else:
            self.fails.append(name)
            print("FAIL  " + name + ("  → " + str(extra) if extra != "" else ""))

    def done(self):
        print("\nPASS: %d  FAILED: %d" % (self.passed, len(self.fails)))
        return 1 if self.fails else 0
