#!/usr/bin/env node
// rust-lldb-mcp — an MCP server that spawns rust-lldb on demand
// and proxies commands to its built-in MCP server over a Unix socket.
//
// Surface:
//   lldb_start({ binary?, core?, preload?, socket_wait_ms? }) -> { session_id }
//   lldb_command({ session_id, command})                      -> { output, truncated?, dropped_chars? }
//   lldb_stop({ session_id })                                 -> { ok: true }
//
// stdout is owned by the outer MCP SDK. All logs go to stderr.

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { PassThrough } from 'node:stream';
import { access, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const MAX_SESSIONS = 8;
// Default socket-wait budget for lldb's MCP protocol-server to open its
// Unix socket. Preload commands run *before* the socket appears, so a
// slow `run` against a debug build can easily need more than a couple
// of seconds. The default is a fast-fail ceiling for well-behaved
// invocations; override via `socket_wait_ms` on `lldb_start` or the
// `LLDB_MCP_SOCKET_WAIT_MS` env var when preload is heavy.
const SOCKET_WAIT_MS_DEFAULT = 5000;
const SOCKET_WAIT_MS_MIN = 500;
const SOCKET_WAIT_MS_MAX = 120000;
const SOCKET_WAIT_MS_ENV = 'LLDB_MCP_SOCKET_WAIT_MS';
const SOCKET_POLL_MS = 50;
const LLDB_CMD_TIMEOUT_MS = 60000;
const INITIALIZE_TIMEOUT_MS = 5000;
const STOP_SIGTERM_WAIT_MS = 500;
const OUTPUT_BUDGET_CHARS = 20000;

const log = (...args) => console.error('[rust-lldb-mcp]', ...args);

class LldbError extends Error {
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

const sessions = new Map(); // id -> Session
let nextSessionId = 1;
let nextSocketCounter = 1;

class Session {
    constructor(id, child, socket, socketPath) {
        this.id = id;
        this.child = child;
        this.socket = socket;
        this.socketPath = socketPath;
        this.pending = new Map(); // requestId -> { resolve, reject, timer }
        this.buffer = '';
        this.dead = false;
        this.nextRequestId = 1;
        this.closing = false;
        // Populated by startSession after a successful spawn. Captures the
        // arguments the caller supplied so lldb_restart can reuse them without
        // requiring the caller to re-state binary/core/socket_wait_ms.
        this.startArgs = null;
    }

    nextId() {
        return this.nextRequestId++;
    }

    // Route one inbound parsed JSON-RPC message.
    dispatch(msg) {
        if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
            const entry = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (entry.timer) clearTimeout(entry.timer);
            if (msg.error) {
                entry.reject(
                    new LldbError(
                        'lldb_rpc_error',
                        msg.error.message || 'LLDB RPC error',
                        msg.error,
                    ),
                );
            } else {
                entry.resolve(msg.result);
            }
            return;
        }
        // Notifications (no id). LLDB currently sends tools/list_changed; we ignore.
    }

    // Send a JSON-RPC request to LLDB and await its response.
    request(method, params, timeoutMs = LLDB_CMD_TIMEOUT_MS) {
        if (this.dead) {
            return Promise.reject(new LldbError('lldb_crashed', 'LLDB session exited'));
        }
        const id = this.nextId();
        const payload = { jsonrpc: '2.0', id, method, params };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new LldbError('timeout', `LLDB ${method} timed out after ${timeoutMs}ms`));
                }
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.socket.write(JSON.stringify(payload) + '\n');
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new LldbError('lldb_crashed', `socket write failed: ${err.message}`));
            }
        });
    }

    notify(method, params) {
        if (this.dead) return;
        const payload = { jsonrpc: '2.0', method, params };
        try {
            this.socket.write(JSON.stringify(payload) + '\n');
        } catch (err) {
            log(`session ${this.id}: notify write failed:`, err.message);
        }
    }

    markDead(reason) {
        if (this.dead) return;
        this.dead = true;
        for (const [id, entry] of this.pending) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.reject(new LldbError('lldb_crashed', reason || 'LLDB session exited'));
        }
        this.pending.clear();
    }
}

