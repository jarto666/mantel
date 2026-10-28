"""Serves ally-ssh-setup.ps1 to the Ally over the LAN and records where it phones home.

Usage: python3 tools/setup-server.py <mac-ip> <out-file> <ssh-public-key-file>
"""

import http.server
import pathlib
import sys
import threading

MAC_IP, OUT, KEY = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]).expanduser().read_text().strip()
SCRIPT = (pathlib.Path(__file__).parent / "ally-ssh-setup.ps1").read_text().replace("__MAC__", MAC_IP).replace("__KEY__", KEY)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.lstrip("/") != "ally-ssh-setup.ps1":
            self.send_error(404)
            return
        body = SCRIPT.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/ready":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        OUT.write_text(self.rfile.read(length).decode("utf-8").strip())
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")
        print(f"Ally reported: {OUT.read_text()}", flush=True)
        # One handshake is all we need.
        threading.Thread(target=self.server.shutdown).start()


http.server.ThreadingHTTPServer(("0.0.0.0", 8765), Handler).serve_forever()
