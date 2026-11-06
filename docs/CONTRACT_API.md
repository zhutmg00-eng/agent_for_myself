# AgentHarness HTTP / SSE API Contract

> **Status:** authoritative, reverse-engineered from the Python backend **without running it**.
> **Purpose:** precise enough to re-implement the server on Node.js so that the existing
> `agentharness/frontend/web` UI works unchanged (or with only the adaptations named in
> `docs/FUSION_SPEC.md` §8).
>
> **Method:** read-only source inspection on 2026-11-06. Every shape below is copied from the
> dict literals / dataclasses that build it. Line references are relative to
> `D:\能力测试\agentharness`.

## Source-of-truth map

| Concern | File | Key lines |
|---|---|---|
| HTTP server, routing, static, SSE, `_send_json` | `agentharness/cli/commands/server.py` | 241–288 (startup), 291–862 (server), 865–875 (`_send_json`), 878–921 (SSE) |
| Bot configs, settings, context stats, rooms, `room_say`, stats | `agentharness/core/runtime.py` | 371–436, 502–697, 1033–1310, 1312–1388 |
| Room object, permissions, room events, rounds | `agentharness/agents/group.py` | 37–99, 205–395, 615–647, 747–764, 767–902 |
| Room messages / events / room rows persistence | `agentharness/core/store.py` | 244–378 (schema), 953–1006, 1012–1316 |
| Avatars | `agentharness/core/avatars.py` | whole file |
| Hooks | `agentharness/core/hooks.py` | 148–156 |
| Skills | `agentharness/skills/manager.py` | 75–84, 147–151 |
| Archetype presets (bot defaults) | `agentharness/agents/archetypes.py` | 20–281 |
| Ticket / thread enums and models | `agentharness/core/models.py` | 17–33, 114–166 |
| Config defaults (paths, model, gateway) | `agentharness/core/config.py` | 188–212, 250–307 |
| `Event` envelope | `agentharness/core/event_bus.py` | 33–41 |
| Frontend consumer | `agentharness/frontend/web/js/api.js`, `js/store.js` | — |

---

## 0. TL;DR

* **29** `method + path` endpoints under `/api`, plus **3** static routes (`/`, `/static/*`, `/favicon.ico`) and one **global `OPTIONS`** preflight handler.
* Bind is **hard-coded** to `127.0.0.1`; port comes from `AGENTHARNESS_HTTP_PORT` (default **8420**). Plain HTTP/1.1 over `asyncio.start_server`, no TLS, no auth, `Access-Control-Allow-Origin: *`.
* JSON responses are UTF-8, `ensure_ascii=False`, non-serializable values stringified. Errors are always `{"error": "<message>"}`.
* **`_send_json` always writes the reason phrase `OK`** — a 404 is literally `HTTP/1.1 404 OK`. Only the numeric status is meaningful.
* **SSE frames are `data: {json}\n\n` where the JSON has exactly `topic`, `sender`, `payload`.** There is **no** `seq`, `ts`, `thread_id`, `id:` or `event:` field.
* Room event replay is a **separate** endpoint, `GET /api/thread/{thread_id}/events`, where each item **does** have `seq`, `ts`, `topic`, `sender`, `payload`, `thread_id`. Room events are stored under the synthetic thread id `room:<room_id>`.
* **There is no authentication, no cookies, no sessions.** State is process-global.
* Malformed JSON bodies and several programming errors produce **no HTTP response at all** (connection is closed silently) — see §11.
* The room object has **no `created_at` and no `files` array**; files come from `GET /api/rooms/{id}/files`.

---

## 1. Server startup, bind, static files, health

### 1.1 Process / CLI

Console script: `agentharness` (`pyproject.toml:39-40`), subcommand group `server`
(`agentharness/cli/main.py:62`).

```text
agentharness server start                # foreground (asyncio.run(_run_server_loop))
agentharness server start --daemon, -d   # detached subprocess, log to <cache_dir>/server_daemon.log
agentharness server stop [--timeout 5] [--force]
agentharness server status [--json]
```

`start` first calls `probe_server_running(cfg.lock_path)`; if the file lock at
`cfg.lock_path` is already held it prints an error and exits 1. In daemon mode it spawns
`python -m agentharness.cli.main server start --foreground` with `DETACHED_PROCESS |
CREATE_NEW_PROCESS_GROUP` on Windows and waits up to 8 s for lock acquisition.

On foreground start (`server.py:241-288`):

1. `HarnessRuntime(db_path=cfg.db_path, cache_dir=cfg.cache_dir)`, `await runtime.start()`
   — initializes SQLite, restores persisted rooms, starts watchdog/health/event-persistence.
2. `await runtime.watchdog.recover_on_startup()` and prints recovery stats.
3. Binds the HTTP server and prints:
   ```
   agentharness server started (PID: <pid>). Recovery stats: {...}
   HTTP API listening on http://127.0.0.1:<port>
     POST /api/task         - submit a task
     GET  /api/events       - SSE event stream
     ...
   ```
4. Waits forever on `asyncio.Event`. On SIGINT/SIGTERM (non-Windows only; Windows has no
   signal handlers) it cancels the HTTP task and calls `runtime.shutdown()`.

### 1.2 Bind address and port

```python
http_port = int(os.environ.get("AGENTHARNESS_HTTP_PORT", "8420"))
...
server = await asyncio.start_server(handle_request, "127.0.0.1", port)
runtime._http_bound_port = int(server.sockets[0].getsockname()[1])
```

* Host: **always `127.0.0.1`**; not configurable via CLI/env in this server.
* Port: `AGENTHARNESS_HTTP_PORT`, default **8420**; `int()` parsing, so a non-numeric value
  crashes startup. `port=0` would bind an OS-assigned port and expose it as
  `runtime._http_bound_port`, but the CLI always passes an explicit port.
* No TLS, no HTTP/2, no WebSocket.

### 1.3 Connection handling

* Minimal hand-rolled HTTP/1.1 parser on `asyncio.StreamReader`:
  * Request line split on whitespace: `method`, `raw_path`.
  * `path` and `query_string` are split on the **first `?`** (`raw_path.partition("?")`).
    `path` is used verbatim (no normalisation, no global URL-decoding; trailing slashes do
    **not** match). Query parameters are parsed per-route with `urllib.parse.parse_qs`.
  * Headers are read until a blank line, names lower-cased; only `content-length` is used.
  * Body is read **only** via `Content-Length` (`reader.readexactly`); `Transfer-Encoding:
    chunked` is **not** supported.
  * Requests without `Content-Length` are treated as having an empty body.
* Every normal JSON response carries `Connection: close`; the server closes the socket after
  each response. (No keep-alive, no pipelining.)
* `OPTIONS` is answered for **any** path with `204 No Content` (see 1.4).
* `HEAD` is **not** implemented: it falls through to `404 {"error": "not found"}` (with a
  body).
* Method matching is exact uppercase (`GET`, `POST`, `PUT`, `DELETE`, `OPTIONS`).

### 1.4 CORS / OPTIONS