async function waitForSocket(path, child, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new LldbError(
                'lldb_spawn_failed',
                `rust-lldb exited (code ${child.exitCode}) before socket appeared`,
            );
        }
        try {
            await access(path, fsConstants.R_OK | fsConstants.W_OK);
            return;
        } catch {
            // not there yet
        }
        await new Promise(r => setTimeout(r, SOCKET_POLL_MS));
    }
    throw new LldbError(
        'socket_never_appeared',
        `LLDB MCP socket ${path} did not appear within ${timeoutMs}ms`,
    );
}

// Resolve the effective socket-wait timeout: explicit argument wins,
// then env var, then the built-in default. Invalid values throw with
// `invalid_request` so the caller sees their own mistake immediately
// instead of silently falling back. Valid values are clamped to
// [SOCKET_WAIT_MS_MIN, SOCKET_WAIT_MS_MAX] so a pathological override
// (0, Infinity, NaN, negative) can't stall the orchestrator.
function resolveSocketWaitMs(arg) {
    const pick = (raw, source) => {
        if (raw === undefined || raw === null || raw === '') return null;
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
            throw new LldbError(
                'invalid_request',
                `${source} must be a positive integer number of milliseconds, got ${JSON.stringify(raw)}`,
            );
        }
        return Math.min(SOCKET_WAIT_MS_MAX, Math.max(SOCKET_WAIT_MS_MIN, n));
    };
    const fromArg = pick(arg, 'socket_wait_ms');
    if (fromArg !== null) return fromArg;
    const fromEnv = pick(process.env[SOCKET_WAIT_MS_ENV], SOCKET_WAIT_MS_ENV);
    if (fromEnv !== null) return fromEnv;
    return SOCKET_WAIT_MS_DEFAULT;
}

