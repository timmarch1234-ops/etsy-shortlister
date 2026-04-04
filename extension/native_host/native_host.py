#!/usr/bin/env python3
"""
Chrome Native Messaging host for Etsy Shortlister.
Receives mouse/scroll/click commands from the Chrome extension
and executes them via pyautogui — real, physical cursor movement.
"""

import json
import math
import random
import signal
import struct
import sys
import time

try:
    import pyautogui
    pyautogui.FAILSAFE = True   # Move mouse to top-left corner to abort
    pyautogui.PAUSE = 0         # We handle our own timing
except ImportError:
    # Send error and exit
    pass

# Calibration state — set by "calibrate" command
cal = {
    "screen_x": 0,
    "screen_y": 0,
    "chrome_offset_y": 0,
    "dpr": 2,
}


def to_screen(vx, vy):
    """Convert viewport CSS coordinates to screen coordinates."""
    sx = cal["screen_x"] + vx
    sy = cal["screen_y"] + cal["chrome_offset_y"] + vy
    return sx, sy


# ── Native Messaging I/O ──────────────────────────────────────

def read_message():
    """Read a length-prefixed JSON message from stdin."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    length = struct.unpack("<I", raw_length)[0]
    if length == 0:
        return None
    data = sys.stdin.buffer.read(length)
    if not data:
        return None
    return json.loads(data.decode("utf-8"))


def send_message(msg):
    """Write a length-prefixed JSON message to stdout."""
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


# ── Bezier Mouse Movement ─────────────────────────────────────

def cubic_bezier(t, p0, p1, p2, p3):
    u = 1 - t
    return u*u*u*p0 + 3*u*u*t*p1 + 3*u*t*t*p2 + t*t*t*p3


def move_bezier(from_vx, from_vy, to_vx, to_vy, steps=None):
    """
    Move the real mouse cursor along a cubic Bezier curve
    from one viewport point to another, with micro-jitter
    and variable speed (slow at start/end, fast in middle).
    """
    sx1, sy1 = to_screen(from_vx, from_vy)
    sx2, sy2 = to_screen(to_vx, to_vy)

    dist = math.sqrt((sx2 - sx1)**2 + (sy2 - sy1)**2)
    if steps is None:
        steps = max(8, min(30, int(dist / 12)))

    # Random Bezier control points for natural curve
    cp1x = sx1 + (sx2 - sx1) * 0.25 + random.uniform(-60, 60)
    cp1y = sy1 + (sy2 - sy1) * 0.25 + random.uniform(-50, 50)
    cp2x = sx1 + (sx2 - sx1) * 0.75 + random.uniform(-60, 60)
    cp2y = sy1 + (sy2 - sy1) * 0.75 + random.uniform(-50, 50)

    for i in range(steps + 1):
        t = i / steps
        # Bezier position + hand tremor jitter
        x = cubic_bezier(t, sx1, cp1x, cp2x, sx2) + random.uniform(-1.5, 1.5)
        y = cubic_bezier(t, sy1, cp1y, cp2y, sy2) + random.uniform(-1.5, 1.5)

        pyautogui.moveTo(int(x), int(y), _pause=False)

        # Variable speed: slow at edges, fast in middle (sinusoidal easing)
        delay = 0.008 + math.sin(t * math.pi) * 0.018 + random.uniform(0, 0.010)
        time.sleep(delay)


def idle_wander(vx_center, vy_center):
    """Small random mouse wander around a point (idle browsing)."""
    moves = random.randint(2, 4)
    cx, cy = vx_center, vy_center
    for _ in range(moves):
        nx = cx + random.uniform(-80, 80)
        ny = cy + random.uniform(-50, 50)
        move_bezier(cx, cy, nx, ny, steps=random.randint(6, 12))
        time.sleep(random.uniform(0.15, 0.45))
        cx, cy = nx, ny


# ── Command Handlers ──────────────────────────────────────────

def handle_calibrate(msg):
    cal["screen_x"] = msg.get("screenX", 0)
    cal["screen_y"] = msg.get("screenY", 0)
    cal["chrome_offset_y"] = msg.get("chromeOffsetY", 0)
    cal["dpr"] = msg.get("devicePixelRatio", 2)
    return {"ok": True, "action": "calibrate"}


def handle_move(msg):
    x, y = msg.get("x", 0), msg.get("y", 0)
    sx, sy = to_screen(x, y)
    pyautogui.moveTo(int(sx), int(sy), _pause=False)
    return {"ok": True, "action": "move"}


def handle_move_bezier(msg):
    move_bezier(
        msg.get("fromX", 0), msg.get("fromY", 0),
        msg.get("toX", 0), msg.get("toY", 0),
        msg.get("steps", None),
    )
    return {"ok": True, "action": "move_bezier"}


def handle_click(msg):
    x, y = msg.get("x", 0), msg.get("y", 0)
    sx, sy = to_screen(x, y)
    button = msg.get("button", "left")
    pyautogui.click(int(sx), int(sy), button=button, _pause=False)
    return {"ok": True, "action": "click"}


def handle_scroll(msg):
    x, y = msg.get("x", 0), msg.get("y", 0)
    sx, sy = to_screen(x, y)
    delta_y = msg.get("deltaY", 0)
    # macOS scroll: pyautogui scroll units are "ticks"
    # ~100 CSS pixels ≈ 1 scroll tick, negative = scroll down
    ticks = -int(round(delta_y / 100))
    if ticks == 0:
        ticks = -1 if delta_y > 0 else 1
    # Move to position first, then scroll
    pyautogui.moveTo(int(sx), int(sy), _pause=False)
    # Scroll in small increments for realism
    remaining = abs(ticks)
    direction = 1 if ticks > 0 else -1
    while remaining > 0:
        chunk = min(remaining, random.randint(1, 2))
        pyautogui.scroll(chunk * direction, _pause=False)
        remaining -= chunk
        if remaining > 0:
            time.sleep(random.uniform(0.05, 0.15))
    return {"ok": True, "action": "scroll"}


def handle_wander(msg):
    cx = msg.get("x", 400)
    cy = msg.get("y", 300)
    idle_wander(cx, cy)
    return {"ok": True, "action": "wander"}


def handle_ping(msg):
    return {"ok": True, "action": "ping", "version": "2.0"}


HANDLERS = {
    "calibrate": handle_calibrate,
    "move": handle_move,
    "move_bezier": handle_move_bezier,
    "click": handle_click,
    "scroll": handle_scroll,
    "wander": handle_wander,
    "ping": handle_ping,
}


# ── Main Loop ─────────────────────────────────────────────────

def main():
    # Graceful shutdown on SIGTERM / broken pipe
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    while True:
        try:
            msg = read_message()
            if msg is None:
                break

            action = msg.get("action", "")
            handler = HANDLERS.get(action)

            if handler:
                response = handler(msg)
            else:
                response = {"ok": False, "error": f"Unknown action: {action}"}

            send_message(response)

        except BrokenPipeError:
            break
        except Exception as e:
            try:
                send_message({"ok": False, "error": str(e)})
            except:
                break


if __name__ == "__main__":
    main()
