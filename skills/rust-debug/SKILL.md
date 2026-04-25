---
name: rust-debug
description: |
  Drive LLDB via its built-in MCP server to debug Rust binaries,
  tests, and core dumps. Use when the user reports a Rust panic,
  segfault, assertion failure, unexpected runtime value, or asks to
  debug a Rust binary, test, or core dump — and prefer this over
  adding `dbg!`, `println!`, or `eprintln!` statements when the bug
  is reproducible, state at a specific call site matters, or compile
  times make iteration expensive.

  Do NOT use for intermittent or flow-across-many-sites bugs
  (recommend the `tracing` crate instead) or for trivial "what is
  this value here" interventions where `dbg!()` is appropriate.
  Rough heuristic: reach for LLDB when you'd set ≤3 breakpoints;
  prefer `tracing` or `eprintln!` when you'd want output from
  every iteration of a loop or every call to a hot function.
allowed-tools: Bash, Read, Grep, Glob, mcp__rust-lldb__lldb_start, mcp__rust-lldb__lldb_command, mcp__rust-lldb__lldb_restart, mcp__rust-lldb__lldb_stop
---

# LLDB MCP debugging for Rust

This skill drives LLDB via an on-demand orchestrator MCP server so debugging happens through a tool surface, not by littering source with `dbg!`. The orchestrator spawns `rust-lldb` when you call `lldb_start` and kills it on `lldb_stop` — there's no idle LLDB process between debug sessions. Three tools: `lldb_start(binary?, core?, preload?)` returns a `session_id`; `lldb_command(session_id, command)` runs any LLDB command; `lldb_stop(session_id)` tears the session down. Operating it well is mostly about output discipline and a clear loop, both of which this skill enforces.

## 1. Preflight — check before driving the debugger

If `mcp__rust-lldb__lldb_start`, `mcp__rust-lldb__lldb_command`, and `mcp__rust-lldb__lldb_stop` are all in your toolbox, the orchestrator attached at session start. Skip to §2.

If any tool is missing, something in the install broke. Diagnose with:

```bash
claude mcp list | grep lldb
which rust-lldb node
```

Expected: `claude mcp list` shows `lldb` connected; `rust-lldb` and `node` both resolve to paths.

If any of those fail, direct the user to `install.md` in this skill's directory. Do not attempt to fall back to `dbg!`-based debugging without first telling the user the skill cannot run.

`rust-lldb` loads pretty-printers for `Vec`, `String`, `Option`, `Result`, `HashMap`, etc. Without them, `frame variable` returns raw memory layouts that are hard to read and waste tokens.

## 2. Decide whether this skill is the right call

Before loading a target, classify the bug:

- **Use this skill** when the bug is reproducible AND one of: a panic with a non-obvious cause, a segfault, an assertion failure, wrong output where the failing computation can be pinpointed, or a state-inspection question at a specific call site. Also use for post-mortem analysis of a core dump.
- **Recommend `dbg!()` instead** for one-off "what does this value look like here, once" questions where the debugger-session setup has higher cost than a 10-second edit-rebuild cycle.
- **Recommend `tracing` instead** when the bug spans many call sites, is intermittent, depends on timing or external systems, or when the user already has a tracing setup. Suggest `RUST_LOG=trace` first.
- **Recommend re-running with `RUST_BACKTRACE=full`** if the user has only shared a panic message with no backtrace. Get the backtrace before reaching for the debugger.

Rough heuristic for the lldb-vs-tracing call: ≤3 breakpoints → LLDB; needing output from every iteration of a loop or every call to a hot function → `tracing` / `eprintln!`.

If the situation is borderline, say which way you're leaning and why in one sentence, then proceed.

## 3. Loading a target

Start a session with `lldb_start`. The orchestrator spawns a fresh `rust-lldb`, loads the target, runs any `preload` commands you pass, then opens its MCP channel. The returned payload is `{ session_id, binary, core, preload_count, stop_summary }` — `session_id` is what every later `lldb_command` / `lldb_restart` / `lldb_stop` call needs, and `stop_summary` is a best-effort one-liner ("Process N stopped — frame #0 …" / "target loaded (no process)" / …) that lets you confirm your preload actually landed where you expected without a separate `process status` round-trip. Call `lldb_stop(session_id)` when you're done — the orchestrator also cleans up on Claude Code exit, so forgetting is harmless, but stopping frees the LLDB process immediately.

