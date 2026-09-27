#!/opt/homebrew/opt/python@3.14/bin/python3.14
"""Speak text with Microsoft Edge TTS (default voice: Xiaoxiao) - dev-machine voice notifier.

Implements the IDE-side notification convention documented in
mac-notification-scheme.md:

    osascript -e 'display notification "..." with title "..."' ; say-edge.py "..."

Edge TTS is free, needs no account and no API key, and sounds close to a real
person. When it is unavailable (package missing, network down, synthesis
timeout, playback failure) this script silently falls back to the built-in
macOS `say` command, so the alert never goes quiet.

Usage:
    say-edge.py "text to speak"
    say-edge.py --voice zh-CN-YunxiNeural "switch to a male voice"
    say-edge.py --rate +20% "speak faster"
    say-edge.py --fallback-only "skip Edge TTS, use macOS say only"
    say-edge.py --list-voices
"""
import argparse
import asyncio
import hashlib
import os
import subprocess
import sys

DEFAULT_VOICE = os.environ.get("EV_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
DEFAULT_RATE = os.environ.get("EV_TTS_RATE", "+0%")
SYNTH_TIMEOUT = 15          # seconds; online synthesis must not hang the caller
PLAY_TIMEOUT = 180          # seconds; long texts still play out fully
CACHE_DIR = os.path.expanduser("~/.ev_tts_cache")
CACHE_MAX = 300             # keep the newest N clips, drop older ones
SAY_VOICE_CHAIN = ["Tingting", "Sinji", "Meijia", None]  # None = system default

try:
    import edge_tts
except ImportError:
    edge_tts = None


def cache_path(text, voice, rate):
    key = hashlib.sha1((voice + "|" + rate + "|" + text).encode("utf-8")).hexdigest()
    return os.path.join(CACHE_DIR, key + ".mp3")


def trim_cache():
    """Keep the shared cache bounded so ~/.ev_tts_cache does not grow forever."""
    try:
        files = [os.path.join(CACHE_DIR, f) for f in os.listdir(CACHE_DIR)]
        files.sort(key=os.path.getmtime, reverse=True)
        for path in files[CACHE_MAX:]:
            try:
                os.remove(path)
            except OSError:
                pass
    except OSError:
        pass


async def _synth(text, voice, rate, path):
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    await asyncio.wait_for(communicate.save(path), timeout=SYNTH_TIMEOUT)


def edge_speak(text, voice, rate):
    """Synthesize (with on-disk cache) and play. True when Edge TTS spoke."""
    if edge_tts is None:
        return False
    path = cache_path(text, voice, rate)
    if not os.path.exists(path):
        tmp = path + ".part"
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            asyncio.run(_synth(text, voice, rate, tmp))
            os.replace(tmp, path)
            trim_cache()
        except Exception as e:
            print("edge-tts failed: %s" % e, file=sys.stderr)
            try:
                os.remove(tmp)
            except OSError:
                pass
            return False
    try:
        return subprocess.run(["afplay", path], timeout=PLAY_TIMEOUT).returncode == 0
    except Exception as e:
        print("afplay failed: %s" % e, file=sys.stderr)
        return False


def _say_rate(rate):
    """Map an edge-tts rate like '+20%' to `say -r` words per minute (None = default)."""
    try:
        pct = float(str(rate).strip().rstrip("%").replace("+", ""))
    except (TypeError, ValueError):
        return None
    if pct == 0:
        return None
    return str(max(80, min(400, int(round(175 * (1 + pct / 100.0))))))


def say_speak(text, rate):
    """Built-in macOS fallback: try Chinese voices, then the system default."""
    wpm = _say_rate(rate)
    for voice in SAY_VOICE_CHAIN:
        cmd = ["say"]
        if voice:
            cmd.extend(["-v", voice])
        if wpm:
            cmd.extend(["-r", wpm])
        cmd.append(text)
        try:
            if subprocess.run(cmd, timeout=PLAY_TIMEOUT).returncode == 0:
                return True
        except Exception:
            continue
    return False


def list_voices():
    if edge_tts is None:
        print("edge-tts is not installed", file=sys.stderr)
        return 1
    voices = asyncio.run(edge_tts.list_voices())
    for v in voices:
        if str(v.get("Locale", "")).startswith("zh-"):
            print("%-28s %-8s %s" % (v.get("ShortName", "?"), v.get("Gender", "?"), v.get("Locale", "?")))
    return 0


def main(argv):
    parser = argparse.ArgumentParser(
        description="Speak text with Edge TTS, fall back to the built-in macOS say command.")
    parser.add_argument("text", nargs="*", help="text to speak (multiple args are joined with spaces)")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help="Edge TTS voice (default: %(default)s)")
    parser.add_argument("--rate", default=DEFAULT_RATE,
                        help="speaking rate offset such as +20 percent (default: %(default)s)")
    parser.add_argument("--fallback-only", action="store_true", help="skip Edge TTS, use macOS say only")
    parser.add_argument("--list-voices", action="store_true", help="list Chinese Edge TTS voices and exit")
    args = parser.parse_args(argv[1:])

    if args.list_voices:
        return list_voices()

    text = " ".join(args.text).strip()
    if not text:
        parser.print_help(sys.stderr)
        return 2

    if not args.fallback_only:
        if edge_speak(text, args.voice, args.rate):
            print("spoken via edge-tts (%s)" % args.voice)
            return 0
        print("edge-tts unavailable, falling back to macOS say", file=sys.stderr)

    if say_speak(text, args.rate):
        print("spoken via macOS say (fallback)")
        return 0
    print("all voice engines failed", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