async function fileExists(path) {
    try {
        await access(path, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function startSession({ binary, core, preload, socket_wait_ms }) {
    if (!binary && !core) {
        throw new LldbError(
            'invalid_request',
            'lldb_start requires at least one of: binary, core',
        );
    }
    if (binary && !(await fileExists(binary))) {
        throw new LldbError('binary_not_found', `binary does not exist: ${binary}`);
    }
    if (core && !(await fileExists(core))) {
        throw new LldbError('core_not_found', `core dump does not exist: ${core}`);
    }
    if (preload && !Array.isArray(preload)) {
        throw new LldbError('invalid_request', 'preload must be an array of strings');
    }
    const socketWaitMs = resolveSocketWaitMs(socket_wait_ms);
    if (sessions.size >= MAX_SESSIONS) {
        throw new LldbError(
            'too_many_sessions',
            `concurrent session cap (${MAX_SESSIONS}) reached; call lldb_stop on an idle session first`,
        );
    }

    const id = nextSessionId++;
    const socketPath = `/tmp/rust-lldb-mcp.${process.pid}.${nextSocketCounter++}.sock`;

    // Best-effort: remove any stale socket file at the target path.
    await unlink(socketPath).catch(() => {});

    // LLDB's REPL exits on stdin EOF and takes its MCP server with it.
    // A PassThrough that we never .end() keeps its stdin open forever.
    const stdinKeepalive = new PassThrough();

    // Build LLDB invocation. The target and any preload commands are passed
    // as -o flags so they execute before the MCP server takes over —
    // process-executing commands (run, process launch, continue) hang when
    // invoked via LLDB's MCP lldb_command tool, but work correctly when
    // pre-loaded on the command line.
    const lldbArgs = [];
    let targetCmd;
    if (binary && core) {
        targetCmd = `target create ${shellQuote(binary)} --core ${shellQuote(core)}`;
    } else if (binary) {
        targetCmd = `target create ${shellQuote(binary)}`;
    } else {
        targetCmd = `target create --core ${shellQuote(core)}`;
    }
    lldbArgs.push('-o', targetCmd);
    if (Array.isArray(preload)) {
        for (const cmd of preload) {
            if (typeof cmd !== 'string' || !cmd.trim()) {
                throw new LldbError('invalid_request', 'preload entries must be non-empty strings');
            }
            lldbArgs.push('-o', cmd);
        }
    }
    lldbArgs.push('-o', `protocol-server start MCP accept://${socketPath}`);

    let child;
    try {
        child = spawn('rust-lldb', lldbArgs, {
            stdio: ['pipe', 'ignore', 'ignore'],
        });
    } catch (err) {
        throw new LldbError('lldb_spawn_failed', `failed to spawn rust-lldb: ${err.message}`);
    }

    stdinKeepalive.pipe(child.stdin);
    child.stdin.on('error', () => {
        // If LLDB exits and child.stdin EPIPEs, don't crash the orchestrator.
    });

    let spawnError = null;
    child.on('error', (err) => {
        spawnError = err;
    });

    try {
        await waitForSocket(socketPath, child, socketWaitMs);
    } catch (err) {
        try { child.kill('SIGKILL'); } catch {}
        stdinKeepalive.destroy();
        await unlink(socketPath).catch(() => {});
        if (spawnError) {
            throw new LldbError('lldb_spawn_failed', `spawn error: ${spawnError.message}`);
        }
        throw err;
    }

    let socket;
    try {
        socket = await new Promise((resolve, reject) => {
            const s = createConnection(socketPath);
            const onErr = (err) => reject(err);
            s.once('error', onErr);
            s.once('connect', () => {
                s.off('error', onErr);
                resolve(s);
            });
        });
    } catch (err) {
        try { child.kill('SIGKILL'); } catch {}
        stdinKeepalive.destroy();
        await unlink(socketPath).catch(() => {});
        throw new LldbError(
            'lldb_spawn_failed',
            `failed to connect to LLDB socket ${socketPath}: ${err.message}`,
        );
    }

    const session = new Session(id, child, socket, socketPath);
    session.stdinKeepalive = stdinKeepalive;

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
        session.buffer += chunk;
        let newlineIdx;
        while ((newlineIdx = session.buffer.indexOf('\n')) !== -1) {
            const line = session.buffer.slice(0, newlineIdx);
            session.buffer = session.buffer.slice(newlineIdx + 1);
            if (!line.trim()) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch (err) {
                log(`session ${id}: JSON parse error on inbound line:`, err.message, '<<', line);
                continue;
            }
            try {
                session.dispatch(msg);
            } catch (err) {
                log(`session ${id}: dispatch error:`, err);
            }
        }
    });
    socket.on('error', (err) => {
        log(`session ${id}: socket error:`, err.message);
    });
    socket.on('close', () => {
        if (!session.closing) {
            session.markDead('LLDB socket closed');
        }
    });

    child.on('exit', (code, signal) => {
        log(`session ${id}: rust-lldb exited (code=${code} signal=${signal})`);
        session.markDead(`rust-lldb exited (code=${code}, signal=${signal})`);
        // Drop the socket file if still present.
        unlink(socketPath).catch(() => {});
    });

    // MCP handshake with LLDB.
    try {
        await session.request(
            'initialize',
            {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'rust-lldb-mcp', version: '0.1.0' },
            },
            INITIALIZE_TIMEOUT_MS,
        );
        session.notify('notifications/initialized', {});
    } catch (err) {
        await teardownSession(session).catch(() => {});
        throw new LldbError(
            'initialize_failed',
            `LLDB initialize handshake failed: ${err.message}`,
        );
    }

    sessions.set(id, session);

    // Confirm the target was loaded successfully by asking LLDB for its list
    // of targets. `-o target create` ran before the MCP server started, so
    // any error it produced went to LLDB's stdout (which we discard). If the
    // target list is empty, fail loudly here rather than handing back a
    // session the agent can't use.
    try {
        const out = await runLldbCommand(session, 'target list');
        if (/No targets\./i.test(out)) {
            await teardownSession(session).catch(() => {});
            sessions.delete(id);
            throw new LldbError(
                'target_create_failed',
                `LLDB did not load the requested target; \`target list\` returned: ${out.trim()}`,
            );
        }
    } catch (err) {
        if (err instanceof LldbError) throw err;
        await teardownSession(session).catch(() => {});
        sessions.delete(id);
        throw new LldbError(
            'target_create_failed',
            `failed to verify target via \`target list\`: ${err.message}`,
        );
    }

    session.startArgs = {
        binary: binary || null,
        core: core || null,
        preload: Array.isArray(preload) ? [...preload] : [],
        socket_wait_ms: socket_wait_ms ?? null,
    };
    const preloadCount = session.startArgs.preload.length;
    const stopSummary = await probeStopSummary(session);

    return {
        session_id: id,
        binary: session.startArgs.binary,
        core: session.startArgs.core,
        preload_count: preloadCount,
        stop_summary: stopSummary,
    };
}