**Critical constraint — process-executing commands must go in `preload`.**
LLDB's MCP `lldb_command` handler hangs when asked to run the inferior (`run`, `continue`, `process launch`, `process kill`, `step`, `next`, `finish`, …). The orchestrator rejects these with a `process_command_rejected` error. Instead, pass them as `preload` to `lldb_start` so they execute before the MCP server takes over. To resume execution (step, continue, re-run past a breakpoint), call `lldb_restart({ session_id, preload: [...new commands..., "run"] })` — it tears down the current session and spawns a fresh one against the same binary in a single call, returning a new `session_id`. Omit `preload` to reuse the previous session's preload verbatim.

**Debug binary**:

```
lldb_start(binary="target/debug/<binary-name>")
# returns { session_id: N }
```

If the binary doesn't exist yet, run `cargo build` via Bash first.

**Stop at a panic, then inspect**:

```
lldb_start(
  binary="target/debug/<binary-name>",
  preload=["breakpoint set --name rust_panic", "run"]
)
# session comes back stopped at rust_panic; inspect with lldb_command
```

**Test binary** — Cargo names test binaries with a content hash, so find the path first:

```bash
cargo test --no-run --message-format=json | jq -r 'select(.profile.test == true) | .executable' | grep -v null
```

For `cargo nextest`: `cargo nextest list --message-format json`. Same downstream pattern.

Then:

```
lldb_start(binary="<path-from-above>")
```

**Core dump (post-mortem)** — no process to run, so `preload` is usually empty:

```
lldb_start(binary="<binary>", core="<core>")
```

Switch targets by `lldb_stop(old_id)` + `lldb_start(...)`; `target delete` / `target create` still work within a session but are rarely the right tool given the orchestrator's cheap spawn/teardown. To re-run the same target with a different preload (new breakpoint, different args), use `lldb_restart` instead — same machinery in one call, and the old id is invalidated atomically so there's no window where both ids resolve.

## 4. The debugging loop

Work in a tight cycle. Each iteration should produce a concrete narrowing of the bug:

