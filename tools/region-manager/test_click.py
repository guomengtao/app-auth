"""Simple test: does tkinter receive events on overrideredirect windows?"""
import tkinter as tk

def on_click(event):
    print(f"CLICK received at ({event.x}, {event.y})", flush=True)
    event.widget.configure(bg="#0000FF")

root = tk.Tk()
root.withdraw()

# Test 1: regular window
win1 = tk.Toplevel(root)
win1.title("REGULAR - click me")
win1.attributes("-topmost", True)
win1.geometry("300x150+100+200")
win1.configure(bg="#00AA00")
win1.bind("<Button-1>", on_click)
tk.Label(win1, text="REGULAR WINDOW\nClick me!", font=("Helvetica", 16),
         bg="#00AA00", fg="white").pack(expand=True)

# Test 2: overrideredirect
win2 = tk.Toplevel(root)
win2.overrideredirect(True)
win2.attributes("-topmost", True)
win2.geometry("300x150+100+400")
win2.configure(bg="#AA0000")
win2.bind("<Button-1>", on_click)
tk.Label(win2, text="OVERRIDEREDIRECT\nClick me!", font=("Helvetica", 16),
         bg="#AA0000", fg="white").pack(expand=True)

print("Two windows opened: GREEN=regular, RED=overrideredirect")
print("Click each window. Watch for 'CLICK received' messages.")
print("Close windows to exit.", flush=True)
root.mainloop()