// Best-effort one-line summary of the session's current inferior state,
// included in lldb_start / lldb_restart returns so callers don't need a
// separate `process status` round-trip to know whether their preload
// actually stopped at a breakpoint. Never fails the enclosing call:
// any parse or RPC failure becomes "unknown".
async function probeStopSummary(session) {
    let statusOut;
    try {
        statusOut = await runLldbCommand(session, 'process status');
    } catch {
        return 'unknown';
    }
    const firstLine = (statusOut || '')
        .split('\n')
        .map(l => l.trim())
        .find(l => l.length > 0) || '';
    if (!firstLine) return 'target loaded (no process)';
    // "error: invalid process" (LLDB 21), "error: Command requires a current
    // process." (Apple LLDB) — both mean "target is loaded but nothing has run
    // yet." Normalize to a single opaque phrase.
    if (/^error:.*(invalid process|current process|no process)/i.test(firstLine)) {
        return 'target loaded (no process)';
    }
    if (/^Process\s+\d+\s+stopped/i.test(firstLine)) {
        // Append file:line from `frame info` when available — turns
        // "Process 12345 stopped" into
        // "Process 12345 stopped at parser.rs:42 (frame #0 myapp::parse)".
        let frameDetail = '';
        try {
            const frameOut = await runLldbCommand(session, 'frame info');
            const frameLine = (frameOut || '')
                .split('\n')
                .map(l => l.trim())
                .find(l => l.length > 0) || '';
            if (frameLine) frameDetail = ` — ${frameLine}`;
        } catch {
            // Leave frameDetail empty on error.
        }
        return `${firstLine}${frameDetail}`;
    }
    return firstLine;
}

function shellQuote(s) {
    // LLDB's command parser accepts single-quoted paths. We only need to
    // handle embedded single quotes.
    if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
    return `'${String(s).replaceAll("'", "'\\''")}'`;
}

async function runLldbCommand(session, command) {
    const result = await session.request('tools/call', {
        name: 'lldb_command',
        arguments: { debugger_id: 1, arguments: command },
    });
    // Expected shape: { content: [{ type: "text", text: "..." }], isError?: bool }
    let output = '';
    if (result && Array.isArray(result.content)) {
        for (const part of result.content) {
            if (part && typeof part.text === 'string') output += part.text;
        }
    }
    return output;
}

// First word of an LLDB command line, lowercase, with leading whitespace trimmed.
// Used to gate a small set of commands that hang when invoked via LLDB's MCP
// lldb_command tool. Pattern tolerates leading whitespace and `command <verb>`
// prefixes (a common LLDB alias style) by looking at the first non-whitespace
// token after any `command `/`co ` aliases.
const HANG_VERBS = new Set([
    'run', 'r', 'continue', 'c', 'process', 'thread', 'step', 's', 'next', 'n',
    'stepi', 'si', 'nexti', 'ni', 'finish', 'f', 'jump', 'j',
    'expression', 'expr', 'p', 'print', 'call',
]);
// Subset of the above that are always harmless — we only block the ones that
// actually resume the inferior. Anything in this allowlist passes through.
const SAFE_SUBCOMMANDS = {
    process: new Set(['status', 'handle', 'save-core', 'signal', 'plugin']),
    thread: new Set([
        'backtrace', 'bt', 'info', 'list', 'select', 'until', 'return', 'plan',
    ]),
};
const ALWAYS_SAFE = new Set([
    'expression', 'expr', 'p', 'print', 'call', // reads are fine; function calls can hang, but blocking them all is too conservative
]);

