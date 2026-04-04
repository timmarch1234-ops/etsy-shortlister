#!/bin/bash
# ============================================================
# Etsy Shortlister — Native Messaging Host Installer (macOS)
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.etsy.shortlister"
HOST_SCRIPT="$SCRIPT_DIR/native_host.py"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$MANIFEST_DIR/$HOST_NAME.json"

echo "========================================"
echo "  Etsy Shortlister — Setup"
echo "========================================"
echo ""

# ---- Check Python 3 ----
if ! command -v python3 &>/dev/null; then
    echo "ERROR: Python 3 is not installed."
    echo "  Install it: brew install python3"
    exit 1
fi
echo "✓ Python 3 found: $(python3 --version)"

# ---- Check / install pyautogui ----
if python3 -c "import pyautogui" 2>/dev/null; then
    echo "✓ pyautogui is installed"
else
    echo "  Installing pyautogui..."
    pip3 install pyautogui
    echo "✓ pyautogui installed"
fi

# ---- Make host script executable ----
chmod +x "$HOST_SCRIPT"
echo "✓ Made native_host.py executable"

# ---- Get extension ID ----
echo ""
echo "To find your extension ID:"
echo "  1. Go to chrome://extensions"
echo "  2. Enable 'Developer mode' (top right)"
echo "  3. Find 'Etsy Product Shortlister'"
echo "  4. Copy the ID (looks like: abcdefghijklmnopqrstuvwxyz)"
echo ""
read -p "Paste your extension ID: " EXT_ID

if [ -z "$EXT_ID" ]; then
    echo "ERROR: Extension ID is required."
    exit 1
fi

# ---- Create manifest ----
mkdir -p "$MANIFEST_DIR"

cat > "$MANIFEST_PATH" << EOF
{
  "name": "$HOST_NAME",
  "description": "Etsy Shortlister Native Mouse Controller",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

echo "✓ Native messaging manifest installed"
echo "  → $MANIFEST_PATH"

# ---- Accessibility permissions reminder ----
echo ""
echo "========================================"
echo "  IMPORTANT: Accessibility Permissions"
echo "========================================"
echo ""
echo "pyautogui needs Accessibility access to control the mouse."
echo ""
echo "  1. Open System Settings → Privacy & Security → Accessibility"
echo "  2. Click the + button"
echo "  3. Add 'Terminal' (or your terminal app: iTerm2, etc.)"
echo "  4. Also add 'Google Chrome'"
echo "  5. Make sure both are toggled ON"
echo ""
echo "If you skip this, mouse control will silently fail."
echo ""
echo "========================================"
echo "  Setup complete!"
echo "========================================"
echo ""
echo "Next steps:"
echo "  1. Grant Accessibility permissions (above)"
echo "  2. Reload the extension at chrome://extensions"
echo "  3. Run a search — the real mouse cursor will move!"
echo ""
