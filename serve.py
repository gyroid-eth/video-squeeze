#!/usr/bin/env python3
"""
VIDEOSQUEEZE local server.

Serves index.html with cross-origin-isolation headers (COOP + COEP).
ffmpeg.wasm spawns a *same-origin* Web Worker, which these headers allow;
opening index.html directly (file://) mostly works too, but serving it is
more robust. (The encoder deliberately uses the single-threaded core — see
README "仕組みメモ" — so this is about Worker loading, not multithreading.)

    python3 serve.py            # picks a free port, opens your browser
    python3 serve.py 8123       # force a port
"""
import http.server
import socketserver
import sys
import webbrowser
import os
import contextlib

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 0  # 0 = OS picks a free port
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # cross-origin isolation -> enables SharedArrayBuffer -> multithreaded ffmpeg
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # quiet


class TCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    with TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        port = httpd.server_address[1]
        url = f"http://127.0.0.1:{port}/index.html"
        print("\n  VIDEOSQUEEZE  ──────────────────────────────")
        print(f"  serving:  {url}")
        print("  100% local · nothing leaves your machine.")
        print("  press Ctrl+C to stop.\n")
        # Don't auto-open a browser when running as a background service
        # (launchd would pop a new tab on every restart). VIDEOSQUEEZE_SERVICE=1 is set in the plist.
        if not os.environ.get("VIDEOSQUEEZE_SERVICE"):
            with contextlib.suppress(Exception):
                webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped.\n")


if __name__ == "__main__":
    main()