1. **Hypothesize** — state in one sentence what you think is wrong and where.
2. **Decide the stopping point** — which breakpoint is the minimum to confirm or refute the hypothesis. Avoid scattering breakpoints.
3. **`lldb_start` with `preload`** — set the breakpoint(s) and `run` in one shot, so the session comes back already stopped at the point of interest. (Process-executing commands can't run via `lldb_command` — see §3.)
4. **Ask one narrow question** of the program state per `lldb_command` call. Don't dump everything (see §5).
5. **Resuming** — to step or continue, call `lldb_restart({ session_id, preload: [...new commands..., "run"] })`. That tears down the current session and spawns a fresh one against the same binary in a single call, returning a new `session_id`; the old id becomes invalid. Omit `preload` to reuse the previous preload verbatim (useful for "re-run to the same breakpoint").
6. **Update the hypothesis or commit to it.** If three iterations haven't narrowed the bug, step back and reconsider the approach — possibly switch to `tracing`.

Communicate findings to the user as you go, briefly. Do not narrate every LLDB command; report what you learned.

## 5. Output discipline

The orchestrator truncates `lldb_command` output at ~20 000 characters with a `[truncated, N chars dropped]` footer, so an unbounded `bt` or `frame variable` won't blow up the MCP channel — but truncation destroys the signal you were looking for. Ask narrower questions:

- Cap backtraces: `bt 10`, not bare `bt`.
- `frame variable <name>` for one binding; avoid `frame variable` with no arguments in functions with non-trivial locals.
- Slice large collections: `expr -- &vec[0..5]` beats `p vec` when the pretty-printer would expand thousands of elements.
- `p self.field.subfield.value` beats `p self` on deeply-nested structs.
- Disassembly and memory dumps: only when the bug is at the ABI/unsafe layer or the user asked.
- Watchpoints in tight loops: `watchpoint set variable <name>` fires only when a specific value changes, unlike a breakpoint that fires 10 000 times. Add it in `preload` alongside `run`.

When a response comes back truncated, tighten the query and retry rather than continuing blind.

## 6. Common Rust recipes

**Catch a panic at its source** (before unwinding obscures the call site):

```
lldb_start(
  binary="target/debug/<bin>",
  preload=["breakpoint set --name rust_panic", "run"]
)
# session comes back stopped at rust_panic; then:
lldb_command(session_id, "bt 15")
lldb_command(session_id, "frame select 5")   # adjust until you reach user code
lldb_command(session_id, "frame variable <specific-name>")
```

**Debug a release build** — release strips debug info by default. Tell the user to add to `Cargo.toml`:

```toml
[profile.release]
debug = true
```

…then rebuild before attaching. Without this, `frame variable` will show "variable not available" for most locals due to optimizations.

**Async code** — LLDB's async support for Tokio/async-std is limited. Breakpoints inside `async fn` work; stepping across `.await` points does not preserve task identity reliably. Strategy: set breakpoints, let them hit, inspect state at each stop, but use `tracing` for flow questions.

**A test fails in CI but not locally** — almost always not a debugger problem. Recommend `tracing` with `RUST_LOG=trace cargo test -- --nocapture` first. Reach for LLDB only if you can reproduce locally.

**Conditional breakpoints that read Rust struct fields are unreliable.** LLDB's `--condition` expression evaluator does not correctly parse `self.field == ...` against Rust types — the condition silently evaluates-true on every hit, so the breakpoint fires at the wrong moment. Use one of these instead:

- `--ignore-count N` — skip the first N hits, break on the (N+1)th. Best when you know roughly which iteration to catch.
- `breakpoint set --one-shot true` — fire once and auto-delete. Good for "just stop here once so I can inspect."
- Hit-count condition via `breakpoint modify --condition '$__lldb_hitcount == N' <bp-id>` — reads the breakpoint's own hit counter, which LLDB evaluates without touching Rust types.
- Plain address / register equality in the condition (e.g. `$rdi == 0x42`) — avoids the Rust expression parser entirely.
- Multi-breakpoint preload (next recipe) — stop at several candidate sites, inspect at each.

**Multi-breakpoint preload to avoid restart-per-stop.** When the shape of the trace is known upfront, front-load every expected stop in one `lldb_start` rather than restarting between each:

```
lldb_start(
  binary="target/debug/<bin>",
  preload=[
    "breakpoint set --file parser.rs --line 100 --one-shot true",
    "breakpoint set --file parser.rs --line 250 --one-shot true",
    "breakpoint set --file parser.rs --line 400 --one-shot true",
    "run",
  ],
)
# session stops at the first site; inspect, then call lldb_restart to advance.
```

Combined with `--one-shot true`, each site fires at most once, so the natural `lldb_restart` flow walks the trace without re-arming breakpoints.

## 7. When to bail out and tell the user

Stop and hand back to the user when:

- LLDB crashes or the MCP connection drops — the orchestrator surfaces `lldb_crashed`, and the session is gone. Start a new one with `lldb_start`. If the orchestrator itself is unreachable (tools missing from the toolbox), that's an install problem; point the user at `install.md`.
- Output truncation is destroying useful information faster than narrowing it (try one more pass with tighter queries; if still bad, stop).
- The bug turns out to require modifying source and rebuilding to reach. At that point, the debugger session's value is gone — switch to source-level reasoning.
- You've gone three iterations without narrowing. Say so explicitly: "I've spent three iterations and haven't narrowed this. I'd recommend switching approach to X."

Never silently waste the user's tokens on a debugger session that isn't converging.

## Reference: the three tools

- `lldb_start({ binary?, core?, preload?, socket_wait_ms? })` → `{ session_id, binary, core, preload_count, stop_summary }`. At least one of `binary` / `core` is required. `preload` is an optional array of LLDB commands run before the MCP server takes over — use it for `run`, `continue`, `process launch`, and any other command that resumes the inferior. `stop_summary` is a best-effort one-line description of the inferior state (e.g. `"Process 12345 stopped — frame #0 myapp\`main at main.rs:42"`, `"target loaded (no process)"`).
- `lldb_command({ session_id, command })` → `{ output, truncated?, dropped_chars? }`. Runs any LLDB command that doesn't resume the inferior. Rejects resumption commands with `process_command_rejected`; put those in `preload`.
- `lldb_restart({ session_id, preload? })` → `{ session_id, previous_session_id, binary, core, preload_count, stop_summary }`. Tears down the session and spawns a fresh one against the same binary/core in one call. Mints a new `session_id` — the old id is invalidated atomically. Omit `preload` to reuse the previous preload verbatim.
- `lldb_stop({ session_id })` → `{ ok: true }`. Tears down the session; the orchestrator also cleans up on its own exit.

There are no structured wrappers (no `set_breakpoint(file, line)` etc.). LLDB's command syntax is the API. When uncertain about syntax, run `help <command>` via `lldb_command`.
