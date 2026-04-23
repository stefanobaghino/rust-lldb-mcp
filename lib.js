// Pure helpers shared by index.js and the test suite. No side effects on
// import — keep it that way so `node --test` can require this module
// without spinning up the MCP server.

export const SOCKET_WAIT_MS_DEFAULT = 5000;
export const SOCKET_WAIT_MS_MIN = 500;
export const SOCKET_WAIT_MS_MAX = 120000;
export const SOCKET_WAIT_MS_ENV = 'LLDB_MCP_SOCKET_WAIT_MS';

export class LldbError extends Error {
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

// Resolve the effective socket-wait timeout: explicit argument wins,
// then env var, then the built-in default. Invalid values throw with
// `invalid_request` so the caller sees their own mistake immediately
// instead of silently falling back. Valid values are clamped to
// [SOCKET_WAIT_MS_MIN, SOCKET_WAIT_MS_MAX] so a pathological override
// (0, Infinity, NaN, negative) can't stall the orchestrator.
export function resolveSocketWaitMs(arg, env = process.env) {
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
    const fromEnv = pick(env[SOCKET_WAIT_MS_ENV], SOCKET_WAIT_MS_ENV);
    if (fromEnv !== null) return fromEnv;
    return SOCKET_WAIT_MS_DEFAULT;
}

export function shellQuote(s) {
    // LLDB's command parser accepts single-quoted paths. We only need to
    // handle embedded single quotes.
    if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
    return `'${String(s).replaceAll("'", "'\\''")}'`;
}

// First word of an LLDB command line, lowercase, with leading whitespace trimmed.
// Used to gate a small set of commands that hang when invoked via LLDB's MCP
// lldb_command tool. Pattern tolerates leading whitespace and `command <verb>`
// prefixes (a common LLDB alias style) by looking at the first non-whitespace
// token after any `command `/`co ` aliases.
export const HANG_VERBS = new Set([
    'run',
    'r',
    'continue',
    'c',
    'process',
    'thread',
    'step',
    's',
    'next',
    'n',
    'stepi',
    'si',
    'nexti',
    'ni',
    'finish',
    'f',
    'jump',
    'j',
    'expression',
    'expr',
    'p',
    'print',
    'call',
]);
// Subset of the above that are always harmless — we only block the ones that
// actually resume the inferior. Anything in this allowlist passes through.
export const SAFE_SUBCOMMANDS = {
    process: new Set(['status', 'handle', 'save-core', 'signal', 'plugin']),
    thread: new Set(['backtrace', 'bt', 'info', 'list', 'select', 'until', 'return', 'plan']),
};
export const ALWAYS_SAFE = new Set([
    // reads are fine; function calls can hang, but blocking them all is too conservative
    'expression',
    'expr',
    'p',
    'print',
    'call',
]);

export function classifyCommand(raw) {
    const s = String(raw || '').trim();
    if (!s) return 'empty';
    const tokens = s.split(/\s+/);
    const verb = tokens[0].toLowerCase();
    if (!HANG_VERBS.has(verb)) return 'safe';
    if (ALWAYS_SAFE.has(verb)) return 'safe';
    const sub = (tokens[1] || '').toLowerCase();
    const subSafe = SAFE_SUBCOMMANDS[verb];
    if (subSafe?.has(sub)) return 'safe';
    // Unambiguous hang cases.
    if (verb === 'run' || verb === 'r') return 'hang';
    if (verb === 'continue' || verb === 'c') return 'hang';
    if (verb === 'step' || verb === 's' || verb === 'stepi' || verb === 'si') return 'hang';
    if (verb === 'next' || verb === 'n' || verb === 'nexti' || verb === 'ni') return 'hang';
    if (verb === 'finish' || verb === 'jump' || verb === 'j') return 'hang';
    if (verb === 'process') {
        if (
            sub === 'launch' ||
            sub === 'continue' ||
            sub === 'kill' ||
            sub === 'interrupt' ||
            sub === 'attach' ||
            sub === 'detach' ||
            sub === 'connect'
        )
            return 'hang';
        return 'safe'; // conservative: unknown process subcmd, let LLDB decide
    }
    if (verb === 'thread') {
        if (
            sub === 'step-in' ||
            sub === 'step-over' ||
            sub === 'step-out' ||
            sub === 'step-inst' ||
            sub === 'step-over-inst' ||
            sub === 'step-scripted' ||
            sub === 'continue' ||
            sub === 'jump' ||
            sub === 'until'
        )
            return 'hang';
        return 'safe';
    }
    return 'safe';
}
