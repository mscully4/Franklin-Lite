#!/bin/bash
# One-time setup: install a LaunchDaemon that aliases 127.0.0.2–127.0.0.254
# to the loopback interface on macOS. Run once with sudo; survives reboots.
#
# Usage: sudo bash scripts/setup-loopback.sh

set -euo pipefail

PLIST=/Library/LaunchDaemons/com.franklin.loopback.plist

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Linux already routes all 127.x.x.x traffic to loopback — nothing to do."
  exit 0
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/setup-loopback.sh"
  exit 1
fi

cat > "$PLIST" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.franklin.loopback</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>for i in $(seq 2 254); do ifconfig lo0 alias 127.0.0.$i; done</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF

launchctl load "$PLIST"
echo "Loopback aliases 127.0.0.2–127.0.0.254 configured and will persist across reboots."
