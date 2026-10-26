"""
Server statis untuk pengembangan lokal.

Bedanya dengan `python -m http.server`: setiap respons dikirim dengan
Cache-Control: no-store, sehingga browser tidak pernah menyajikan HTML/CSS/JS
versi lama saat tombol Back ditekan atau halaman dibuka ulang.

Pakai:
    python serve.py          # port 8000
    python serve.py 8080     # port lain
"""

import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root)

    ThreadingHTTPServer.allow_reuse_address = True
    with ThreadingHTTPServer(("", port), NoCacheHandler) as httpd:
        print("Serving %s on http://127.0.0.1:%d (no-cache)" % (root, port), flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
