#!/bin/bash
# Double-click (macOS) to open VIDEOSQUEEZE in your browser.
# If a server is already running on port 8123 it just opens the page;
# otherwise it starts a one-off local server in this terminal window.
URL="http://127.0.0.1:8123/index.html"

if ! curl -s -o /dev/null --max-time 1 "$URL"; then
  echo "Starting a one-off local server (close this window to stop)…"
  cd "$(dirname "$0")" || exit 1
  exec python3 serve.py 8123
fi

open "$URL"