function classifyCommand(raw) {
    let s = String(raw || '').trim();
    if (!s) return 'empty';
    const tokens = s.split(/\s+/);
    const verb = tokens[0].toLowerCase();
    if (!HANG_VERBS.has(verb)) return 'safe';
    if (ALWAYS_SAFE.has(verb)) return 'safe';
    const sub = (tokens[1] || '').toLowerCase();
    const subSafe = SAFE_SUBCOMMANDS[verb];
    if (subSafe && subSafe.has(sub)) return 'safe';
    // Unambiguous hang cases.
    if (verb === 'run' || verb === 'r') return 'hang';
    if (verb === 'continue' || verb === 'c') return 'hang';
    if (verb === 'step' || verb === 's' || verb === 'stepi' || verb === 'si') return 'hang';
    if (verb === 'next' || verb === 'n' || verb === 'nexti' || verb === 'ni') return 'hang';
    if (verb === 'finish' || verb === 'jump' || verb === 'j') return 'hang';
    if (verb === 'process') {
        if (sub === 'launch' || sub === 'continue' || sub === 'kill' || sub === 'interrupt' ||
            sub === 'attach' || sub === 'detach' || sub === 'connect') return 'hang';
        return 'safe'; // conservative: unknown process subcmd, let LLDB decide
    }
    if (verb === 'thread') {
        if (sub === 'step-in' || sub === 'step-over' || sub === 'step-out' || sub === 'step-inst' ||
            sub === 'step-over-inst' || sub === 'step-scripted' || sub === 'continue' ||
            sub === 'jump' || sub === 'until') return 'hang';
        return 'safe';
    }
    return 'safe';
}

async function commandSession({ session_id, command }) {
    const session = sessions.get(session_id);
    if (!session) {
        throw new LldbError('session_not_found', `no such session: ${session_id}`);
    }
    if (session.dead) {
        sessions.delete(session_id);
        throw new LldbError('lldb_crashed', `session ${session_id} is dead`);
    }
    if (classifyCommand(command) === 'hang') {
        throw new LldbError(
            'process_command_rejected',
            `"${command}" resumes the inferior, which hangs LLDB's MCP server. Put it in lldb_start({preload:[...]}) to run it before MCP takes over, or call lldb_stop and restart the session with an updated preload.`,
        );
    }
    const output = await runLldbCommand(session, command);
    if (output.length > OUTPUT_BUDGET_CHARS) {
        const dropped = output.length - OUTPUT_BUDGET_CHARS;
        const truncated =
            output.slice(0, OUTPUT_BUDGET_CHARS) +
            `\n[truncated, ${dropped} chars dropped — ask a narrower question]`;
        return { output: truncated, truncated: true, dropped_chars: dropped };
    }
    return { output };
}

async function teardownSession(session) {
    if (session.closing) return;
    session.closing = true;
    try { session.socket.end(); } catch {}
    try { session.socket.destroy(); } catch {}
    try { session.stdinKeepalive?.destroy(); } catch {}
    if (session.child && session.child.exitCode === null) {
        try { session.child.kill('SIGTERM'); } catch {}
        const stopped = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(false), STOP_SIGTERM_WAIT_MS);
            session.child.once('exit', () => {
                clearTimeout(t);
                resolve(true);
            });
        });
        if (!stopped) {
            try { session.child.kill('SIGKILL'); } catch {}
        }
    }
    await unlink(session.socketPath).catch(() => {});
}

async function stopSession({ session_id }) {
    const session = sessions.get(session_id);
    if (!session) {
        throw new LldbError('session_not_found', `no such session: ${session_id}`);
    }
    sessions.delete(session_id);
    await teardownSession(session);
    return { ok: true };
}

async function shutdownAll() {
    const snapshot = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(snapshot.map(teardownSession));
}

// ---------------------------------------------------------------------------
// MCP server boilerplate

function toToolError(err) {
    const payload = err instanceof LldbError
        ? { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }
        : { code: 'internal_error', message: err?.message || String(err) };
    return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
    };
}

function toToolResult(value) {
    return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
    };
}

