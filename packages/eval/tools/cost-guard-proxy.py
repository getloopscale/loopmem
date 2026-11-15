"""Cost guard for eval runs against the OpenAI API.

Forwards POST /v1/* to https://api.openai.com, adds up the cost of each response from its `usage`,
writes the running total to a ledger file, and answers 402 to every request once the cap is reached.
Point the runner at it with OPENAI_BASE_URL=http://127.0.0.1:<port>/v1.

Usage: cost-guard-proxy.py <port> <cap_usd> <ledger.json>

Prices are USD per million tokens (input, cached input, output) at the OpenAI list price for the
models the eval uses. A response from any other model is charged at a deliberately high price, and
counted under `unpriced`, so an unexpected model ends the run early instead of running unguarded.
"""
import json
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, CAP_USD, LEDGER = int(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
PRICES = {'gpt-4o-mini': (0.15, 0.075, 0.60), 'text-embedding-3-small': (0.02, 0.02, 0.0)}
UNKNOWN_MODEL_PRICE = (5.0, 5.0, 20.0)
FORWARDED_HEADERS = ('Authorization', 'Content-Type', 'OpenAI-Organization', 'OpenAI-Project')

lock = threading.Lock()
state = {'usd': 0.0, 'calls': 0, 'refused': 0, 'prompt_tokens': 0, 'cached_tokens': 0, 'completion_tokens': 0, 'unpriced': 0}


def price_of(model):
    for name, price in PRICES.items():
        if model.startswith(name):
            return price
    return None


def save():
    with open(LEDGER, 'w') as ledger:
        json.dump({**state, 'cap_usd': CAP_USD}, ledger)


def record(data):
    try:
        doc = json.loads(data)
    except ValueError:
        return
    usage = doc.get('usage') or {}
    if not usage:
        return
    prompt, completion = usage.get('prompt_tokens', 0), usage.get('completion_tokens', 0)
    cached = (usage.get('prompt_tokens_details') or {}).get('cached_tokens', 0) or 0
    price = price_of(str(doc.get('model', '')))
    with lock:
        if price is None:
            state['unpriced'] += 1
            price = UNKNOWN_MODEL_PRICE
        state['calls'] += 1
        state['prompt_tokens'] += prompt
        state['cached_tokens'] += cached
        state['completion_tokens'] += completion
        state['usd'] += ((prompt - cached) * price[0] + cached * price[1] + completion * price[2]) / 1e6
        save()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        with lock:
            if state['usd'] >= CAP_USD:
                state['refused'] += 1
                save()
                refusal = {'error': {'message': f'cost guard: cap of {CAP_USD} USD reached', 'type': 'cost_guard'}}
                self.reply(402, json.dumps(refusal).encode())
                return
        request = urllib.request.Request('https://api.openai.com' + self.path, data=body, method='POST')
        for header in FORWARDED_HEADERS:
            if self.headers.get(header):
                request.add_header(header, self.headers[header])
        try:
            response = urllib.request.urlopen(request, timeout=300)
            status, data = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, data = error.code, error.read()
        record(data)
        self.reply(status, data)


save()
ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
