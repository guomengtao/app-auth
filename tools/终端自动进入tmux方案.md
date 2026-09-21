# Terminal Auto-Enter tmux Solution

> Goal: When a terminal window opens, it automatically enters tmux mode and displays a prompt: "Already in tmux mode, preventing terminal conflicts."
> This isolates terminal sessions, prevents crashes from interfering with each other, and improves stability.

---

## 1. Core Principle

Add a detection script to the shell startup file (`~/.zshrc`). When a new terminal window opens:

1. Check if the current shell is already inside tmux
2. If **not** in tmux → auto-attach to an existing session or create a new one
3. If **already** in tmux → display a prompt, then proceed normally

```
Terminal opens
     │
     ▼
  ~/.zshrc
     │
     ├── Already in tmux? ──Yes──► echo "Already in tmux mode..." → continue
     │
     └── Not in tmux? ──────────► tmux attach || tmux new
```

---

## 2. Shell Configuration

Add the following to `~/.zshrc`:

```bash
# ===== Auto-enter tmux on terminal open =====
if command -v tmux &> /dev/null; then
    if [ -z "$TMUX" ]; then
        # Not inside tmux — try to attach to an existing session,
        # if none exists, create a new one
        tmux attach-session -t default 2>/dev/null || tmux new-session -s default
    else
        # Already inside tmux — show a brief tip
        echo ""
        echo "  ✅ Already in tmux mode — preventing terminal conflicts"
        echo ""
    fi
fi
```

### Explanation

| Line | What it does |
|------|-------------|
| `command -v tmux` | Checks if tmux is installed |
| `[ -z "$TMUX" ]` | `$TMUX` is set by tmux internally; empty = not inside tmux |
| `tmux attach-session -t default` | Try to reconnect to a session named "default" |
| `2>/dev/null` | Suppress error if session "default" does not exist |
| `|| tmux new-session -s default` | If attach fails, create a new "default" session |
| `echo "..."` | Prompt displayed when already inside tmux |

---

## 3. Install tmux (if not already)

```bash
brew install tmux
```

Verify installation:

```bash
tmux -V
# Expected output: tmux 3.x or later
```

---

## 4. Recommended tmux Configuration

Create or append to `~/.tmux.conf`:

```bash
# ===== tmux configuration =====

# Use Ctrl+A as prefix (more ergonomic than default Ctrl+B)
set -g prefix C-a
unbind C-b
bind C-a send-prefix

# Mouse support (scroll, select pane, resize)
set -g mouse on

# History buffer: 10000 lines
set -g history-limit 10000

# Start window/pane numbering from 1
set -g base-index 1
setw -g pane-base-index 1

# Faster escape-sequence processing
set -sg escape-time 0

# Vi-style copy mode
setw -g mode-keys vi

# Status bar
set -g status-left '#[fg=green]#S '
set -g status-right '#[fg=yellow]#H  %Y-%m-%d %H:%M'
set -g status-interval 5

# Split panes more intuitively
bind \\ split-window -h -c '#{pane_current_path}'
bind -  split-window -v -c '#{pane_current_path}'

# Reload config
bind r source-file ~/.tmux.conf \; display "Config reloaded!"
```

Reload after editing:

```bash
tmux source-file ~/.tmux.conf
```

---

## 5. Usage Workflow

### 5.1 Day-to-day

```
Open iTerm2 / Terminal.app
       │
       ▼
   Auto-enters tmux "default" session
       │
       ├── Ctrl+A C     → New window
       ├── Ctrl+A ,     → Rename window
       ├── Ctrl+A -     → Split vertical
       ├── Ctrl+A \     → Split horizontal
       ├── Ctrl+A 1..9  → Switch to window N
       ├── Ctrl+A D     → Detach (leave session running)
       └── Ctrl+A [     → Scroll mode (use arrow keys, q to quit)
```

### 5.2 Crash Recovery

If a terminal window crashes or accidentally closes:

```bash
# Open a new terminal — it will auto-reconnect
# All windows and panes are preserved

# Or manually list and reattach:
tmux ls
tmux attach -t default
```

### 5.3 Multiple Named Sessions

```bash
tmux new -s dev      # Development
tmux new -s build    # Build / CI
tmux new -s monitor  # Monitoring

# Quick switch:
tmux attach -t dev
```

---

## 6. How to Temporarily Skip tmux

If you need a plain shell (e.g., for testing), pass a flag:

```bash
# In ~/.zshrc, modify the condition:
if [ -z "$TMUX" ] && [ -z "$SKIP_TMUX" ]; then
    tmux attach-session -t default 2>/dev/null || tmux new-session -s default
fi

# Then open terminal with:
SKIP_TMUX=1 zsh
# or
export SKIP_TMUX=1 && exec zsh
```

---

## 7. Why This Matters

| Problem | Without tmux | With tmux |
|---------|-------------|-----------|
| **Terminal crashes** | All running commands are lost | Session persists, just reattach |
| **Multiple windows** | Need many terminal tabs, hard to manage | Named windows inside one session |
| **Long-running tasks** | Keep terminal open or use nohup | Detach and come back anytime |
| **IDE + external terminal** | Separate, not coordinated | All share tmux sessions |
| **Accidental close** | Cmd+W kills everything | Session survives in background |

---

## 8. Full One-Command Setup

Copy and paste this to set up everything at once:

```bash
# Install tmux
brew install tmux

# Add auto-enter tmux to ~/.zshrc
cat >> ~/.zshrc << 'ZSHRC_EOF'

# ===== Auto-enter tmux on terminal open =====
if command -v tmux &> /dev/null; then
    if [ -z "$TMUX" ]; then
        tmux attach-session -t default 2>/dev/null || tmux new-session -s default
    else
        echo ""
        echo "  ✅ Already in tmux mode — preventing terminal conflicts"
        echo ""
    fi
fi
ZSHRC_EOF

# Write tmux config
cat > ~/.tmux.conf << 'TMUX_EOF'
set -g prefix C-a
unbind C-b
bind C-a send-prefix
set -g mouse on
set -g history-limit 10000
set -g base-index 1
setw -g pane-base-index 1
set -sg escape-time 0
setw -g mode-keys vi
set -g status-left '#[fg=green]#S '
set -g status-right '#[fg=yellow]#H  %Y-%m-%d %H:%M'
set -g status-interval 5
bind \\ split-window -h -c '#{pane_current_path}'
bind -  split-window -v -c '#{pane_current_path}'
bind r source-file ~/.tmux.conf \; display "Config reloaded!"
TMUX_EOF

echo "✅ tmux auto-enter setup complete. Open a new terminal to test."
```

---

## 9. FAQ

### Q: What if I already have multiple terminal windows open?

Each new terminal window will try to `tmux attach -t default`. tmux supports multiple clients attaching to the same session — all windows see the same content. Use `tmux new -s <name>` for independent sessions.

### Q: How do I quit tmux entirely?

```bash
# Inside tmux, close all windows:
Ctrl+A &   # Close current window (repeat for all windows)
# Or force-kill the session:
tmux kill-session -t default
```

### Q: Does this work with Trae / VSCode built-in terminal?

Yes — when you open the IDE's built-in terminal, it will also auto-enter tmux. If you prefer not to, use the `SKIP_TMUX` flag or configure the IDE to launch with `SKIP_TMUX=1`.

### Q: Can I still use `Cmd+T` to open new tabs in iTerm2?

Yes — but each new tab will re-attach to the same tmux session. For independent terminals, create different tmux sessions.