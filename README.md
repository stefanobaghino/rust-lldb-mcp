# rust-lldb-mcp

An on-demand [MCP](https://modelcontextprotocol.io) server that lets a Claude
Code session (or any MCP client) drive [LLDB](https://lldb.llvm.org/) to debug
Rust binaries, tests, and core dumps — without keeping an LLDB process
resident between debug sessions.

```
MCP client  <--stdio MCP-->  rust-lldb-mcp  <--Unix socket MCP-->  rust-lldb
                             (this)                               (spawned per session)
```

`lldb_start` spawns `rust-lldb`, loads the target, runs any preload commands,
and opens LLDB's built-in `protocol-server start MCP` on a per-session Unix
socket. `lldb_command` proxies LLDB commands over that socket.
`lldb_restart` tears down and respawns in one call (useful for advancing past
a breakpoint when LLDB's MCP can't handle `continue`). `lldb_stop` tears it
all down. Idle cost: zero.

## Why this exists

LLDB 21 ships a built-in MCP server (`protocol-server start MCP
accept:///path.sock`), but its transport is Unix-socket only — not stdio —
and an always-on bridge pays for an LLDB process for the whole Claude
session. This orchestrator is the thinnest wrapper that spawns LLDB on
demand and exposes it to stdio-transport MCP clients.

It's built for personal Rust debugging on macOS + Linux. Windows is not
supported.

## Prerequisites

- **Node 20+** on `PATH` (`node --version`).
- **`rust-lldb`** on `PATH` — the rustup wrapper that loads Rust
  pretty-printers. Installed with the Rust toolchain.
- **LLDB 21+** (or Apple's LLDB from Xcode 16+ CLT) — verified by
  `rust-lldb -b -o "protocol-server start MCP accept:///tmp/probe.sock" -o "protocol-server stop MCP"`
  emitting `MCP server started …`. Older LLDBs lack `protocol-server` and
  won't work.

## Install

```bash
git clone https://github.com/stefanobaghino/rust-lldb-mcp.git
cd rust-lldb-mcp
npm install
```

### Register with Claude Code

```bash
claude mcp add --scope user rust-lldb -- "$PWD/index.js"
claude mcp list | grep rust-lldb   # should show "✓ Connected"
```

The name `rust-lldb` in that command is load-bearing: the bundled skill
hardcodes `mcp__rust-lldb__*` as the tool prefix. If you register under a
different name, the skill won't see the tools.

Start a fresh Claude Code session; `mcp__rust-lldb__lldb_start`,
`mcp__rust-lldb__lldb_command`, `mcp__rust-lldb__lldb_restart`, and
`mcp__rust-lldb__lldb_stop` appear in the toolbox. The tool surface is
driven entirely by this project; no per-project configuration is needed.

### Install the skill (optional, Claude Code only)

A [skill](https://docs.claude.com/en/docs/claude-code/skills) is bundled
at [`skills/rust-debug/`](./skills/rust-debug/SKILL.md) with guidance
for driving the three tools well — when to reach for the debugger, how
to work around the preload constraint, output-discipline heuristics.
Install by symlinking it into the user-scope skills directory:

```bash
ln -s "$PWD/skills/rust-debug" ~/.claude/skills/rust-debug
```

Proper packaging (self-hosted marketplace + `npx`-based MCP entry) is
tracked in [#1](https://github.com/stefanobaghino/rust-lldb-mcp/issues/1).

### Smoke test

```bash
node smoke-test.js
```

Exercises the four tools against `/bin/ls`, the `process_command_rejected`
guardrail, typical failure modes (`binary_not_found`, `session_not_found`,
double-stop), the restart-chain (old id invalidated, new preload carried
over), and the socket-wait timeout path. The last part builds a tiny
C binary with `cc -g` that sleeps during preload, so the host needs `cc`
(clang on macOS, gcc on Linux — both are usually already present) on
`PATH`. Expect all green; after exit, `/tmp/rust-lldb-mcp.*.sock`
should be empty and `pgrep -f rust-lldb` should return nothing.

## Tool surface

### `lldb_start({ binary?, core?, preload?, socket_wait_ms? }) → { session_id, binary, core, preload_count, stop_summary }`

Spawn a new `rust-lldb` and load the target. At least one of `binary`
(path to an executable) or `core` (path to a core dump) is required.

`preload` is an **ordered** array of LLDB command strings that run before
LLDB's MCP server accepts the socket connection. This is the escape hatch
for commands that resume the inferior — see the constraint below.

`socket_wait_ms` overrides how long to wait for LLDB's MCP socket to
appear. Preload commands run against this same budget (the socket only
opens after `-o` commands finish), so raise it when a `run` against a
slow-to-start debug build eats the default. Default 5000, clamped to
`[500, 120000]`; a non-positive-integer value fails with
`invalid_request`. The `LLDB_MCP_SOCKET_WAIT_MS` env var on the
orchestrator process is a fallback when the argument is absent.

`stop_summary` in the return payload is a best-effort one-line
description of the inferior state after preload (e.g.
`"Process 12345 stopped — frame #0 myapp\`main at main.rs:42"`,
`"Process 12345 exited with status = 0"`, `"target loaded (no process)"`)
so callers can confirm their preload landed where expected without a
separate `process status` round-trip. `binary` / `core` are echoed back
verbatim (or `null` when absent) and `preload_count` is the number of
preload entries used.

Errors (`code` field in the error payload): `invalid_request`,
`binary_not_found`, `core_not_found`, `lldb_spawn_failed`,
`socket_never_appeared`, `initialize_failed`, `target_create_failed`,
`too_many_sessions` (the concurrent-session cap is 8).

### `lldb_command({ session_id, command }) → { output, truncated?, dropped_chars? }`

Run any LLDB command in an existing session. `command` is passed to LLDB
verbatim, just like typing it at the `(lldb)` prompt.

`output` is truncated at 20 000 characters with a `[truncated, N chars
dropped …]` footer and `truncated: true, dropped_chars: N` metadata.

Errors: `session_not_found`, `lldb_crashed`, `timeout`, `lldb_rpc_error`,
`process_command_rejected`.

### `lldb_restart({ session_id, preload? }) → { session_id, previous_session_id, binary, core, preload_count, stop_summary }`

Tear down an existing session and spawn a fresh one against the same
`binary` / `core` in a single call. Use when you need to resume past a
breakpoint, change the preload (e.g. move the breakpoint, add a new
one), or re-run to the same stop: the orchestrator's cheap spawn
semantics make this the preferred alternative to the `process continue`
/ `step` commands that hang LLDB's MCP server.

`preload` overrides the previous session's preload when provided;
otherwise the previous preload is reused verbatim (convenient for
"re-run to the same breakpoint"). `socket_wait_ms` is inherited from
the previous session — a slow preload that succeeded once will succeed
again on restart.

The returned `session_id` is **always fresh** — the old id is
invalidated atomically, before teardown begins, so any concurrent
`lldb_command` on the old id gets a clean `session_not_found` rather
than racing a half-torn-down session. `previous_session_id` echoes the
old id for traceability. The rest of the payload matches `lldb_start`.

Errors: `session_not_found` (old id unknown), `invalid_request` (bad
`preload`), plus everything `lldb_start` can return when the respawn
fails (`binary_not_found`, `core_not_found`, `lldb_spawn_failed`,
`socket_never_appeared`, `initialize_failed`, `target_create_failed`,
`too_many_sessions`). On respawn failure, the old session is already
gone — call `lldb_start` fresh.

### `lldb_stop({ session_id }) → { ok: true }`

Tear down the session. SIGTERM → 500 ms grace → SIGKILL; socket file
removed; session entry dropped. The orchestrator also cleans all sessions
up on SIGTERM/SIGINT and on stdin EOF (i.e. when Claude Code exits).

Errors: `session_not_found`.

## The one constraint worth knowing

**LLDB's MCP `lldb_command` handler hangs indefinitely on any command
that resumes the inferior** — `run`, `continue`, `process launch`,
`process kill`, `step`, `next`, `finish`, etc. This is a limitation of
LLDB's MCP server, not of this orchestrator.

The workaround is built into the protocol: pass those commands as
`preload` on `lldb_start`. They run via LLDB's `-o` flag before the MCP
server accepts connections, so the session hands back a process that's
already at a known stop. The orchestrator rejects the same commands from
`lldb_command` with a typed `process_command_rejected` error, steering
callers at the fix.

To resume (step, continue, re-run past a breakpoint), call
`lldb_restart({ session_id, preload: [...new commands..., "run"] })`:
it tears down the current session and spawns a fresh one against the
same binary/core in one call, returning a new `session_id`. Omit
`preload` to reuse the previous preload verbatim. `lldb_stop` +
`lldb_start` still works and is the right tool when switching binaries.

## Example: debug a Rust panic

```jsonc
// lldb_start
{
  "binary": "target/debug/my-app",
  "preload": [
    "breakpoint set --name rust_panic",
    "run"
  ]
}
// → { "session_id": 1 }

// lldb_command
{ "session_id": 1, "command": "bt 15" }
// → { "output": "* thread #1, stop reason = breakpoint 1.1 …" }

// lldb_command
{ "session_id": 1, "command": "frame select 5" }
// lldb_command
{ "session_id": 1, "command": "frame variable" }

// lldb_stop
{ "session_id": 1 }
// → { "ok": true }
```

For a core dump, omit `preload` (there's no live process to run):

```jsonc
{
  "binary": "path/to/bin",
  "core": "path/to/core"
}
```

## Security

LLDB's command interface lets the caller evaluate arbitrary expressions
and launch binaries in the debugged process. Treat every `lldb_command`
as code execution. Only debug binaries you trust; be explicit with users
about what the agent is allowed to load.

The orchestrator uses Unix-socket transport to LLDB — no network
exposure. Don't swap it for TCP (`listen://127.0.0.1:…`) without
understanding the implications.

## License

[MIT](./LICENCE.md).
