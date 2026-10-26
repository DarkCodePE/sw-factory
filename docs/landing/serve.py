#!/usr/bin/env python3
"""Serve the public tree under the same path prefix as GitHub Pages."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

parser = argparse.ArgumentParser()
parser.add_argument('--prefix', default='/sw-factory/')
parser.add_argument('--port', type=int, default=8770)
parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parents[2] / 'site')
args = parser.parse_args()
prefix = '/' + args.prefix.strip('/') + '/'


class PrefixedHandler(SimpleHTTPRequestHandler):
    def map_prefix(self):
        parsed = urlsplit(self.path)
        if parsed.path == prefix.rstrip('/'):
            self.send_response(308)
            self.send_header('Location', urlunsplit(('', '', prefix, parsed.query, '')))
            self.end_headers()
            return False
        if not parsed.path.startswith(prefix):
            self.send_error(404)
            return False
        self.path = urlunsplit(('', '', '/' + parsed.path[len(prefix):], parsed.query, ''))
        return True

    def do_GET(self):
        if self.map_prefix():
            super().do_GET()

    def do_HEAD(self):
        if self.map_prefix():
            super().do_HEAD()


server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(PrefixedHandler, directory=str(args.directory)))
print(f'http://127.0.0.1:{args.port}{prefix}', flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