const server = new McpServer(
    { name: 'rust-lldb-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
);

server.registerTool(
    'lldb_start',
    {
        description:
            'Debugger for Rust binaries, tests, and core dumps. Spawn a new rust-lldb session to set breakpoints, debug panics or segfaults, inspect stack frames and variables post-mortem. Provide `binary` (path to executable) and/or `core` (path to core dump). `preload` is an optional list of LLDB commands to run before the MCP server takes over — use it to set breakpoints and launch the target to a stopped state (e.g. ["breakpoint set --name rust_panic", "run"]). Process-executing commands (run, continue, process launch/kill, step) hang if issued via lldb_command, so put them in preload instead. Preload commands run to completion before the MCP socket appears — a slow `run` against a debug build counts against the socket-wait budget; raise `socket_wait_ms` (or set the LLDB_MCP_SOCKET_WAIT_MS env var) when the default 5000 ms is tight. Returns { session_id, binary, core, preload_count, stop_summary } where stop_summary is a best-effort one-liner about the inferior state (e.g. "Process 12345 stopped — frame #0 ...").',
        inputSchema: {
            binary: z.string().optional().describe('Path to an executable to debug.'),
            core: z.string().optional().describe('Path to a core dump.'),
            preload: z
                .array(z.string())
                .optional()
                .describe(
                    'LLDB commands to run before the MCP server takes over. Run "breakpoint set ..." + "run" here to stop the target at a breakpoint before inspection.',
                ),
            socket_wait_ms: z
                .number()
                .int()
                .positive()
                .optional()
                .describe(
                    'Milliseconds to wait for lldb\'s MCP socket to appear after preload finishes. Default 5000; clamped to [500, 120000]. LLDB_MCP_SOCKET_WAIT_MS env var is a fallback when this argument is absent.',
                ),
        },
    },
    async (args) => {
        try {
            return toToolResult(await startSession(args));
        } catch (err) {
            log('lldb_start failed:', err.code || '', err.message);
            return toToolError(err);
        }
    },
);

server.registerTool(
    'lldb_command',
    {
        description:
            'Debugger command: run any LLDB command in an existing session to set breakpoints, inspect stack frames, read variables, disassemble, or query process state. The command string is passed to LLDB exactly as typed at the (lldb) prompt. Returns { output, truncated?, dropped_chars? }. Note: LLDB\'s `breakpoint set --condition` evaluator is unreliable for Rust struct-field access (e.g. `self.field == 42` silently evaluates-true on every hit); prefer `--ignore-count N`, `--one-shot true`, `$__lldb_hitcount == N`, or plain register/address equality.',
        inputSchema: {
            session_id: z.number().int().describe('Session id returned by lldb_start.'),
            command: z.string().describe('LLDB command string (e.g. "bt 10", "frame variable foo").'),
        },
    },
    async (args) => {
        try {
            return toToolResult(await commandSession(args));
        } catch (err) {
            log(`lldb_command failed (session=${args.session_id}):`, err.code || '', err.message);
            return toToolError(err);
        }
    },
);

server.registerTool(
    'lldb_stop',
    {
        description:
            'Debugger shutdown: tear down an LLDB session, killing the rust-lldb process and removing its Unix socket. Call this when finished debugging a Rust binary or core dump.',
        inputSchema: {
            session_id: z.number().int().describe('Session id returned by lldb_start.'),
        },
    },
    async (args) => {
        try {
            return toToolResult(await stopSession(args));
        } catch (err) {
            log(`lldb_stop failed (session=${args.session_id}):`, err.code || '', err.message);
            return toToolError(err);
        }
    },
);

// ---------------------------------------------------------------------------
// Lifecycle

let shuttingDown = false;
async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down: ${reason}`);
    try {
        await shutdownAll();
    } catch (err) {
        log('shutdownAll error:', err);
    }
    try { await server.close(); } catch {}
    // Give async logs a tick to flush.
    setImmediate(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
// If the parent closes our stdin (Claude Code exit), tear everything down.
process.stdin.on('end', () => shutdown('stdin end'));
process.stdin.on('close', () => shutdown('stdin close'));

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready (pid=${process.pid})`);
