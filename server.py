#!/usr/bin/env python3
"""Раздаёт web/ по HTTPS в локальной сети — открыть на телефоне.

    python server.py [--port 8443]

Микрофон в браузере доступен только по HTTPS, поэтому создаётся самоподписанный
сертификат (.cert/). На телефоне браузер предупредит — нажать «Дополнительно → Перейти».
"""
import argparse
import http.server
import os
import socket
import ssl
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
CERT_DIR = os.path.join(HERE, ".cert")


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):
    os.makedirs(CERT_DIR, exist_ok=True)
    crt, key = os.path.join(CERT_DIR, "cert.pem"), os.path.join(CERT_DIR, "key.pem")
    stamp = os.path.join(CERT_DIR, "ip.txt")
    if os.path.exists(crt) and os.path.exists(stamp) and open(stamp).read() == ip:
        return crt, key
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
                    "-keyout", key, "-out", crt, "-subj", "/CN=dataoversound",
                    "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost"],
                   check=True, capture_output=True)
    open(stamp, "w").write(ip)
    return crt, key


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8443)
    a = ap.parse_args()
    ip = lan_ip()
    crt, key = ensure_cert(ip)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(crt, key)
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", a.port), Handler)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    url = f"https://{ip}:{a.port}/"
    print(f"\n  Откройте на телефоне (та же Wi-Fi сеть):  {url}\n")
    try:
        import qrcode
        q = qrcode.QRCode(border=1)
        q.add_data(url)
        q.print_ascii(invert=True)
    except ImportError:
        pass
    print("  Браузер предупредит о сертификате → «Дополнительно» → «Перейти на сайт».  Ctrl+C — выход.\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
