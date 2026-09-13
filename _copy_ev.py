import shutil
src = "/Users/Banner/Documents/guomengtao/app-auth/tools/ev-notifier/ev_notifier.py"
dst = "/Users/Banner/Desktop/EvNotifier.app/ev_notifier.py"
try:
    shutil.copy2(src, dst)
    print("COPY OK")
except Exception as e:
    print(f"COPY FAIL: {e}")