Every JSON response includes `Access-Control-Allow-Origin: *`. There are no credentials,
cookies or auth headers anywhere. Preflight:

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Content-Length: 0
Connection: close
```

No `Access-Control-Max-Age`.

### 1.5 `_send_json` — response envelope (server.py:865-875)

```python
body = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
header = (
    f"HTTP/1.1 {status} OK\r\n"
    f"Content-Type: application/json; charset=utf-8\r\n"
    f"Content-Length: {len(body)}\r\n"
    f"Access-Control-Allow-Origin: *\r\n"
    f"Connection: close\r\n\r\n"
).encode("utf-8")
writer.write(header + body)
```

* Status line reason phrase is **always the literal `OK`**, e.g. `HTTP/1.1 400 OK`,
  `HTTP/1.1 404 OK`, `HTTP/1.1 500 OK`, `HTTP/1.1 201 OK`, `HTTP/1.1 202 OK`.
* `Content-Type: application/json; charset=utf-8`.
* `Content-Length` is the byte length of the UTF-8 body.
* No `Date`, `Server`, `ETag`, `Vary` headers.
* Non-JSON-serializable values become `str(value)` (`default=str`), e.g. `datetime` →
  `2026-11-06 01:20:31.442118+00:00`, `Path` → `D:\...`.

### 1.6 Error body shape

**Every** error the server deliberately emits is:

```json
{ "error": "human readable message" }
```

There is no `detail`, `code`, `traceback` or nested error object. The complete message
catalogue is in §11.

### 1.7 Static file serving (server.py:298-339, 835-840)

`web_root` is computed relative to the **source file**:

```python
web_root = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "frontend", "web"))
```

For this checkout that resolves to `D:\能力测试\agentharness\frontend\web`
(the directory containing `index.html`, `app.css`, `favicon.svg`, `js/`).

| Request | Maps to | Notes |
|---|---|---|
| `GET /` | `<web_root>/index.html` | `text/html; charset=utf-8` |
| `GET /static/{rel}` | `<web_root>/{rel}` | e.g. `/static/js/app.js` → `<web_root>/js/app.js` |
| `GET /favicon.ico` | `<web_root>/favicon.svg` | served as `image/svg+xml` |
| anything else | `404 {"error": "not found"}` | `/index.html` and `/js/app.js` are **404** |

Static response headers:

```http
HTTP/1.1 200 OK
Content-Type: <by extension>
Content-Length: <n>
Cache-Control: no-cache
Access-Control-Allow-Origin: *
Connection: close
```

MIME map (`server.py:302-313`): `.html text/html; charset=utf-8`,
`.css text/css; charset=utf-8`, `.js`/`.mjs text/javascript; charset=utf-8`,
`.json`/`.map application/json; charset=utf-8`, `.svg image/svg+xml`, `.png image/png`,
`.ico image/x-icon`, `.woff2 font/woff2`, anything else `application/octet-stream`.

Traversal guard: `full = normpath(join(base, rel))`, then `full.startswith(base) and
isfile(full)`; failure → `404 {"error": "not found"}`. (This is a raw string-prefix check,
so a sibling directory whose name starts with `web` would also pass — porting note, not an
observable contract.)

**Dead code:** `server.py` contains a **second** `elif path == "/" and method == "GET":`
branch (lines 841-843) that would return
`{"name": "AgentHarness", "version": "1.0", "endpoints": ["/api/task", "/api/events", "/api/tickets", "/api/threads", "/api/health"]}`.
It is unreachable because the first `GET /` branch (line 835) already returns `index.html`.
There is therefore **no JSON API index** at `/`.

### 1.8 `GET /api/health`

* **Auth:** none. **Query:** none. **Body:** none.
* **200** always, as soon as the runtime object exists (it does not touch SQLite or the LLM
  gateway).
* Exact builder (`server.py:383-390`):

```python
{
    "status": "ok",
    "model": runtime.model_name,
    "workspace_root": runtime.workspace_root,
    "gateway_url": getattr(runtime.llm, "base_url", None)
                   or getattr(getattr(runtime.llm, "config", None), "base_url", None),
}
```

`runtime.model_name` = `llm.model` if present else `llm.config.model`; `MagpieClient` has no
`model`/`base_url` attributes, so the effective values are `llm.config.model` and
`llm.config.base_url`.

**Example (fresh install):**

```json
{
  "status": "ok",
  "model": "workbuddy/deepseek-v4.1-flash",
  "workspace_root": "d:\\能力测试\\agentharness",
  "gateway_url": "http://127.0.0.1:3425/v1"
}
```

`gateway_url` can be `null` if the llm has neither attribute (never with the bundled
`MagpieClient`).

---

## 2. Endpoint index

IDs are used by the detailed sections. All paths are case-sensitive and must match exactly
(no trailing slash tolerance).

| ID | Method | Path | Success | Purpose |
|---|---|---|---|---|
| E01 | GET | `/api/health` | 200 | health/identity |
| E02 | GET | `/api/stats` | 200 | token totals + store counts + context snapshot |
| E03 | GET | `/api/context` | 200 | context-window telemetry |
| E04 | GET | `/api/settings` | 200 | runtime settings |
| E05 | PUT | `/api/settings` | 200 | mutate runtime settings |
| E06 | GET | `/api/models` | 200 | model catalogue (gateway probe + fallback) |
| E07 | GET | `/api/bots` | 200 | full bot configs |
| E08 | GET | `/api/bots/{id}` | 200 | one bot config |
| E09 | PUT | `/api/bots/{id}` | 200 | mutate one bot config |
| E10 | GET | `/api/avatars` | 200 | avatar index |
| E11 | GET | `/api/avatars/{kind}/{id}` | 200 (binary) | avatar bytes |
| E12 | POST | `/api/avatars/{kind}/{id}` | 201 | upload avatar |
| E13 | DELETE | `/api/avatars/{kind}/{id}` | 200 | delete avatar |
| E14 | GET | `/api/skills` | 200 | skill catalogue |
| E15 | GET | `/api/hooks` | 200 | hook rules |
| E16 | POST | `/api/hooks/reload` | 200 | re-read `hooks.json` |
| E17 | GET | `/api/rooms` | 200 | room list |
| E18 | POST | `/api/rooms` | 201 | create room |
| E19 | GET | `/api/rooms/{id}` | 200 | room snapshot |
| E20 | PUT | `/api/rooms/{id}` | 200 | mutate room |
| E21 | GET | `/api/rooms/{id}/messages` | 200 | persisted transcript |
| E22 | GET | `/api/rooms/{id}/files` | 200 | room file index |
| E23 | GET | `/api/rooms/{id}/files/{file_id}` | 200 | file metadata + text content |
| E24 | POST | `/api/rooms/{id}/say` | 200 | user message → async round |
| E25 | GET | `/api/thread/{thread_id}/events` | 200 | persisted event replay |
| E26 | GET | `/api/events` | 200 (SSE) | live event stream |
| E27 | GET | `/api/tickets` | 200 | recent tickets |
| E28 | GET | `/api/threads` | 200 | recent threads |
| E29 | POST | `/api/task` | 202 | submit a task |
| S1 | GET | `/` | 200 | `index.html` |
| S2 | GET | `/static/{rel}` | 200 | static asset |
| S3 | GET | `/favicon.ico` | 200 | `favicon.svg` |
| — | OPTIONS | any | 204 | CORS preflight |

Unmatched route (including unknown `/api/*` and unsupported methods): **404**
`{"error": "not found"}`.

---

## 3. Meta / system endpoints

### E01 `GET /api/health`

See §1.8. No parameters, no errors. 200.

### E02 `GET /api/stats`

* **Query:** none. **Body:** none.
* Builder (`server.py:118-153`):

```python
tokens = {
    "prompt": _int_token(getattr(llm, "total_prompt_tokens", 0)),
    "completion": _int_token(getattr(llm, "total_completion_tokens", 0)),
    "cache_read": _int_token(getattr(llm, "total_cache_read_tokens", 0)),
    "cache_write": _int_token(getattr(llm, "total_cache_write_tokens", 0)),
}
counts = {"threads": 0, "tickets": 0, "tickets_by_state": {}, "rooms": 0}
# threads  = SELECT COUNT(*) FROM threads
# tickets  = SELECT COUNT(*) FROM tickets
# tickets_by_state = SELECT state, COUNT(*) FROM tickets GROUP BY state
# rooms    = len(runtime.rooms)
context_snap = runtime.get_context_stats()      # no thread_id
return {"tokens": tokens, "counts": counts, "context": context_snap}
```

All token counters are clamped to non-negative ints (`_int_token`); non-numeric → `0`.
If the store read fails, `threads`/`tickets` stay `0`, `tickets_by_state` stays `{}`;
`rooms` is set independently. `tickets_by_state` keys are raw state strings
(`queued|working|blocked|failed|ready|dropped|ended`).

**Example:**

```json
{
  "tokens": {
    "prompt": 182340,
    "completion": 41210,
    "cache_read": 120400,
    "cache_write": 9800
  },
  "counts": {
    "threads": 12,
    "tickets": 9,
    "tickets_by_state": {
      "working": 1,
      "ready": 6,
      "failed": 1,
      "ended": 1
    },
    "rooms": 3
  },
  "context": {
    "thread_id": null,
    "model": "workbuddy/deepseek-v4.1-flash",
    "max_context_tokens": 1000000,
    "compact_threshold_tokens": 750000,
    "active_tokens": 18432,
    "usage_percentage": 1.8432,
    "distribution": { "system": 3120, "user": 4021, "assistant": 6807, "tool": 4484 },
    "tokens_total": {
      "prompt": 182340,
      "completion": 41210,
      "cache_read": 120400,
      "cache_write": 9800,
      "cache_hit_rate": 0.3977
    },
    "cache_hit_rate": 0.3977,
    "compaction": { "count": 0, "needed": false },
    "bots": [
      { "bot_id": "coder", "tokens": 5120, "messages_count": 9 },
      { "bot_id": "reviewer", "tokens": 3184, "messages_count": 6 },
      { "bot_id": "boss", "tokens": 2140, "messages_count": 4 }
    ]
  }
}
```

Notes:

* `tokens.*` come from the LLM client's **cumulative process-lifetime** counters
  (`MagpieClient.total_*`, `magpie.py:124-127`).
* `context` is the same object E03 returns with `thread_id = null`.
* `active_tokens` is a heuristic (≈4 chars/token) over each worker's in-memory
  `message_history`; not a real tokenizer count.

### E03 `GET /api/context`

* **Query:** `thread_id` (optional string; only used as an echo/session label).
* **Body:** none.
* Handler (`server.py:607-621`) calls `runtime.get_context_stats(thread_id)`.
* Full return (`runtime.py:1367-1388`):

```python
{
    "thread_id": thread_id,                       # echo of query param, or null
    "model": self.model_name,
    "max_context_tokens": 1_000_000,              # hard-coded
    "compact_threshold_tokens": 750_000,          # 75 %
    "active_tokens": total_active_tokens,          # sum over workers + router subagents
    "usage_percentage": round(total/1_000_000*100, 4),
    "distribution": {"system": int, "user": int, "assistant": int, "tool": int},
    "tokens_total": {
        "prompt": int, "completion": int, "cache_read": int, "cache_write": int,
        "cache_hit_rate": round(cache_read/(prompt+cache_read), 4) or 0.0,
    },
    "cache_hit_rate": same float,
    "compaction": {"count": int, "needed": bool},   # needed = active >= 750000
    "bots": [{"bot_id": str, "tokens": int, "messages_count": int}, ...],
}
```

* `distribution` is accumulated from `get_context_distribution` per session.
* `compaction.count` = sum of `worker.compactor.compaction_count` over `runtime.workers`.
* `bots` lists only sessions whose `message_history` is non-empty; `runtime.workers` first,
  then `router.registered_workers` not already counted.

If the runtime lacked `get_context_stats` (never for `HarnessRuntime`), the route's fallback
would return only `thread_id`, `model`, `max_context_tokens: 1000000`, `active_tokens: 0`,
`usage_percentage: 0.0`, `distribution: {"system":0,"user":0,"assistant":0,"tool":0}`
(`server.py:610-621`).

**Example:**

```json
{
  "thread_id": "4f2a9c1e8b7d4a6e9f0a1b2c3d4e5f60",
  "model": "workbuddy/deepseek-v4.1-flash",
  "max_context_tokens": 1000000,
  "compact_threshold_tokens": 750000,
  "active_tokens": 18432,
  "usage_percentage": 1.8432,
  "distribution": { "system": 3120, "user": 4021, "assistant": 6807, "tool": 4484 },
  "tokens_total": {
    "prompt": 182340,
    "completion": 41210,
    "cache_read": 120400,
    "cache_write": 9800,
    "cache_hit_rate": 0.3977
  },
  "cache_hit_rate": 0.3977,
  "compaction": { "count": 0, "needed": false },
  "bots": [
    { "bot_id": "coder", "tokens": 5120, "messages_count": 9 },
    { "bot_id": "reviewer", "tokens": 3184, "messages_count": 6 }
  ]
}
```

### E04 `GET /api/settings`

* No params. Returns `runtime.get_settings()` (`runtime.py:1033-1045`) exactly:

```python
{
    "model": self.model_name,
    "gateway_url": self.config.llm_base_url or "http://127.0.0.1:3425/v1",
    "workspace_root": self.config.workspace_root,
    "max_parallel": router.max_parallel,          # fallback config.orchestrator_max_parallel
    "max_subtasks": router.max_subtasks,          # fallback config.orchestrator_max_subtasks
    "max_iterations": config.default_mandate_max_iterations,
    "timeout_seconds": config.default_mandate_timeout_seconds,
    "watchdog_timeout": config.watchdog_timeout_seconds,
    "archetype_model_overrides": dict(router.archetype_model_overrides or {}),
}
```

**Example (defaults):**

```json
{
  "model": "workbuddy/deepseek-v4.1-flash",
  "gateway_url": "http://127.0.0.1:3425/v1",
  "workspace_root": "d:\\能力测试\\agentharness",
  "max_parallel": 2,
  "max_subtasks": 8,
  "max_iterations": 30,
  "timeout_seconds": 120.0,
  "watchdog_timeout": 60.0,
  "archetype_model_overrides": {}
}
```

If the runtime lacks `get_settings` (never for `HarnessRuntime`), the route returns only
`{"model", "gateway_url", "workspace_root"}` (`server.py:525-531`).

Defaults come from `HarnessConfig` (`config.py:188-307`): `llm_model
workbuddy/deepseek-v4.1-flash`, `llm_base_url http://127.0.0.1:3425/v1`,
`orchestrator_max_parallel 2`, `orchestrator_max_subtasks 8`,
`default_mandate_max_iterations 30`, `default_mandate_timeout_seconds 120.0`,
`watchdog_timeout_seconds 60.0`.

### E05 `PUT /api/settings`

* **Body:** JSON object; any subset of the keys below. Unknown keys are **silently ignored**.
* Handler (`server.py:532-551`) → `runtime.update_settings(data)` then publishes event
  `harness.settings.updated` (`sender: "server"`, `payload: <full settings object>`) and
  returns the full settings object (HTTP 200).

Accepted fields and semantics (`runtime.py:1060-1109`):

| Field | Type | Semantics |
|---|---|---|
| `model` | non-empty string | `set_active_model`: sets `config.llm_model`, `llm.config.model`, `router.config.model`. Empty string ignored. |
| `gateway_url` | string | sets `config.llm_base_url`, `llm.config.base_url` (no URL validation). |
| `max_parallel` | int-coercible | `max(1, int(v))`; sets config + `router.max_parallel`. |
| `max_subtasks` | int-coercible | `max(1, int(v))`; sets config + `router.max_subtasks`. |
| `max_iterations` | int-coercible | `max(1, int(v))` → `config.default_mandate_max_iterations`. |
| `timeout_seconds` | float-coercible | `max(1.0, float(v))` → `config.default_mandate_timeout_seconds`. |
| `watchdog_timeout` | float-coercible | `max(1.0, float(v))` → config + `watchdog.heartbeat_timeout_seconds`. |
| `archetype_model_overrides` | object | each `str → str` entry merged into `config.archetype_model_overrides` and `router.archetype_model_overrides`. Non-string values ignored. |

Errors:

* Body is not a JSON object → **400** `{"error": "payload must be a JSON object"}`.
* `int()`/`float()` conversion failure (e.g. `"abc"`) → **400** `{"error": "<ValueError text>"}`
  (e.g. `invalid literal for int() with base 10: 'abc'`).
* Other exceptions (e.g. `TypeError` from `int(None)`) → **500**
  `{"error": "Failed to update settings: <exc>"}`.
* Invalid JSON bytes → **no response**, socket closed (see §11).

**Request example:**

```json
{
  "model": "workbuddy/hy3",
  "max_parallel": 3,
  "watchdog_timeout": 90
}
```

**Response:** the same shape as E04, with the new values (200).

Notes:

* Changing `model` updates the LLM client config, but **existing bot configs keep their own
  `model` string**; `/api/bots` will keep returning the old per-bot model until that bot is
  PUT. `/api/health` and `/api/settings` reflect the new model immediately.
* `gateway_url` changes are written to `config.llm_base_url` **and** `llm.config.base_url`,
  so they are reflected by E01 (`/api/health`), E04 (`/api/settings`) and E06 (`/api/models`)
  on the next read.

---

## 4. Models and bots

### E06 `GET /api/models`

* **Query:** none. **Body:** none.
* Handler (`server.py:415-470`):
  1. Resolve `gw_url = config.llm_base_url or llm.base_url or llm.config.base_url or
     "http://127.0.0.1:3425/v1"`.
  2. Probe `GET {gw_url.rstrip("/")}/models` via `urllib.request` in a thread, timeout
     **2.0 s**, header `User-Agent: AgentHarness/1.0`, **no Authorization header**.
  3. If probe returns HTTP 200, use `payload.get("data", [])`; otherwise / on exception /
     empty list → fallback catalogue.
* Response (200):

```python
{
    "object": "list",
    "data": [ <model dicts verbatim from gateway, or fallback list> ],
    "current_model": runtime.model_name,
    "gateway_url": gw_url,
    "is_fallback": bool,
}
```

**Fallback entries (exact, `server.py:443-462`):**

```json
[
  {
    "id": "workbuddy/deepseek-v4.1-flash",
    "display_name": "DeepSeek-V4.1-Flash",
    "owned_by": "workbuddy",
    "context_length": 1000000,
    "max_output_tokens": 128000,
    "tool_call": true,
    "reasoning": true
  },
  {
    "id": "workbuddy/hy3",
    "display_name": "Hy3",
    "owned_by": "workbuddy",
    "context_length": 192000,
    "max_output_tokens": 64000,
    "tool_call": true,
    "reasoning": true
  }
]
```

**Example response (gateway down):**

```json
{
  "object": "list",
  "data": [
    {
      "id": "workbuddy/deepseek-v4.1-flash",
      "display_name": "DeepSeek-V4.1-Flash",
      "owned_by": "workbuddy",
      "context_length": 1000000,
      "max_output_tokens": 128000,
      "tool_call": true,
      "reasoning": true
    },
    {
      "id": "workbuddy/hy3",
      "display_name": "Hy3",
      "owned_by": "workbuddy",
      "context_length": 192000,
      "max_output_tokens": 64000,
      "tool_call": true,
      "reasoning": true
    }
  ],
  "current_model": "workbuddy/deepseek-v4.1-flash",
  "gateway_url": "http://127.0.0.1:3425/v1",
  "is_fallback": true
}
```

Gateway-shaped entries are passed through **unchanged**, so a real gateway response may
contain only OpenAI-style fields (`id`, `object`, `created`, `owned_by`). The UI uses
`m.id` and `m.display_name || m.id`, so `display_name` is optional.

### E07 `GET /api/bots`

* **Query:** none.
* Returns `{"bots": runtime.list_bot_configs()}` (200).

`list_bot_configs` (`runtime.py:1187-1210`) order on a fresh runtime:
1. `ChiefRouter` (variant **A** below)
2. `coder` (variant **B**)
3. `reviewer` (variant **B**)
4. `boss` (variant **B**, custom name/badge/tools)
5. `librarian` (variant **B**)
6. `explore` (variant **C**)
7. `plan` (variant **C**)
8. `general-purpose` (variant **C**)
9. `teammate` (variant **C**)

Rules:

* Workers from `runtime.workers` come first (insertion order: coder, reviewer, boss,
  librarian), skipping ids in `{"ChiefRouter","chief","router"}`.
* Then `router.registered_workers` entries not already seen (normally all are seen).
* Then every `ARCHETYPE_REGISTRY` entry whose `agent_type` was not seen; registry order is
  `explore, plan, general-purpose, general, teammate, boss, librarian`; `general` aliases
  `general-purpose` and is skipped because the agent_type is already seen.
* **Stateful:** creating a room with an archetype member (e.g. `explore`) materializes it as
  a real worker (`_ensure_special_worker`), after which it is returned as variant **B**
  (worker config, `max_iterations` 30 unless boss) instead of variant **C**.

If the runtime lacked `list_bot_configs` (never for `HarnessRuntime`), the route falls back to
`_collect_bots` (`server.py:51-107`), which returns only `{"bots": [...]}` with minimal
entries: router `{id, role:"router", state, label:"Chief"}` and each worker
`{id, role:"worker", archetype, state}` — **no** name/badge/tagline/model/tools.

#### Variant A — ChiefRouter (`runtime.py:1111-1130`)

```json
{
  "id": "ChiefRouter",
  "name": "Chief Router",
  "role": "router",
  "archetype": "router",
  "label": "Chief",
  "badge": "🧭",
  "tagline": "总调度 · 任务拓扑分解",
  "state": "idle",
  "model": "workbuddy/deepseek-v4.1-flash",
  "temperature": 0.0,
  "system_prompt": "You are the Chief Router orchestrating autonomous subagents.",
  "allowed_tools": ["read_file", "list_dir", "grep_search", "find_by_name", "subagent_task", "job_list"],
  "read_only": true,
  "max_subtasks": 8,
  "max_parallel": 2
}
```

* `allowed_tools` = `router.mounted_tools`, already filtered by `ROUTER_PRESET`
  (`agents/presets.py:37-62`), i.e. the maximum set is the six above (plus `decompose_task`
  if ever mounted; `decompose_task` is not in the runtime mount list).
* `read_only` is hard-coded `true` in the builder (not a Mandate flag).
* `state` = `AgentState.value` (`initializing|idle|working|paused|blocked|error|terminated`).
* `badge`/`tagline` come from `router.config.extra` if set by E09, else the defaults above.

#### Variant B — worker (`runtime.py:1132-1160`)

```json
{
  "id": "coder",
  "name": "coder",
  "role": "worker",
  "archetype": "coder",
  "label": "coder",
  "badge": "🤖",
  "tagline": "",
  "state": "idle",
  "model": "workbuddy/deepseek-v4.1-flash",
  "temperature": 0.0,
  "system_prompt": "You are an autonomous execution agent.",
  "allowed_tools": [
    "read_file", "write_file", "edit_file", "list_dir",
    "grep_search", "find_by_name", "shell", "skill_list", "skill_invoke"
  ],
  "read_only": false,
  "max_iterations": 30,
  "timeout_seconds": 120.0
}
```

* `name`/`label` = `worker.config.name` (defaults to bot id, set to archetype display name for
  boss/librarian; reviewer keeps `"reviewer"`).
* `archetype` = `worker.worker_type` → `worker.archetype` → `worker.role` → `"worker"`.
  `WorkerAgent` has only `role`, so this equals the role string (`coder`, `reviewer`, `boss`,
  `librarian`, or a materialized archetype name).
* `badge`/`tagline` = `worker.config.extra` value, else the archetype preset value, else
  `"🤖"` / `""`. Because worker `extra` is empty by default, archetype presets apply.
* `read_only` = `mandate.read_only`; `max_iterations`/`timeout_seconds` = mandate values.
* `system_prompt` = worker config prompt, else the generic fallback shown above.

Fresh-runtime worker values:

| id | name/label | archetype | badge | tagline | allowed_tools | read_only | max_iter | timeout |
|---|---|---|---|---|---|---|---|---|
| `coder` | `coder` | `coder` | 🤖 | `""` | read_file, write_file, edit_file, list_dir, grep_search, find_by_name, shell, skill_list, skill_invoke | false | 30 | 120.0 |
| `reviewer` | `reviewer` | `reviewer` | 🤖 | `""` | read_file, list_dir, grep_search, find_by_name, room_file_read, room_file_list, skill_list, skill_invoke | **true** | 30 | 120.0 |
| `boss` | `Boss` | `boss` | 👑 | `编排者 · 只路由不执行` | room_list_members, list_sessions, spawn_child_session, send_message, read_transcript, send_user_message, room_grant_permission, room_set_context_policy, room_file_list | false | **8** | 120.0 |
| `librarian` | `Librarian` | `librarian` | 🗂 | `群文件管家 · 地址同步` | room_file_save, room_file_read, room_file_list, room_file_move, read_file, list_dir, skill_list, skill_invoke | false | 30 | 120.0 |

(`boss.system_prompt` = `BOSS_SYSTEM_PROMPT`, `librarian.system_prompt` =
`LIBRARIAN_SYSTEM_PROMPT`, `reviewer.system_prompt` = the custom Chinese reviewer prompt —
all verbatim from `agents/archetypes.py` / `runtime.py:256-259`.)

#### Variant C — archetype preset (`runtime.py:1162-1185`)

```json
{
  "id": "explore",
  "name": "Explore",
  "role": "worker",
  "archetype": "explore",
  "label": "Explore",
  "badge": "🔍",
  "tagline": "只读代码探索员",
  "state": "idle",
  "model": "workbuddy/deepseek-v4.1-flash",
  "temperature": 0.0,
  "system_prompt": "<EXPLORE_SYSTEM_PROMPT, archetypes.py:38-51>",
  "allowed_tools": ["read_file", "list_dir", "grep_search", "find_by_name"],
  "read_only": true,
  "max_iterations": 15,
  "timeout_seconds": 120.0
}
```

Fresh-runtime archetype entries:

| id | name/label | badge | tagline | allowed_tools | read_only | max_iter |
|---|---|---|---|---|---|---|
| `explore` | `Explore` | 🔍 | `只读代码探索员` | read_file, list_dir, grep_search, find_by_name | true | 15 |
| `plan` | `Plan` | 📐 | `架构规划师` | read_file, list_dir, grep_search, find_by_name | true | 15 |
| `general-purpose` | `General` | ⚙️ | `通用执行代理` | **`[]`** (archetype declares `allowed_tools=None`) | false | 30 |
| `teammate` | `Teammate` | 🧩 | `协作成员` | **`[]`** | false | 30 |

`model` = `router.archetype_model_overrides.get(agent_type, archetype.default_model)`, i.e.
`workbuddy/deepseek-v4.1-flash` unless overridden via E05/E09.

`read_only` → `max_iterations` is `15` when true else `30`; `timeout_seconds` always `120.0`;
`temperature` always `0.0`; `state` always `"idle"`.

#### Complete fresh-install example

```json
{
  "bots": [
    {
      "id": "ChiefRouter", "name": "Chief Router", "role": "router", "archetype": "router",
      "label": "Chief", "badge": "🧭", "tagline": "总调度 · 任务拓扑分解", "state": "idle",
      "model": "workbuddy/deepseek-v4.1-flash", "temperature": 0.0,
      "system_prompt": "You are the Chief Router orchestrating autonomous subagents.",
      "allowed_tools": ["read_file", "list_dir", "grep_search", "find_by_name", "subagent_task", "job_list"],
      "read_only": true, "max_subtasks": 8, "max_parallel": 2
    },
    {
      "id": "coder", "name": "coder", "role": "worker", "archetype": "coder",
      "label": "coder", "badge": "🤖", "tagline": "", "state": "idle",
      "model": "workbuddy/deepseek-v4.1-flash", "temperature": 0.0,
      "system_prompt": "You are an autonomous execution agent.",
      "allowed_tools": ["read_file", "write_file", "edit_file", "list_dir", "grep_search", "find_by_name", "shell", "skill_list", "skill_invoke"],
      "read_only": false, "max_iterations": 30, "timeout_seconds": 120.0
    },
    {
      "id": "reviewer", "name": "reviewer", "role": "worker", "archetype": "reviewer",
      "label": "reviewer", "badge": "🤖", "tagline": "", "state": "idle",
      "model": "workbuddy/deepseek-v4.1-flash", "temperature": 0.0,
      "system_prompt": "你是团队的审查员（Reviewer），负责独立核验产出，不下场代做。\n核验时按 file_id 使用 room_file_read 读取群文件，或用 read_file 读取工作区文件；不要用 shell 做文件检查。逐项给出「通过 / 需修改」与证据，结论先行，简洁。",
      "allowed_tools": ["read_file", "list_dir", "grep_search", "find_by_name", "room_file_read", "room_file_list", "skill_list", "skill_invoke"],
      "read_only": true, "max_iterations": 30, "timeout_seconds": 120.0
    },
    {
      "id": "boss", "name": "Boss", "role": "worker", "archetype": "boss",
      "label": "Boss", "badge": "👑", "tagline": "编排者 · 只路由不执行", "state": "idle",
      "model": "workbuddy/deepseek-v4.1-flash", "temperature": 0.0,
      "system_prompt": "<BOSS_SYSTEM_PROMPT, archetypes.py:175-202>",
      "allowed_tools": ["room_list_members", "list_sessions", "spawn_child_session", "send_message", "read_transcript", "send_user_message", "room_grant_permission", "room_set_context_policy", "room_file_list"],
      "read_only": false, "max_iterations": 8, "timeout_seconds": 120.0
    },
    {
      "id": "librarian", "name": "Librarian", "role": "worker", "archetype": "librarian",
      "label": "Librarian", "badge": "🗂", "tagline": "群文件管家 · 地址同步", "state": "idle",
      "model": "workbuddy/deepseek-v4.1-flash", "temperature": 0.0,
      "system_prompt": "<LIBRARIAN_SYSTEM_PROMPT, archetypes.py:237-248>",
      "allowed_tools": ["room_file_save", "room_file_read", "room_file_list", "room_file_move", "read_file", "list_dir", "skill_list", "skill_invoke"],
      "read_only": false, "max_iterations": 30, "timeout_seconds": 120.0
    },
    {
      "id": "explore", "name": "Explore", "role": "worker", "archetype": "explore",
      "label": "Explore", "badge": "🔍", "tagline": "只读代码探索员", "state": "idle",
      "model": "workbuddy/deepseek-v4.1-flash", "temperature": 0.0,
      "system_prompt": "<EXPLORE_SYSTEM_PROMPT, archetypes.py:38-51>",
      "allowed_tools": ["read_file", "list_dir", "grep_search", "find_by_name"],
      "read_only": true, "max_iterations": 15, "timeout_seconds": 120.0
    },
    {
      "id": "plan", "name": "Plan", "role": "worker", "archetype": "plan",
      "label": "Plan", "badge": "📐", "tagline": "架构规划师", "state": "idle",
      "model": "workbuddy/deepseek-v4.1-flash", "temperature": 0.0,
      "system_prompt": "<PLAN_SYSTEM_PROMPT, archetypes.py:74-97>",
      "allowed_tools": ["read_file", "list_dir", "grep_search", "find_by_name"],
      "read_only": true, "max_iterations": 15, "timeout_seconds": 120.0
    },
    {
      "id": "general-purpose", "name": "General", "role": "worker", "archetype": "general-purpose",
      "label": "General", "badge": "⚙️", "tagline": "通用执行代理", "state": "idle",
      "model": "workbuddy/deepseek-v4.1-flash", "temperature": 0.0,
      "system_prompt": "<GENERAL_PURPOSE_SYSTEM_PROMPT, archetypes.py:120-132>",
      "allowed_tools": [], "read_only": false, "max_iterations": 30, "timeout_seconds": 120.0
    },
    {
      "id": "teammate", "name": "Teammate", "role": "worker", "archetype": "teammate",
      "label": "Teammate", "badge": "🧩", "tagline": "协作成员", "state": "idle",
      "model": "workbuddy/deepseek-v4.1-flash", "temperature": 0.0,
      "system_prompt": "<TEAMMATE_SYSTEM_PROMPT, archetypes.py:154-156>",
      "allowed_tools": [], "read_only": false, "max_iterations": 30, "timeout_seconds": 120.0
    }
  ]
}
```

> Long verbatim prompt strings are elided with `<...>` markers only in this example; they are
> real strings in the response. Frontend usage: `id`, `name`, `label`, `badge`, `tagline`,
> `role`, `state`, `model`, `temperature`, `system_prompt`, `allowed_tools`, `read_only`
> (`js/avatars.js`, `js/views/bot.js`, `js/views/settings.js`).

### E08 `GET /api/bots/{id}`

* `{id}` is URL-decoded (`unquote`). Empty id or id containing `/` → **404**
  `{"error": "not found"}`.
* Lookup order (`runtime.get_bot_config`, `runtime.py:1212-1232`):
  1. case-insensitive `chiefrouter|chief|router` → ChiefRouter config.
  2. exact worker id in `runtime.workers`.
  3. exact id in `router.registered_workers`.
  4. archetype alias via `get_archetype(id.lower().strip())` (`general` → `general-purpose`).
  5. otherwise **404** `{"error": "Bot '<id>' not found"}`.
* 200 → one bot object (variant A/B/C depending on which branch matched).

### E09 `PUT /api/bots/{id}`

* **Body:** JSON object, subset of mutable fields. Non-object → **400**
  `{"error": "payload must be a JSON object"}`.
* Unknown bot → **404** `{"error": "Bot '<id>' not found"}` (raised as `KeyError` by
  `update_bot_config`). Missing/empty id or id with `/` → **404** `{"error": "not found"}`.
* Unexpected exception → **500** `{"error": "<exc>"}`.
* Success → 200 with the **fresh full bot config** (same shape as E08) and publishes event
  `bot.<id>.updated` (`sender: "server"`, `payload: <bot config>`).
* Body validation errors (e.g. `temperature: "abc"` → `ValueError`) → **400**
  `{"error": "<ValueError text>"}`.

Accepted fields:

**ChiefRouter** (`runtime.py:1244-1265`):

| Field | Effect |
|---|---|
| `name` (str) | `router.config.name = value.strip()` |
| `badge` (str) | `router.config.extra["badge"] = value.strip()[:8]` |
| `tagline` (str) | `router.config.extra["tagline"] = value.strip()[:80]` |
| `model` (str) | `router.config.model = value.strip()` |
| `temperature` (num) | clamp `max(0.0, min(2.0, float(v)))` |
| `system_prompt` (str) | `router.config.system_prompt = value.strip()` |
| `max_subtasks` (int) | `max(1, int(v))` |
| `max_parallel` (int) | `max(1, int(v))` |
| `allowed_tools` (list) | filtered by `ROUTER_PRESET.allowed_tools`; tools outside the router whitelist are silently dropped; re-mounts |

**Worker** (`runtime.py:1281-1308`):

| Field | Effect |
|---|---|
| `name` (str) | `worker.config.name` |
| `badge` (str) | `worker.config.extra["badge"]`, truncated to 8 chars |
| `tagline` (str) | `worker.config.extra["tagline"]`, truncated to 80 chars |
| `model` (str) | `worker.config.model` (and, if the id is also an archetype, the archetype override) |
| `temperature` (num) | 0.0–2.0 clamp |
| `system_prompt` (str) | replaces `worker.config.system_prompt` **and** `message_history[0]` if it is the system message, else inserts a new system message at index 0 |
| `max_iterations` (int) | `max(1, int(v))` on the mandate (ignored when mandate is `None`) |
| `timeout_seconds` (num) | `max(1.0, float(v))` on the mandate |
| `allowed_tools` (list) | `worker.mount_tools([str(t)...])` then `mandate.allowed_tools = mounted_tools`. **Can only narrow** — a tool not already in the mandate whitelist is silently dropped, and the mandate is then overwritten with the intersection |

**Archetype-only bot (no worker instance)** (`runtime.py:1275-1279, 1310`):

* Only `model` has an effect: it is written to `router.archetype_model_overrides` and
  `config.archetype_model_overrides` under the archetype's `agent_type`.
* **All other fields are ignored.** Response is the archetype config (variant C) with the new
  model (or old model if not provided).
* If the id is *both* an archetype and an active worker, both branches run (archetype override
  + worker mutation) and the worker config is returned.

**Request example:**

```json
{
  "name": "Coder",
  "badge": "🛠",
  "tagline": "工程师 · 写代码改文件",
  "model": "workbuddy/hy3",
  "temperature": 0.2,
  "system_prompt": "你是团队的工程师，负责实现与验证。",
  "allowed_tools": ["read_file", "write_file", "edit_file", "list_dir", "grep_search", "find_by_name", "shell", "skill_list", "skill_invoke"]
}
```

**Response:** the full `coder` bot object with the updated values (200).

---

## 5. Avatars

Storage: `<workspace_root>/.agentharness/avatars/<kind>-<id>.<ext>` (`avatars.py`).
`kind ∈ {"bot","room","user"}`; `id` must match `^[A-Za-z0-9_\-]{1,80}$`.

### E10 `GET /api/avatars`

* 200, builder (`server.py:471-472`, `avatars.py:50-76`):

```json
{
  "avatars": {
    "bot:coder": {
      "url": "/api/avatars/bot/coder?v=1762345262113",
      "version": 1762345262113,
      "mime": "image/png"
    },
    "room:a1b2c3": {
      "url": "/api/avatars/room/a1b2c3?v=1762345261980",
      "version": 1762345261980,
      "mime": "image/jpeg"
    },
    "user:me": {
      "url": "/api/avatars/user/me?v=1762290000001",
      "version": 1762290000001,
      "mime": "image/webp"
    }
  }
}
```

* Key is `"<kind>:<id>"`; `url` already contains the `?v=<version>` cache-buster.
* `version` = file `mtime_ns // 1_000_000`.
* Empty object `{"avatars": {}}` when the directory is missing/empty.
* Files whose stem lacks `-`, has an unknown kind, or an unsafe id are skipped.
* MIME by extension: jpg/jpeg → image/jpeg, png → image/png, webp → image/webp,
  gif → image/gif, otherwise application/octet-stream.

### E11 `GET /api/avatars/{kind}/{id}`

* Path must split into exactly 2 segments after `/api/avatars/` (empty segments are allowed
  through the split and then fail kind/id validation); both are URL-decoded. Any other
  segment count → **404** `{"error": "avatar not found"}`.
* Unknown/empty kind, invalid id, or missing file → **404**
  `{"error": "avatar not found"}`.
* Success → **200 binary** with:

```http
Content-Type: image/png            # resolved by trying jpg, png, webp, gif in that order
Content-Length: <n>
Cache-Control: public, max-age=3600
Access-Control-Allow-Origin: *
Connection: close
```

No JSON body on success.

### E12 `POST /api/avatars/{kind}/{id}`

* **Body:** `{"data": "<base64-or-data-URI>"}`. The string is split on the first comma and
  the remainder is base64-decoded with `validate=True`.
* Validation:
  * kind must be `bot|room|user`, else 400 `{"error": "unknown avatar kind"}`
  * id must match the regex, else 400 `{"error": "invalid avatar id"}`
  * missing/blank data → 400 `{"error": "image data is required"}`
  * bad base64 → 400 `{"error": "image data is not valid base64"}`
  * > 3 MiB decoded → 400 `{"error": "image is too large (max 3 MiB)"}`
  * magic bytes not JPEG/PNG/GIF87a/GIF89a/RIFF-WEBP → 400
    `{"error": "unsupported image format (jpeg/png/webp/gif only)"}`
* On success all other format variants for the same kind/id are deleted, then **201**:

```json
{
  "kind": "bot",
  "id": "coder",
  "url": "/api/avatars/bot/coder?v=1762345262113",
  "version": 1762345262113,
  "mime": "image/png",
  "updated_at": "2026-11-06T01:23:11.421000+00:00"
}
```

* Bad path (not exactly 2 segments) → **404** `{"error": "avatar not found"}`.
* Invalid JSON → no response (socket closed). JSON `null` → `{}` → 400 image-data-required.

### E13 `DELETE /api/avatars/{kind}/{id}`

* Deletes every `<kind>-<id>.*` file.
* Always **200** with `{"removed": true}` or `{"removed": false}` — never 404, even for an
  invalid kind/id.
* Bad path (not exactly 2 segments) → **404** `{"error": "avatar not found"}`.

---

## 6. Skills and hooks

### E14 `GET /api/skills`

* 200, builder (`server.py:593-596`):

```python
{"skills": [skill.to_dict() for skill in skill_manager.list_skills()]}
```

`Skill.to_dict()` (`skills/manager.py:75-84`) — bodies are **never** included:

```json
{
  "skills": [
    {
      "name": "code-review",
      "description": "结构化代码审查：正确性、边界、安全与可维护性",
      "when_to_use": "用户要求 review、审查代码、找 bug 或评估改动质量时调用。",
      "source": "builtin"
    },
    {
      "name": "write-report",
      "description": "把调研/任务结果整理成结构清晰的中文报告",
      "when_to_use": "需要把多项结论汇总成报告、总结、周报或交接文档时调用。",
      "source": "workspace"
    }
  ]
}
```

* `source` is `"builtin"` or `"workspace"`.
* Workspace skills come from `<workspace_root>/.agentharness/skills/<name>/SKILL.md`
  (frontmatter `name`, `description`, `when_to_use`); a workspace skill with the same name
  overrides the builtin.
* Missing manager → `{"skills": []}`.
* Order: builtins (`code-review`, `write-report`) then workspace skills sorted by directory
  glob.

### E15 `GET /api/hooks`

* 200, `hook_engine.to_dict()` (`hooks.py:148-156`):

```json
{
  "config_path": "d:\\能力测试\\agentharness\\.agentharness\\hooks.json",
  "exists": false,
  "last_error": null,
  "PreToolUse": [],
  "PostToolUse": []
}
```

* Each rule is `{"matcher": str, "action": str, "reason": str}`.
* `action` is lower-cased on load (`allow|deny|block|command|...`); `matcher` may be a glob
  or a `|`-separated glob list.
* If `hooks.json` exists and is malformed, the engine installs a fail-closed deny-all rule and
  reports it:

```json
{
  "config_path": "d:\\能力测试\\agentharness\\.agentharness\\hooks.json",
  "exists": true,
  "last_error": "Expecting value: line 1 column 1 (char 0)",
  "PreToolUse": [
    { "matcher": "*", "action": "deny", "reason": "hooks.json 解析失败，拒绝所有工具调用" }
  ],
  "PostToolUse": []
}
```

* No hook engine → `{"PreToolUse": [], "PostToolUse": []}` (note: no `config_path`,
  `exists` or `last_error` in that fallback).

### E16 `POST /api/hooks/reload`

* No body required (body ignored).
* No engine → **404** `{"error": "hook engine not available"}`.
* Otherwise calls `engine.reload()` and returns the same object as E15 (200), now reflecting
  the file on disk.

---

## 7. Rooms

### 7.1 The room object (`CollaborativeGroupRoom.to_dict`, `group.py:747-764`)

This is the exact object returned by E19, E20, each element of E17, and the payload of the
`room.<id>.updated` SSE event:

```json
{
  "room_id": "a1b2c3",
  "title": "产品发布准备",
  "members": ["boss", "coder", "reviewer", "librarian"],
  "owner_id": "boss",
  "parent_room_id": null,
  "topic": "上线前的检查清单",
  "context_policy": "shared",
  "orchestrator_mode": "dispatch",
  "status": "active",
  "relays": 2,
  "message_count": 6,
  "file_count": 1,
  "updated_at": "2026-11-06T01:20:31.442118+00:00",
  "member_permissions": {
    "boss": {
      "can_speak": true,
      "context_access": "full",
      "can_create_subgroup": false,
      "allowed_tool_overrides": null
    },
    "coder": {
      "can_speak": true,
      "context_access": "full",
      "can_create_subgroup": false,
      "allowed_tool_overrides": null
    },
    "reviewer": {
      "can_speak": true,
      "context_access": "full",
      "can_create_subgroup": false,
      "allowed_tool_overrides": null
    },
    "librarian": {
      "can_speak": true,
      "context_access": "full",
      "can_create_subgroup": false,
      "allowed_tool_overrides": null
    }
  }
}
```

Field semantics (`group.py:102-168, 747-764`):

| Key | Type | Notes |
|---|---|---|
| `room_id` | string | 6 lowercase hex chars, generated with `uuid4().hex[:6]` |
| `title` | string | may be `""`; no truncation on creation, `[:80]` on PUT |
| `members` | string[] | bot ids, creation order; **may contain duplicates** if POST had duplicates and `include_roles` was false |
| `owner_id` | string \| null | default `"boss"` only when `include_roles` is true |
| `parent_room_id` | string \| null | set for sub-rooms created by the orchestrator |
| `topic` | string | `""` unless set by PUT or a sub-room |
| `context_policy` | `"shared"` \| `"summary"` \| `"isolated"` | invalid values coerced to `"shared"` at construction |
| `orchestrator_mode` | `"dispatch"` \| `"legacy"` | `"dispatch"` iff `owner_id == "boss"` unless explicitly overridden |
| `status` | `"active"` \| `"paused"` | `"paused"` after circuit breaker trips; a user turn resets to `"active"` |
| `relays` | int | bot turns since the last user turn; `relay_limit = 3 * len(members)` |
| `message_count` | int | `len(in-memory message_log)`; after a restart it is capped by the 1000-row replay |
| `file_count` | int | `len(file_index)` |
| `updated_at` | ISO-8601 string | set at construction and on **every completed turn**; **not** bumped by PUT title/topic/policy changes |
| `member_permissions` | object | `bot_id → {can_speak, context_access, can_create_subgroup, allowed_tool_overrides}` |

**There is no `created_at`, no `files` array, no `messages` array and no `topic_updated_at` in
this object.** (The SQLite `rooms` table does have `created_at`, but it is not exposed by any
API.)

### E17 `GET /api/rooms`

* 200, builder (`server.py:622-623`, `runtime.py:689-697`):

```text
{ "rooms": [ <room object>, ... ] }      # each element is exactly the §7.1 object
```

* Order = `runtime.rooms` dict insertion order (restore order after a restart), **not**
  sorted. The frontend sorts by `updated_at` descending itself (`js/store.js:98`).
* Empty `{"rooms": []}` if none.

### E18 `POST /api/rooms`

* **Body:** JSON object (`server.py:624-642`).
* Validation order:
  1. `members = data.get("members") or []`; must be a **list with length ≥ 2**, else **400**
     `{"error": "members must be a list with at least 2 bot ids"}`.
     (Note: this check happens *before* `include_roles` can add boss/librarian, so the caller
     must always send ≥ 2 ids.)
  2. `runtime.open_room([str(m) for m in members], owner_id=..., title=...,
     context_policy=..., include_roles=bool(...))`.
* Accepted body keys (`server.py:626-638`):

| Key | Type | Default | Semantics |
|---|---|---|---|
| `members` | string[] (required, len ≥ 2) | — | bot ids; any name matching an archetype is lazily materialized as a worker |
| `owner_id` | string \| null | `null` → `"boss"` when `include_roles`, else `null` | must be one of the final members, else 400 |
| `title` | string | `""` | stored verbatim (no `[:80]` on create) |
| `context_policy` | string | `"shared"` (`data.get("context_policy") or "shared"`) | `shared`/`summary`/`isolated`; invalid values are silently coerced to `"shared"` by the room constructor, but the **response echoes the raw request value** |
| `include_roles` | any truthy | `false` | if true: insert `"boss"` at index 0 (unless present), append `"librarian"` (unless present), dedupe preserving order, default owner `"boss"` |

* **There is no `include_librarian` key and no `archetypes` key.** Unknown keys are ignored.
* `open_room` behavior (`runtime.py:502-564`):
  * For each member not already a worker but matching an archetype, create that worker on the
    fly (`_ensure_special_worker`, registers it in `runtime.workers` and
    `router.registered_workers`, giving it a default mandate + skill tools).
  * Generate `room_id = uuid.uuid4().hex[:6]`, retry on collision.
  * `effective_owner = str(owner_id).strip() if owner_id else ("boss" if include_roles else None)`.
  * Owner not among members → **400** `{"error": "Owner '<id>' must be one of the room members."}`.
  * Unknown member names (not a worker, not an archetype) → `create_room` raises `KeyError`
    → **400** `{"error": "Unknown worker(s) for room '<generated_id>': ['<name>']"}`.
  * On success the room is persisted (`rooms` + `room_members`) and event
    `harness.room.created` is published (`payload: {room_id, members, owner_id, title}`,
    `sender: "runtime"`).
* **Response: 201**, built as (`runtime.py:557-564`):

```python
result = {"room_id": room_id, "members": list(self.rooms[room_id].members)}
if include_roles or title or owner_id or context_policy != "shared":
    result.update({
        "owner_id": effective_owner,
        "title": title,
        "context_policy": context_policy,
    })
```

So the minimal plain-room response is **only two keys**; the extra three appear if any of
`include_roles`, non-empty `title`, non-null `owner_id`, or non-default `context_policy` is
present. `owner_id` inside that block may be `null`.

**Request example (what the bundled UI sends, `js/app.js:279-284`):**

```json
{
  "members": ["coder", "reviewer"],
  "include_roles": true,
  "title": "产品发布准备",
  "context_policy": "shared"
}
```

**Response 201:**

```json
{
  "room_id": "a1b2c3",
  "members": ["boss", "coder", "reviewer", "librarian"],
  "owner_id": "boss",
  "title": "产品发布准备",
  "context_policy": "shared"
}
```

**Minimal request:**

```json
{ "members": ["coder", "reviewer"] }
```

**Response 201 (two keys only):**

```json
{ "room_id": "d4e5f6", "members": ["coder", "reviewer"] }
```

Errors: 400 (validation/unknown worker/owner mismatch), no response on malformed JSON (see
§11).

### E19 `GET /api/rooms/{id}`

* `{id}` URL-decoded; missing room → **404** `{"error": "room not found"}`.
* 200 → the room object from §7.1.

### E20 `PUT /api/rooms/{id}`

* Unknown room → **404** `{"error": "room not found"}` (checked before body parsing).
* Non-object body → **400** `{"error": "payload must be a JSON object"}`.
* Applies fields **sequentially in this exact order** (`server.py:742-787`):

| Order | Field | Accepted type | Merge semantics |
|---|---|---|---|
| 1 | `title` | string | replace, `value.strip()[:80]` (silently ignored if not a string) |
| 2 | `topic` | string | replace, `value.strip()[:200]` |
| 3 | `member_permissions` | object | per-member partial update; only members already in `room.members`; only these sub-keys are honored: `can_speak`, `context_access`, `can_create_subgroup`, `allowed_tool_overrides`. Other members/keys silently skipped. `context_access` must be `full|summary|none`, otherwise the old value is kept (no error). A `KeyError`/`ValueError` from `set_permission` aborts with 400. |
| 4 | `add_members` | array | for each id: `str(...).strip()`; skip empty/existing; unknown worker → **400** `{"error": "Unknown worker '<id>'"}`; otherwise append to `members` **and** to `speaking_slots`, register the worker session, and create a default permission record. Duplicate ids in the array are skipped after the first. |
| 5 | `context_policy` | anything stringified | `room.set_context_policy(str(value))`; invalid → **400** `{"error": "Invalid context policy '<p>'. Valid: ('shared', 'summary', 'isolated')"}` |

* There is **no `remove_members`** support; such a key is ignored. There is no `members`
  replacement support. `owner_id` cannot be changed. `status` cannot be set.
* After all fields: `runtime._persist_room(room)` (rewrites the SQLite row + members), then
  publishes `room.<room_id>.updated` with `payload = room.to_dict()`, `sender = "server"`,
  and returns **200** `room.to_dict()`.
* **Non-atomic:** because changes are applied before the first failing step, a request that
  fails at step 3/4/5 can leave earlier fields (and even earlier `add_members` entries)
  mutated in memory. `_persist_room` and the SSE event are **not** executed on failure.
* `member_permissions` persistence: `set_permission` writes the whole member map to SQLite and
  emits `room.<id>.permission_changed` (`{member, permissions}`) on each member.
* `context_policy` change emits `room.<id>.context_policy_changed` (`{policy}`) from
  `set_context_policy`, so a successful PUT can emit **two** SSE events
  (`context_policy_changed`, then `updated`).

**Request example:**

```json
{
  "title": "发布检查",
  "topic": "上线前 24 小时",
  "context_policy": "summary",
  "member_permissions": {
    "coder": { "can_speak": true, "context_access": "summary" },
    "reviewer": { "can_create_subgroup": true }
  },
  "add_members": ["explore"]
}
```

**Response 200:** the full room object (§7.1), e.g. `members` now
`["boss","coder","reviewer","librarian","explore"]`, `topic` `"上线前 24 小时"`,
`context_policy` `"summary"`, and the merged permissions.

### E21 `GET /api/rooms/{id}/messages`

* Path: `/api/rooms/{id}/messages`; `{id}` URL-decoded. Empty id, id containing `/`, or a
  room not in `runtime.rooms` → **404** `{"error": "room not found"}`.
* **Query:** `after_seq` (default `0`, negative clamped to `0`), `limit` (default `500`,
  clamped to `[0, 5000]`; `limit=0` returns `[]`). Non-numeric values fall back to defaults.
* Data source: `store.list_room_messages(room_id, after_seq, limit)` — SQLite, ascending
  `seq`, per-room monotonic `seq` starting at 1.
* 200 builder:

```python
{"room_id": room_id, "messages": messages}
```

Each message (`store.py:1160-1180`):

```json
{
  "seq": 1,
  "speaker": "user",
  "content": "请群主分派：整理上线检查清单",
  "kind": "user",
  "ts": "2026-11-06T01:20:02.113000+00:00"
}
```

* `kind` values written by the room: `user`, `assistant`, `tool`, `result`, `user_visible`,
  `notice`, legacy `message`.
* `ts` is an ISO-8601 UTC string (from `datetime.now(timezone.utc).isoformat()`).
* If the DB read throws, the route swallows it and returns `{"room_id": id, "messages": []}`.

**Example:**

```json
{
  "room_id": "a1b2c3",
  "messages": [
    { "seq": 1, "speaker": "user", "content": "请群主分派：整理上线检查清单", "kind": "user", "ts": "2026-11-06T01:20:02.113000+00:00" },
    { "seq": 2, "speaker": "boss", "content": "已派发给 coder 和 reviewer，等待回报。", "kind": "user_visible", "ts": "2026-11-06T01:20:14.882000+00:00" },
    { "seq": 3, "speaker": "coder", "content": "清单草稿已放到群文件 space/files/release-checklist.md。", "kind": "assistant", "ts": "2026-11-06T01:20:41.201000+00:00" }
  ]
}
```

### E22 `GET /api/rooms/{id}/files`

* `{id}` decoded; empty id, id with `/`, or unknown room → **404**
  `{"error": "room not found"}`.
* 200 builder (`server.py:665-672`):

```python
files = [entry.to_dict() for entry in room.file_index.values()]
{"room_id": room_id, "files": files}
```

Each entry (`group.py:92-99`):

```json
{
  "file_id": "9f3c1a7b",
  "path": "d:\\能力测试\\agentharness\\rooms\\a1b2c3\\files\\reports\\release-checklist.md",
  "description": "上线检查清单",
  "tags": ["report", "release"],
  "updated_at": "2026-11-06T01:21:12.554000+00:00"
}
```

* `path` is absolute (room file space:
  `<workspace_root>/rooms/<room_id>/files/<relative>`), resolved at save time.
* `file_id` = `uuid4().hex[:8]` assigned by `room_file_save`.
* Order = dict insertion order (restored from SQLite `updated_at ASC` on startup).
* Local files saved by tools are `upsert_file`d into this index; there is no HTTP upload
  endpoint for room files.

### E23 `GET /api/rooms/{id}/files/{file_id}`

* Parsing: everything after `/api/rooms/` is split on the first `/files/`; both parts are
  URL-decoded. Empty room/file, a `/` in either part, or unknown room → **404**
  `{"error": "room or file not found"}`. Unknown `file_id` → **404**
  `{"error": "file not found"}`.
* Path safety: `os.path.realpath(entry.path)` must be inside
  `os.path.realpath(runtime.workspace_root)` and be a file, else **404**
  `{"error": "file is outside the workspace or missing"}`.
* Text detection: extension in
  `.md .txt .json .py .js .mjs .ts .tsx .jsx .html .css .yml .yaml .csv .log .sh .ps1 .toml .ini .cfg .xml .svg`
  → read UTF-8 with `errors="replace"` up to **200,000 characters**; other extensions are
  `binary: true` with `content: ""`.
* 200 builder (`server.py:713-724`):

```json
{
  "room_id": "a1b2c3",
  "file_id": "9f3c1a7b",
  "path": "d:\\能力测试\\agentharness\\rooms\\a1b2c3\\files\\reports\\release-checklist.md",
  "description": "上线检查清单",
  "tags": ["report", "release"],
  "updated_at": "2026-11-06T01:21:12.554000+00:00",
  "size": 3841,
  "binary": false,
  "truncated": false,
  "content": "# 上线检查清单\n\n- [ ] 回滚方案确认\n..."
}
```

* `size` = on-disk bytes; `truncated` = `size > 200000` (only meaningful for text files).
* Read failure → **500** `{"error": "read failed: <OSError>"}`.

### E24 `POST /api/rooms/{id}/say`

* **Body:** `{"content": "<non-empty string>"}`. Extra keys ignored.
* Behavior (`server.py:788-806`, `runtime.py:674-687`):
  1. Decode `{id}` from the path (strip the trailing `/say`); empty → **404**
     `{"error": "room not found"}`.
  2. **Validate content first**: missing/blank/non-string → **400**
     `{"error": "content is required"}` — even if the room does not exist.
  3. `runtime.room_say(room_id, content)`:
     * unknown room → **404** `{"error": "Unknown room '<room_id>'."}`
     * otherwise: `room.pending_rounds += 1`, `room.round_idle.clear()`, spawn
       `run_room_round(room, content)` as a fire-and-forget background task, and return
       **immediately**.
  4. **Response: 200** `{"status": "accepted", "room_id": "<room_id>"}`.
* The round is **not** awaited. The user turn, per-member turns, and completion are delivered
  via SSE (`room.<id>.turn_completed`, `round_started`, `member_started/finished`,
  `round_completed`) and persisted to `room_messages` / `events`.
* `content` becomes the room's user turn (`advance_turn(is_user=True)`), which resets
  `relays` to 0 and sets `status = "active"`.
* There is no idempotency/dedup: each call starts another round.

**Example request:**

```json
{ "content": "请群主分派：整理上线检查清单，coder 出稿，reviewer 复核" }
```

**Example response (200, immediate):**

```json
{ "status": "accepted", "room_id": "a1b2c3" }
```

### 7.2 Room lifecycle details relevant to the API

* **Membership & permissions.** Every member gets a `MemberPermission`
  (`{can_speak: true, context_access: "full", can_create_subgroup: false,
  allowed_tool_overrides: null}`) at room construction. Muted members (`can_speak: false`) are
  skipped in rounds; `context_access` restricts what the member sees (`full|summary|none`);
  `isolated` policy forces level `none`.
* **Circuit breaker.** `relay_limit = 3 * len(members)`; each non-user `advance_turn`
  increments `relays`. When `relays >= relay_limit`, `status = "paused"` and the round stops
  (event `room.<id>.circuit_breaker_tripped {relays, limit}`). The next user turn resets it
  (`room.<id>.circuit_breaker_reset {reset_by}`).
* **Persistence.** `_persist_room` writes `rooms` + `room_members` (replacing the member set).
  Room messages are appended per turn into `room_messages`. On restart `load_rooms` recreates
  rooms, members, file index, and replays up to 1000 messages into memory.
* **`updated_at` is only bumped by `advance_turn`** (i.e. an actual message/turn), not by
  title/topic/policy edits or membership changes.

---

## 8. Tickets, threads, tasks

Enums (`core/models.py`):

* `TicketState`: `queued`, `working`, `blocked`, `failed`, `ready`, `dropped`, `ended`.
* `ThreadStatus`: `idle`, `evaluating`, `active`.

> E25 (`GET /api/thread/{thread_id}/events`) and E26 (`GET /api/events` SSE) are documented
> in §9; they are grouped there because they share the event envelope.

### E27 `GET /api/tickets`

* No params. `runtime.store.list_tickets(limit=50)` ordered by `created_at DESC`.
* 200 → **JSON array** (not wrapped), builder (`server.py:391-398`):

```python
[
  {"id": t.id,
   "state": t.state.value,
   "title": t.title,
   "thread_id": t.thread_id,
   "outcome": t.outcome.summary if t.outcome else None,
   "created_at": t.created_at.isoformat()}
  ...
]
```

**Example:**

```json
[
  {
    "id": "9c4f0b0d7e2a4f0f8c1d2e3f4a5b6c7d",
    "state": "ready",
    "title": "给团队做一次发布前检查",
    "thread_id": "4f2a9c1e8b7d4a6e9f0a1b2c3d4e5f60",
    "outcome": "已完成 3 个子任务并汇总：回滚方案、检查清单、验收记录。",
    "created_at": "2026-11-06T01:19:02.221110+00:00"
  },
  {
    "id": "1a2b3c4d5e6f708192a3b4c5d6e7f809",
    "state": "working",
    "title": "调研竞品发布流程",
    "thread_id": "7c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
    "outcome": null,
    "created_at": "2026-11-06T01:24:55.009381+00:00"
  }
]
```

### E28 `GET /api/threads`

* No params. `runtime.store.list_threads(limit=50)` ordered by `updated_at DESC`.
* 200 → **JSON array** (`server.py:399-405`):

```python
[{"id": t.id, "source_id": t.source_id, "status": t.status.value,
  "subscriptions": t.subscriptions}]
```

**Example:**

```json
[
  {
    "id": "4f2a9c1e8b7d4a6e9f0a1b2c3d4e5f60",
    "source_id": "cli",
    "status": "active",
    "subscriptions": ["9c4f0b0d7e2a4f0f8c1d2e3f4a5b6c7d"]
  },
  {
    "id": "7c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
    "source_id": "cli",
    "status": "idle",
    "subscriptions": []
  }
]
```

`source_id` is `"cli"` for HTTP-submitted tasks (`runtime.submit_task` uses
`source_id="cli"`, `actor_id="user"`).

### E29 `POST /api/task`

* **Body:** `{"prompt": "<non-empty string>"}`; extra keys ignored.
* Missing/empty/falsy prompt (`data.get("prompt", "")` falsy) → **400**
  `{"error": "prompt is required"}`. A **truthy non-string** prompt (e.g. `5`, `["x"]`) is
  passed through to `submit_task` and normally raises inside model validation → **no
  response** (socket closed), see §11.2.
* Calls `await runtime.submit_task(prompt, wait=False)`:
  * `engine.admit_trigger(source_id="cli", actor_id="user", content=prompt)` creates a Trigger
    row and **reuses an existing ACTIVE thread for source `cli`** if one exists, otherwise
    creates a new IDLE `Thread`;
  * fast path: if that thread already has a subscribed ticket in `working`/`ready`,
    `submit_task` reuses it and delivers the prompt to its worker; otherwise a new Ticket is
    created with `title = prompt[:60]`, `description = prompt`, default mandate,
  * publishes `harness.task.submitted {ticket_id, thread_id, prompt}`,
  * spawns the router execution in the background and returns immediately.
* **Response: 202** `{"ticket_id": "<id>", "thread_id": "<id>"}`.
* No response if the JSON body is invalid or not an object (`AttributeError` on
  `data.get`), see §11.

**Example request:**

```json
{ "prompt": "给团队做一次发布前检查，输出检查清单和回滚方案" }
```

**Example response:**

```json
{
  "ticket_id": "9c4f0b0d7e2a4f0f8c1d2e3f4a5b6c7d",
  "thread_id": "4f2a9c1e8b7d4a6e9f0a1b2c3d4e5f60"
}
```

---

## 9. Events: SSE stream and replay

### 9.1 `GET /api/events` (E26) — SSE

Handshake headers (`server.py:878-888`):

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Access-Control-Allow-Origin: *
Connection: keep-alive
```

No `Content-Length`, no charset, no `retry:`.

**Frame format (`server.py:900-913`):**

```python
data = json.dumps({
    "topic": event.topic,
    "sender": event.sender,
    "payload": event.payload,
}, ensure_ascii=False, default=str)
writer.write(f"data: {data}\n\n".encode("utf-8"))
```

* Exactly `data: ` (one space after the colon) + compact JSON + `\n\n`.
* The JSON object has **only three keys**: `topic`, `sender`, `payload`.
  There is **no `seq`, `ts`, `thread_id`, `id`, `event:` or `retry:`**.
* Idle keepalive every **15.0 s**: the comment frame `: keepalive\n\n`.
* Because no `event:` field is sent, every frame is an **unnamed** SSE event and is delivered
  to `EventSource.onmessage` — exactly what `js/api.js:77-85` uses. There is no `retry:`
  field, so the browser uses its default reconnect delay after a disconnect.
* Subscription = `runtime.event_bus.subscribe("**")`, i.e. **every** event published on the
  bus, including those with `thread_id = NULL`.
* Payloads are arbitrary JSON; non-serializable values are `str()`-ed.
* The stream never ends on its own; client disconnect raises inside the writer, the collector
  task is cancelled, and the socket closes.
* No replay/backfill on connect: events published before the connection are lost unless
  fetched via E25.

**Example session (raw frames):**

```text
data: {"topic":"harness.lifecycle.started","sender":"runtime","payload":{}}

data: {"topic":"harness.task.submitted","sender":"runtime","payload":{"ticket_id":"9c4f0b0d7e2a4f0f8c1d2e3f4a5b6c7d","thread_id":"4f2a9c1e8b7d4a6e9f0a1b2c3d4e5f60","prompt":"给团队做一次发布前检查"}}

data: {"topic":"room.a1b2c3.round_started","sender":"group_room","payload":{"instruction":"请群主分派：整理上线检查清单","members":["boss","coder","reviewer","librarian"],"orchestrator_mode":"dispatch"}}

data: {"topic":"room.a1b2c3.member_started","sender":"group_room","payload":{"member":"boss"}}

data: {"topic":"room.a1b2c3.turn_completed","sender":"group_room","payload":{"speaker":"boss","content":"已派发给 coder 和 reviewer。","kind":"user_visible","relays":1,"timestamp":"2026-11-06T01:20:14.882000+00:00"}}

: keepalive

data: {"topic":"room.a1b2c3.turn_completed","sender":"group_room","payload":{"speaker":"coder","content":"清单草稿已放到群文件。","kind":"assistant","relays":2,"timestamp":"2026-11-06T01:20:41.201000+00:00"}}

data: {"topic":"room.a1b2c3.member_finished","sender":"group_room","payload":{"member":"coder"}}

data: {"topic":"room.a1b2c3.round_completed","sender":"group_room","payload":{"speakers":["boss","coder","reviewer"],"paused":false,"spawned_children":[]}}

data: {"topic":"context.stats.updated","sender":"ChiefRouter","payload":{"thread_id":"4f2a…","bot_id":"ChiefRouter","active_tokens":18432,"usage_percentage":1.84,"distribution":{"system":3120,"user":4021,"assistant":6807,"tool":4484},"last_turn":{"prompt_tokens":5120,"completion_tokens":640,"cache_read_tokens":1200,"cache_hit_rate":0.1899}}}
```

Event topics the bundled frontend reduces (`js/store.js:383-607`) and the room/file/hook
topics the backend publishes are catalogued in §10.

### 9.2 `GET /api/thread/{thread_id}/events` (E25) — persisted replay

* Path parsing: the segment between `/api/thread/` and the trailing `/events` is
  URL-decoded. Empty or containing `/` → **404** `{"error": "not found"}`.
  (There is **no** existence check: an unknown thread id returns 200 with an empty list.)
* **Query:** `after_seq` (default `0`, negative → `0`), `limit` (default `500`, clamped
  `[0, 5000]`; `limit=0` → `[]`). Non-numeric values fall back to defaults.
* Data source: `store.list_events(thread_id, after_seq, limit)` — SQLite `events` table,
  `WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`. DB failures are swallowed and
  yield `events: []` (the endpoint still returns 200).
* 200 builder (`server.py:807-829`):

```python
{"thread_id": thread_id, "events": events}
```

Each event (`store.py:996-1005`) has **six** keys:

```json
{
  "seq": 41,
  "ts": 1762345262.113,
  "topic": "room.a1b2c3.round_started",
  "sender": "group_room",
  "payload": {
    "instruction": "请群主分派：整理上线检查清单",
    "members": ["boss", "coder", "reviewer", "librarian"],
    "orchestrator_mode": "dispatch"
  },
  "thread_id": "room:a1b2c3"
}
```

* `seq` is the **global** `events.seq` (`INTEGER PRIMARY KEY AUTOINCREMENT`) — gaps are
  normal for a single thread; use it as the pagination cursor.
* `ts` is a **float epoch seconds** (from `time.time()`), not ISO-8601.
* `payload` is always a JSON object; if a stored payload was a scalar it is wrapped as
  `{"value": <scalar>}`.
* Full example response:

```json
{
  "thread_id": "room:a1b2c3",
  "events": [
    {
      "seq": 37,
      "ts": 1762345202.113,
      "topic": "room.a1b2c3.turn_completed",
      "sender": "group_room",
      "payload": {
        "speaker": "user",
        "content": "请群主分派：整理上线检查清单",
        "kind": "user",
        "relays": 0,
        "timestamp": "2026-11-06T01:20:02.113000+00:00"
      },
      "thread_id": "room:a1b2c3"
    },
    {
      "seq": 38,
      "ts": 1762345214.882,
      "topic": "room.a1b2c3.round_started",
      "sender": "group_room",
      "payload": {
        "instruction": "请群主分派：整理上线检查清单",
        "members": ["boss", "coder", "reviewer", "librarian"],
        "orchestrator_mode": "dispatch"
      },
      "thread_id": "room:a1b2c3"
    },
    {
      "seq": 39,
      "ts": 1762345215.004,
      "topic": "room.a1b2c3.member_started",
      "sender": "group_room",
      "payload": { "member": "boss" },
      "thread_id": "room:a1b2c3"
    }
  ]
}
```

**How `thread_id` is assigned to persisted events** (`runtime.py:739-787`):

1. `payload.thread_id` if present and non-null;
2. else if `payload.ticket_id` exists, look up the ticket's `thread_id`;
3. else if the topic starts with `room.`, use `room:<parts[1]>` (the room id);
4. else if a `router.goal_received` was seen in this process and the topic starts with
   `router.`, `agent.`, `worker.`, `tools.` or `engine.` (and does not end in
   `.heartbeat`), use the most recent router thread;
5. otherwise the event is stored with `thread_id = NULL` and is **not** replayable by this
   endpoint (it is still streamed over SSE).

Examples: room events → `room:<room_id>`; `harness.task.submitted` and final
`harness.task.*` → the ticket's thread id; `harness.room.created`, `harness.settings.updated`,
`bot.<id>.updated`, `harness.lifecycle.started`, `hooks.*`, `skills.*` → usually `NULL`.

The bundled UI calls this endpoint as
`/api/thread/room%3A<room_id>/events?after_seq=0&limit=2000`
(`js/api.js:47-48`) and falls back to E21 when the list is empty (`js/store.js:175-186`).

---

## 10. Event catalogue (topics + payload keys)

Payloads are plain JSON objects; these are the keys the producers write.

### Room (`sender: "group_room"` unless noted)

| Topic | Payload keys |
|---|---|
| `room.<id>.round_started` | `instruction` (≤500 chars), `members` (string[]), `orchestrator_mode` |
| `room.<id>.round_completed` | `speakers` (string[]), `paused` (bool), `spawned_children` (string[]) |
| `room.<id>.member_started` | `member` |
| `room.<id>.member_finished` | `member` |
| `room.<id>.turn_completed` | `speaker`, `content`, `kind`, `relays`, `timestamp` |
| `room.<id>.assistant_message` | `speaker`, `content`, `kind: "user_visible"` |
| `room.<id>.task_assigned` | `member`, `task` (≤400 chars) |
| `room.<id>.permission_changed` | `member`, `permissions` (the 4-field object) |
| `room.<id>.context_policy_changed` | `policy` |
| `room.<id>.file_saved` | `file_id`, `path`, `description` — **sender `room_files`** |
| `room.<id>.file_moved` | `file_id`, `old_path`, `new_path` |
| `room.<id>.member_mentioned` | `speaker`, `mentioned` |
| `room.<id>.circuit_breaker_reset` | `reset_by` |
| `room.<id>.circuit_breaker_tripped` | `relays`, `limit` |
| `room.<id>.late_reply_deferred` | `speaker`, `content`, `kind`, `timestamp` |
| `room.<id>.subgroup_report` | `sub_room_id`, `topic`, `report` (≤2000 chars) |
| `room.<id>.child_spawned` | `parent_room_id`, `session_id`, `title`, `members` |
| `room.<id>.updated` | full room object (§7.1) — **sender `server`**, emitted by E20 |
| `room.<id>.orchestrator_no_announcement` | `member` |

### Harness / tasks

| Topic | Payload keys |
|---|---|
| `harness.lifecycle.started` | `{}` |
| `harness.task.submitted` | `ticket_id`, `thread_id`, `prompt` |
| `harness.task.<state>` | `ticket_id`, `thread_id`, `outcome` (summary string) |
| `harness.task.completed` | `ticket_id`, `outcome` |
| `harness.room.created` | `room_id`, `members`, `owner_id`, `title` |
| `harness.settings.updated` | full settings object (§E04) |
| `bot.<bot_id>.updated` | full bot config (§E07) |
| `session.child.completed` | `parent_session_id`, `session_id`, `title`, `status: "completed"` |

### Agent / worker / router / context

| Topic | Payload keys |
|---|---|
| `worker.<bot>.turn_started` | `instruction` (sender = bot id) |
| `worker.<bot>.turn_completed` | `output` (sender = bot id) |
| `agent.<id>.state_changed` | `old_state`, `new_state` (sender = agent id) |
| `agent.<id>.tool_invoked` | `tool`, `args`, `tool_use_message`, `is_concurrency_safe` (sender = agent id) |
| `agent.<id>.tool_result` | `tool`, `success`, `error`, `tool_result_message` (sender = agent id) |
| `router.goal_received` | `prompt`, `ticket_id`, `thread_id` (sender = `ChiefRouter`) |
| `router.plan_decomposed` | `goal` (≤200 chars), `subtasks`: array of `{id, description (≤200), archetype, depends_on}` |
| `router.subtask.dispatched` | `work_id`, `subtask_id`, `to_bot`, `archetype`, `description` (≤200), `ticket_id` (nullable) |
| `router.subtask.completed` | `work_id`, `subtask_id`, `to_bot`, `result` (≤400), `ticket_id` (nullable) |
| `router.subtask.failed` | `work_id`, `subtask_id`, `to_bot`, `error`, `ticket_id` (nullable) |
| `router.synthesis_delta` | `delta` |
| `router.synthesis_completed` | `summary` |
| `context.stats.updated` | `thread_id`, `bot_id`, `active_tokens`, `usage_percentage`, `distribution`, `last_turn{prompt_tokens, completion_tokens, cache_read_tokens, cache_hit_rate}` (sender = `ChiefRouter`) |
| `hooks.post_tool_use` | `tool`, `args`, `success`, `action` (sender = `hook_engine`) |
| `skills.invoked` | `name`, `source` (sender = `skill_manager`) |
| `engine.ticket.launch` / `engine.assignment.delivery` / `engine.ticket.reply` / `engine.thread.assessment` | effect payload (sender = `engine`) |

---

## 11. Error catalogue and failure modes

### 11.1 Deliberate error responses

All bodies are `{"error": "<message>"}`.

| Status | Message | Where |
|---|---|---|
| 400 | `prompt is required` | E29 |
| 400 | `payload must be a JSON object` | E05, E09, E20 |
| 400 | `members must be a list with at least 2 bot ids` | E18 |
| 400 | `content is required` | E24 |
| 400 | `A room needs at least 2 members, got <n>.` | E18 (unreachable through the route's own ≥2 check) |
| 400 | `Unknown worker(s) for room '<room_id>': [<ids>]` | E18 |
| 400 | `Owner '<id>' must be one of the room members.` | E18 |
| 400 | `Unknown worker '<id>'` | E20 `add_members` |
| 400 | `Invalid context policy '<p>'. Valid: ('shared', 'summary', 'isolated')` | E20 |
| 400 | `unknown avatar kind` / `invalid avatar id` / `image data is required` / `image data is not valid base64` / `image is too large (max 3 MiB)` / `unsupported image format (jpeg/png/webp/gif only)` | E12 |
| 400 | `<ValueError text>` | E05, E09 (bad numeric conversion), E20 (`set_permission`) |
| 404 | `not found` | any unmatched route; E08/E09 malformed bot id; E25 malformed thread id |
| 404 | `avatar not found` | E11, E12 (malformed path), E13 (malformed path) |
| 404 | `room not found` | E19, E20, E21, E22, E24 (empty id) |
| 404 | `room or file not found` | E23 malformed path |
| 404 | `file not found` | E23 unknown file_id |
| 404 | `file is outside the workspace or missing` | E23 |
| 404 | `Bot '<id>' not found` | E08, E09 |
| 404 | `Unknown room '<room_id>'.` | E24 unknown room |
| 404 | `hook engine not available` | E16 |
| 500 | `Failed to update settings: <exc>` | E05 |
| 500 | `<exc>` | E09 unexpected |
| 500 | `read failed: <OSError>` | E23 |

### 11.2 Silent failures (no HTTP response)

The whole route dispatch is wrapped in `try/except Exception` that only logs at DEBUG and then
closes the socket (`server.py:846-853`). The client sees a connection reset / empty reply, not
an HTTP error. This happens for:

* **Invalid JSON** in any request body (`json.loads` raises) — E05, E09, E12, E18, E20, E24, E29.
* **Invalid UTF-8** in the body (`body.decode("utf-8")`).
* **JSON that is not an object where the handler calls `.get` without a type check** —
  E18 (`data.get("members")` on a list/string/number), E24, E29, E12. (E05/E09/E20 explicitly
  check `isinstance(data, dict)` and return 400 instead.)
* Any unexpected exception in a handler: e.g. `runtime.submit_task` raising
  `RuntimeError("HarnessRuntime is not running...")` (E29), DB errors in
  E27/E28/E17, `list_bot_configs` failure (E07), avatar I/O errors not mapped to
  `ValueError` (E12), etc.

A Node re-implementation should prefer explicit 400/500 JSON here, but clients written against
the Python server already treat an aborted fetch as a network error.

### 11.3 HTTP status semantics

* `200` — success (also DELETE-avatar "not removed", and E25 for unknown threads).
* `201` — E12 avatar upload, E18 room creation.
* `202` — E29 task accepted.
* `204` — OPTIONS only.
* `400`, `404`, `500` — as tabulated.
* The status **line** always says `OK`; do not parse it.

---

## 12. Re-implementation checklist / gotchas

1. **Reason phrase `OK` is always sent.** Node's `http.ServerResponse` emits standard phrases;
   that is fine for all known clients (`js/api.js` uses `res.ok`, `EventSource` uses the code).
2. **Body must be read via `Content-Length`.** No chunked. Fetch/XHR always send
   `Content-Length` for a string body.
3. **`Connection: close`** on every JSON response. The SSE response uses `keep-alive`.
4. **CORS wildcard** on every response, plus the global `OPTIONS` 204.
5. **No auth, no cookies, no CSRF protection.**
6. **Path matching is exact**: `/api/rooms/x/` (trailing slash), `/index.html`,
   `/js/app.js` are 404. Only `/`, `/static/*`, `/favicon.ico` serve files.
7. **SSE has no ids/seq/ts/thread_id.** Implement `data: {topic,sender,payload}\n\n` and a
   `: keepalive\n\n` comment every 15 s. Do not append `event:`/`id:` lines unless you also
   update the frontend (it ignores them, so they are harmless but unnecessary).
8. **Room replay lives under `thread_id = "room:<room_id>"`.** The frontend URL-encodes the
   colon (`room%3A...`); the server must decode path segments before lookup.
9. **`seq` semantics differ:** room messages are per-room (`1..N`); events are global
   autoincrement. Both endpoints take `after_seq` + `limit` with the same clamps.
10. **`ts` types differ:** room messages = ISO string; events = float epoch seconds.
11. **Bot configs are polymorphic** (chief / worker / archetype). All three share
    `id,name,role,archetype,label,badge,tagline,state,model,temperature,system_prompt,
    allowed_tools,read_only`; chief additionally has `max_subtasks,max_parallel`; worker and
    archetype have `max_iterations,timeout_seconds`. Workers have **no** `max_subtasks`.
12. **`allowed_tools` is not `tools`.** The UI reads `allowed_tools`; `general-purpose` and
    `teammate` return `[]` on a cold start.
13. **Room object lacks `created_at`/`files`/`messages`.** Don't add keys that change types;
    adding extra keys is safe for the current UI.
14. **`POST /api/rooms` requires ≥ 2 `members` even with `include_roles: true`**, and the key
    is `include_roles` (not `include_librarian`). Owner defaults to `boss` only in that mode.
15. **The create-room response is deliberately minimal** (`room_id`, `members`, plus
    owner/title/policy conditionally). The UI reads `res.room_id` (`js/app.js:279-286`) and,
    in one toast, `res.owner_id` (`js/main.js:291-303`).
16. **PUT room is sequential and can partially apply** before returning 400. Consider
    validating first in Node; if you want byte-compatible behavior, mutate in the same order.
17. **PUT room has no remove-members / reorder / owner change.** `add_members` appends and
    also appends to `speaking_slots`.
18. **`room.updated_at` is only bumped by turns**, not edits — the room list ordering may look
    stale after a rename.
19. **`POST /say` validates content before room existence**; unknown-room + empty content is
    400, not 404.
20. **`POST /say` returns immediately** with `{"status":"accepted","room_id":...}`; the round
    runs in the background and is observable only through SSE / message rows.
21. **Delete avatar never 404s**; it returns `{"removed": false}`.
22. **`/api/hooks` fallback (no engine) omits `config_path`/`exists`/`last_error`.**
23. **`/api/models` probes the gateway for ≤2 s with no Authorization header**, and falls back
    to the two hard-coded models with `is_fallback: true`.
24. **`/api/settings` PUT cannot change the active model per bot**; bot configs keep their own
    `model` strings until E09 is called.
25. **Bot PUT `allowed_tools` can only narrow** the existing mandate; add new tools by
    extending mandates in code.
26. **Room creation can materialize archetype workers**, which changes subsequent
    `/api/bots` output for those ids (worker variant instead of archetype variant).
27. **Frontend boot tolerates failures** (`Promise.allSettled`, `js/store.js:69-86`), so a
    Node port may initially omit E27/E28/E10–E13/E25 without breaking the shell — but the
    room replay path needs E25 (or E21 as fallback) and the message pane needs E21.
28. **`workspace_root` is a Windows path with backslashes and Chinese characters.** JSON
    escaping must be correct; the UI displays it verbatim in settings.
29. **Static root is resolved from the server file's own location**, three levels up +
    `frontend/web` (Python layout). In Node, point it at the copied `web/` directory.
30. **No pagination on E27/E28** (hard-coded 50) and **no filters**; adding query params is
    safe but the UI won't use them.

---

## Appendix A — literal builders quoted from the Python source

### A.1 `/api/health` (`server.py:383-390`)

```python
{
    "status": "ok",
    "model": runtime.model_name,
    "workspace_root": runtime.workspace_root,
    "gateway_url": getattr(runtime.llm, "base_url", None)
                   or getattr(getattr(runtime.llm, "config", None), "base_url", None),
}
```

### A.2 `/api/tickets` (`server.py:391-398`)

```python
[
    {"id": t.id, "state": t.state.value, "title": t.title,
     "thread_id": t.thread_id, "outcome": t.outcome.summary if t.outcome else None,
     "created_at": t.created_at.isoformat()}
    for t in runtime.store.list_tickets(limit=50)
]
```

### A.3 `/api/threads` (`server.py:399-405`)

```python
[
    {"id": t.id, "source_id": t.source_id, "status": t.status.value,
     "subscriptions": t.subscriptions}
    for t in runtime.store.list_threads(limit=50)
]
```

### A.4 `/api/models` (`server.py:464-470`)

```python
{
    "object": "list",
    "data": data_list,
    "current_model": runtime.model_name,
    "gateway_url": gw_url,
    "is_fallback": is_fallback,
}
```

### A.5 `/api/avatars` (`server.py:471-472`, `avatars.py:71-75`)

```python
{"avatars": avatar_store.list_avatars(runtime.workspace_root)}
# element: {"url": f"/api/avatars/{kind}/{ident}?v={version}",
#           "version": version, "mime": mime}
```

`POST` result (`avatars.py:112-119`):

```python
{"kind": kind, "id": safe_ident,
 "url": f"/api/avatars/{kind}/{safe_ident}?v={version}",
 "version": version, "mime": mime,
 "updated_at": datetime.now(timezone.utc).isoformat()}
```

`DELETE` result (`server.py:520-521`):

```python
{"removed": bool(removed)}
```

### A.6 `/api/skills` (`server.py:593-596`)

```python
{"skills": manager.list_skills()}
# element: {"name", "description", "when_to_use", "source"}
```

### A.7 `/api/hooks` (`hooks.py:150-156`)

```python
{
    "config_path": str(self.config_path),
    "exists": self.config_path.is_file(),
    "last_error": self.last_error,
    "PreToolUse": [r.to_dict() for r in self.pre_rules],
    "PostToolUse": [r.to_dict() for r in self.post_rules],
}
# rule: {"matcher": str, "action": str, "reason": str}
```

### A.8 `/api/context` (`runtime.py:1367-1388`)

```python
{
    "thread_id": thread_id,
    "model": self.model_name,
    "max_context_tokens": max_context_tokens,
    "compact_threshold_tokens": compact_threshold_tokens,
    "active_tokens": total_active_tokens,
    "usage_percentage": usage_pct,
    "distribution": distribution,
    "tokens_total": {
        "prompt": prompt_tokens, "completion": comp_tokens,
        "cache_read": cache_read_tokens, "cache_write": cache_write_tokens,
        "cache_hit_rate": cache_hit_rate,
    },
    "cache_hit_rate": cache_hit_rate,
    "compaction": {"count": compaction_count, "needed": ...},
    "bots": bots_breakdown,   # [{"bot_id", "tokens", "messages_count"}]
}
```

### A.9 `/api/settings` (`runtime.py:1033-1045`)

```python
{
    "model": self.model_name,
    "gateway_url": getattr(self.config, "llm_base_url",
                           "http://127.0.0.1:3425/v1") or "http://127.0.0.1:3425/v1",
    "workspace_root": self.config.workspace_root,
    "max_parallel": getattr(self.router, "max_parallel",
                            self.config.orchestrator_max_parallel),
    "max_subtasks": getattr(self.router, "max_subtasks",
                            self.config.orchestrator_max_subtasks),
    "max_iterations": getattr(self.config, "default_mandate_max_iterations", 30),
    "timeout_seconds": getattr(self.config, "default_mandate_timeout_seconds", 120.0),
    "watchdog_timeout": getattr(self.config, "watchdog_timeout_seconds", 60.0),
    "archetype_model_overrides": dict(getattr(self.router,
                                              "archetype_model_overrides", {}) or {}),
}
```

### A.10 `/api/stats` (`server.py:121-153`)

```python
tokens = {
    "prompt": _int_token(getattr(llm, "total_prompt_tokens", 0)),
    "completion": _int_token(getattr(llm, "total_completion_tokens", 0)),
    "cache_read": _int_token(getattr(llm, "total_cache_read_tokens", 0)),
    "cache_write": _int_token(getattr(llm, "total_cache_write_tokens", 0)),
}
counts = {"threads": 0, "tickets": 0, "tickets_by_state": {}, "rooms": 0}
# SELECT COUNT(*) FROM threads
# SELECT COUNT(*) FROM tickets
# SELECT state, COUNT(*) FROM tickets GROUP BY state
# counts["rooms"] = len(runtime.rooms)
context_snap = runtime.get_context_stats()
return {"tokens": tokens, "counts": counts, "context": context_snap}
```

### A.11 Room messages / files / room / say (`server.py:643-806`)

```python
{"room_id": room_id, "messages": messages}

files = [entry.to_dict() for entry in room.file_index.values()]
{"room_id": room_id, "files": files}

{"room_id": room_id, "file_id": file_id, "path": entry.path,
 "description": entry.description, "tags": list(entry.tags),
 "updated_at": entry.updated_at, "size": size, "binary": is_binary,
 "truncated": truncated, "content": content}

room.to_dict()

{"status": "accepted", "room_id": room_id}
```

### A.12 Thread events (`server.py:829`, `store.py:996-1005`)

```python
{"thread_id": thread_id, "events": events}
# element: {"seq": int, "ts": float, "topic": str, "sender": str,
#           "payload": dict, "thread_id": str | None}
```

### A.13 SSE (`server.py:903-908`)

```python
data = json.dumps({
    "topic": event.topic,
    "sender": event.sender,
    "payload": event.payload,
}, ensure_ascii=False, default=str)
writer.write(f"data: {data}\n\n".encode("utf-8"))
```

### A.14 Bot configs (`runtime.py:1114-1185`)

```python
# ChiefRouter
{
    "id": "ChiefRouter",
    "name": getattr(self.router.config, "name", "Chief Router") or "Chief Router",
    "role": "router", "archetype": "router", "label": "Chief",
    "badge": str(chief_extra.get("badge") or "🧭"),
    "tagline": str(chief_extra.get("tagline") or "总调度 · 任务拓扑分解"),
    "state": ...,
    "model": getattr(self.router.config, "model", self.model_name) or self.model_name,
    "temperature": float(getattr(self.router.config, "temperature", 0.0) or 0.0),
    "system_prompt": getattr(self.router.config, "system_prompt", None)
                     or "You are the Chief Router orchestrating autonomous subagents.",
    "allowed_tools": list(self.router.mounted_tools),
    "read_only": True,
    "max_subtasks": self.router.max_subtasks,
    "max_parallel": self.router.max_parallel,
}

# Worker
{
    "id": str(bot_id),
    "name": getattr(getattr(worker, "config", None), "name", bot_id) or str(bot_id),
    "role": "worker",
    "archetype": str(archetype),
    "label": getattr(getattr(worker, "config", None), "name", bot_id) or str(bot_id),
    "badge": str(extra.get("badge") or (preset.badge if preset else "🤖")),
    "tagline": str(extra.get("tagline") or (preset.tagline if preset else "")),
    "state": ...,
    "model": getattr(getattr(worker, "config", None), "model", self.model_name)
             or self.model_name,
    "temperature": float(getattr(getattr(worker, "config", None), "temperature", 0.0) or 0.0),
    "system_prompt": getattr(getattr(worker, "config", None), "system_prompt", None)
                     or "You are an autonomous execution agent.",
    "allowed_tools": list(getattr(worker, "mounted_tools", [])),
    "read_only": bool(getattr(mandate, "read_only", False) if mandate else False),
    "max_iterations": int(getattr(mandate, "max_iterations", 30) if mandate else 30),
    "timeout_seconds": float(getattr(mandate, "timeout_seconds", 120.0) if mandate else 120.0),
}

# Archetype preset
{
    "id": archetype.agent_type,
    "name": archetype.display_name,
    "role": "worker",
    "archetype": archetype.agent_type,
    "label": archetype.display_name,
    "badge": archetype.badge,
    "tagline": archetype.tagline,
    "state": "idle",
    "model": self.router.archetype_model_overrides.get(
        archetype.agent_type, archetype.default_model),
    "temperature": 0.0,
    "system_prompt": archetype.system_prompt,
    "allowed_tools": list(archetype.allowed_tools or []),
    "read_only": bool(archetype.read_only),
    "max_iterations": 15 if archetype.read_only else 30,
    "timeout_seconds": 120.0,
}
```

### A.15 Room / permissions / file entry (`group.py:54-60, 92-99, 749-764`)

```python
# MemberPermission.to_dict()
{"can_speak": bool, "context_access": "full"|"summary"|"none",
 "can_create_subgroup": bool, "allowed_tool_overrides": list|None}

# RoomFileEntry.to_dict()
{"file_id": str, "path": str, "description": str,
 "tags": list[str], "updated_at": str}

# CollaborativeGroupRoom.to_dict()
{
    "room_id": self.room_id,
    "title": self.title,
    "members": list(self.members),
    "owner_id": self.owner_id,
    "parent_room_id": self.parent_room_id,
    "topic": self.topic,
    "context_policy": self.context_policy,
    "orchestrator_mode": self.orchestrator_mode,
    "status": self.status,
    "relays": self.relays,
    "message_count": len(self.message_log),
    "file_count": len(self.file_index),
    "updated_at": self.updated_at,
    "member_permissions": {b: p.to_dict()
                           for b, p in self.member_permissions.items()},
}
```

### A.16 `Event` envelope (`event_bus.py:33-41`)

```python
class Event(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    topic: str = Field(..., description="Dot-separated topic string, e.g. 'tasks.submit'")
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    sender: str = Field(default="system", description="Identifier of the publishing entity")
    payload: Any = Field(default_factory=dict, description="Arbitrary structured data payload")
```

(The SSE frame deliberately drops `id` and `timestamp`; the persisted replay row uses a
different `ts` float and its own `seq`.)

### A.17 Room message row (`store.py:1171-1179`)

```python
{"seq": int(row["seq"]),
 "speaker": row["speaker"],
 "content": row["content"],
 "kind": row["kind"],
 "ts": row["ts"]}
```

---

## Appendix B — porting notes for the Node/AgentFusion server

These are **not** part of the Python contract; they record where the Python behavior is
surprising or where `docs/FUSION_SPEC.md` already assumes something different.

| Topic | Python reality | Suggested Node handling |
|---|---|---|
| Reason phrase | Always `OK`, even for 4xx/5xx | Use Node's standard phrases; no client depends on the phrase |
| SSE event fields | `{topic, sender, payload}` only | `FUSION_SPEC.md` §3 shows `subscribe(fn)` with `{seq,ts,...}`; keep that for **internal** subscribers, but the HTTP SSE frame must stay 3-key unless the frontend is changed |
| `POST /api/rooms` | key is `include_roles`; still requires ≥2 `members` | Spec §3 `RoomManager.create` names `include_librarian`; map it to `include_roles` at the API boundary or accept both |
| Room object | no `created_at`, no `users`, no `messages` | Spec's `Room.snapshot()` can add fields, but keep the 14 documented keys with the same types |
| Room file paths | absolute Windows paths | Spec §6 says store relative-to-root posix paths; if you change it, E23's `path` and `file_moved` payloads change — the UI only displays them, so it's tolerable, but document the divergence |
| `member_permissions` | object keyed by bot id | Keep exactly; the UI does `room.member_permissions?.[id]` |
| Bot shape | `allowed_tools` (not `tools`), `badge`, `tagline`, `label` | Spec §3 `buildBot` uses `tools`, `emoji`; either emit both or adapt `web/js/avatars.js`/`views/*` |
| `GET /api/models` | `{object,data,current_model,gateway_url,is_fallback}`; data entries pass through | The UI only needs `data[].id` + optional `display_name` |
| Static | only `/`, `/static/*`, `/favicon.ico` | Keep the same three routes so `index.html`'s `/static/...` URLs work |
| Errors | `{"error": str}` + silent closes | Prefer always returning JSON `{"error": ...}`; the UI reads `.error` |
| SSE framing | no `Content-Length`, no chunked encoding — raw frames on a `keep-alive` socket | Node's `ServerResponse` will add `Transfer-Encoding: chunked`; `EventSource` handles both. Keep the exact `data: …\n\n` payload |
| `POST /say` | returns before the round; state changes only via SSE | Preserve; the UI appends the local user message optimistically and waits for events |
| Tickets / threads | plain arrays, limit 50 | The UI only uses them for diagnostics; arrays are fine |

---

*End of contract. Every key name above is copied literally from the Python source; where a
value is dynamic (timestamps, ids, token counts) the example shows a plausible value and the
prose states the source.*
