#!/usr/bin/env node
// Smoke test: drive index.js over stdio as an MCP client and exercise
// the three tools plus a few failure modes.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INDEX = join(__dirname, 'index.js');

function color(c, s) {
    return `\x1b[${c}m${s}\x1b[0m`;
}
const ok = (s) => console.log(color('32', '✔'), s);
const bad = (s) => console.log(color('31', '✘'), s);
const info = (s) => console.log(color('36', '·'), s);

async function listSocketFiles() {
    const files = await readdir('/tmp');
    return files.filter(f => f.startsWith('rust-lldb-mcp.'));
}

// Compile a tiny C fixture that sleeps longer than the default
// socket-wait budget. Used by the slow-preload scenarios below.
// Returns { binary, cleanup }; callers must invoke `cleanup` when done.
async function buildSlowFixture(sleepSeconds) {
    const dir = await mkdtemp(join(tmpdir(), 'rust-lldb-mcp-smoke-'));
    const src = join(dir, 'slow-start.c');
    const bin = join(dir, 'slow-start');
    await writeFile(
        src,
        `#include <unistd.h>\nint main(void) { sleep(${sleepSeconds}); return 0; }\n`,
    );
    await new Promise((resolve, reject) => {
        const cc = spawn('cc', ['-g', src, '-o', bin], { stdio: 'inherit' });
        cc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`cc exited ${code}`)));
        cc.on('error', reject);
    });
    return {
        binary: bin,
        cleanup: () => rm(dir, { recursive: true, force: true }),
    };
}

async function countLldbProcs() {
    return await new Promise((resolve) => {
        // Match spawned LLDB children by the unique argv substring we
        // pass via `-o`. Matching `rust-lldb` loosely would also hit
        // this orchestrator when it lives under a path containing that
        // string (e.g. `.../rust-lldb-mcp/index.js`).
        const c = spawn('pgrep', ['-f', 'protocol-server start MCP']);
        let out = '';
        c.stdout.on('data', d => out += d);
        c.on('exit', () => resolve(out.trim().split('\n').filter(Boolean).length));
        c.on('error', () => resolve(0));
    });
}

function startOrchestrator() {
    const child = spawn('node', [INDEX], { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdout.setEncoding('utf8');

    let buffer = '';
    let nextId = 1;
    const pending = new Map();

    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (!line.trim()) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id !== undefined && pending.has(msg.id)) {
                const { resolve, reject } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) reject(new Error(`RPC error: ${JSON.stringify(msg.error)}`));
                else resolve(msg.result);
            }
        }
    });

    function request(method, params, timeoutMs = 10000) {
        const id = nextId++;
        const payload = { jsonrpc: '2.0', id, method, params };
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`request ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            pending.set(id, {
                resolve: (r) => { clearTimeout(t); resolve(r); },
                reject: (e) => { clearTimeout(t); reject(e); },
            });
            child.stdin.write(JSON.stringify(payload) + '\n');
        });
    }

    function notify(method, params) {
        const payload = { jsonrpc: '2.0', method, params };
        child.stdin.write(JSON.stringify(payload) + '\n');
    }

    return { child, request, notify };
}

function parseToolResult(r) {
    if (!r || !Array.isArray(r.content) || !r.content[0]) return { isError: true, raw: r };
    const text = r.content[0].text;
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { _raw: text }; }
    return { isError: !!r.isError, value: parsed };
}

async function main() {
    let failures = 0;

    info('starting orchestrator');
    const { child, request, notify } = startOrchestrator();

    try {
        info('initialize');
        const init = await request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'smoke-test', version: '0.0.1' },
        });
        if (init?.serverInfo?.name === 'rust-lldb-mcp') ok('initialize OK');
        else { bad(`initialize unexpected: ${JSON.stringify(init)}`); failures++; }
        notify('notifications/initialized', {});

        info('tools/list');
        const tools = await request('tools/list', {});
        const names = (tools?.tools || []).map(t => t.name).sort();
        const expected = ['lldb_command', 'lldb_start', 'lldb_stop'];
        if (JSON.stringify(names) === JSON.stringify(expected)) ok(`tools/list: ${names.join(', ')}`);
        else { bad(`tools/list: got ${JSON.stringify(names)}, want ${JSON.stringify(expected)}`); failures++; }

        info('lldb_start with bogus path -> binary_not_found');
        const bogus = parseToolResult(await request('tools/call', {
            name: 'lldb_start',
            arguments: { binary: '/definitely/does/not/exist/xyzzy' },
        }));
        if (bogus.isError && bogus.value?.code === 'binary_not_found') ok('binary_not_found surfaced');
        else { bad(`expected binary_not_found, got: ${JSON.stringify(bogus)}`); failures++; }

        info('lldb_start with /bin/ls');
        const started = parseToolResult(await request('tools/call', {
            name: 'lldb_start',
            arguments: { binary: '/bin/ls' },
        }, 15000));
        if (started.isError) { bad(`lldb_start failed: ${JSON.stringify(started)}`); failures++; throw new Error('cannot proceed'); }
        const sid = started.value?.session_id;
        if (typeof sid === 'number') ok(`lldb_start -> session_id=${sid}`);
        else { bad(`no session_id: ${JSON.stringify(started)}`); failures++; throw new Error('cannot proceed'); }

        info('lldb_command: breakpoint set --name main');
        const bp = parseToolResult(await request('tools/call', {
            name: 'lldb_command',
            arguments: { session_id: sid, command: 'breakpoint set --name main' },
        }));
        if (!bp.isError && typeof bp.value?.output === 'string' && /breakpoint/i.test(bp.value.output)) {
            ok(`breakpoint set: ${bp.value.output.split('\n')[0]}`);
        } else { bad(`breakpoint set unexpected: ${JSON.stringify(bp)}`); failures++; }

        info('lldb_command: version');
        const ver = parseToolResult(await request('tools/call', {
            name: 'lldb_command',
            arguments: { session_id: sid, command: 'version' },
        }));
        if (!ver.isError && /lldb-/i.test(ver.value?.output || '')) ok(`version: ${ver.value.output.split('\n')[0]}`);
        else { bad(`version unexpected: ${JSON.stringify(ver)}`); failures++; }

        info('lldb_command: run -> process_command_rejected (guardrail)');
        const rejected = parseToolResult(await request('tools/call', {
            name: 'lldb_command',
            arguments: { session_id: sid, command: 'run' },
        }));
        if (rejected.isError && rejected.value?.code === 'process_command_rejected') ok('process_command_rejected surfaced');
        else { bad(`expected process_command_rejected, got: ${JSON.stringify(rejected)}`); failures++; }

        info('lldb_command: process status -> safe (guardrail allowlist)');
        const procStatus = parseToolResult(await request('tools/call', {
            name: 'lldb_command',
            arguments: { session_id: sid, command: 'process status' },
        }));
        if (!procStatus.isError && typeof procStatus.value?.output === 'string') ok('process status passed guardrail');
        else { bad(`process status unexpected: ${JSON.stringify(procStatus)}`); failures++; }

        info('lldb_command on bogus session_id -> session_not_found');
        const nofound = parseToolResult(await request('tools/call', {
            name: 'lldb_command',
            arguments: { session_id: 9999, command: 'version' },
        }));
        if (nofound.isError && nofound.value?.code === 'session_not_found') ok('session_not_found surfaced');
        else { bad(`expected session_not_found, got: ${JSON.stringify(nofound)}`); failures++; }

        info('lldb_stop');
        const stopped = parseToolResult(await request('tools/call', {
            name: 'lldb_stop',
            arguments: { session_id: sid },
        }, 5000));
        if (!stopped.isError && stopped.value?.ok === true) ok('lldb_stop OK');
        else { bad(`lldb_stop unexpected: ${JSON.stringify(stopped)}`); failures++; }

        info('lldb_stop twice -> session_not_found');
        const stopAgain = parseToolResult(await request('tools/call', {
            name: 'lldb_stop',
            arguments: { session_id: sid },
        }));
        if (stopAgain.isError && stopAgain.value?.code === 'session_not_found') ok('double-stop surfaced session_not_found');
        else { bad(`expected session_not_found on double-stop, got: ${JSON.stringify(stopAgain)}`); failures++; }

        // --- Slow preload scenarios (real-workload shape) ---
        //
        // A preload that blocks in `run` longer than the socket-wait
        // budget must fail fast with `socket_never_appeared`, and must
        // succeed when the caller raises `socket_wait_ms`.
        //
        // Fixture: a tiny C binary that sleeps 7 s and exits. Under
        // macOS SIP, `/bin/sleep` is unavailable as a debug target, so
        // we build our own. `run` blocks until the process exits (no
        // breakpoint needed), so the default 5000 ms budget is
        // guaranteed to fire, and a 15000 ms budget is guaranteed to
        // let the socket appear.

        info('building slow-preload fixture (cc -g)');
        let fixture = null;
        try {
            fixture = await buildSlowFixture(7);
            ok(`fixture built: ${fixture.binary}`);
        } catch (err) {
            bad(`fixture build failed: ${err.message}`);
            failures++;
        }

        if (fixture) {
            info('lldb_start with slow preload + default timeout -> socket_never_appeared');
            const tooSlow = parseToolResult(await request('tools/call', {
                name: 'lldb_start',
                arguments: {
                    binary: fixture.binary,
                    preload: ['run'],
                },
            }, 15000));
            if (tooSlow.isError && tooSlow.value?.code === 'socket_never_appeared') {
                ok('socket_never_appeared fires under default timeout');
            } else {
                bad(`expected socket_never_appeared, got: ${JSON.stringify(tooSlow)}`);
                failures++;
            }

            info('lldb_start with slow preload + raised socket_wait_ms -> session_id');
            const okSlow = parseToolResult(await request('tools/call', {
                name: 'lldb_start',
                arguments: {
                    binary: fixture.binary,
                    preload: ['run'],
                    socket_wait_ms: 15000,
                },
            }, 25000));
            const slowSid = okSlow.value?.session_id;
            if (!okSlow.isError && typeof slowSid === 'number') {
                ok(`slow preload succeeded -> session_id=${slowSid}`);
            } else {
                bad(`expected session_id, got: ${JSON.stringify(okSlow)}`);
                failures++;
            }

            if (typeof slowSid === 'number') {
                info(`lldb_stop slow session ${slowSid}`);
                const stopSlow = parseToolResult(await request('tools/call', {
                    name: 'lldb_stop',
                    arguments: { session_id: slowSid },
                }, 5000));
                if (!stopSlow.isError && stopSlow.value?.ok === true) {
                    ok('lldb_stop (slow session) OK');
                } else {
                    bad(`lldb_stop (slow) unexpected: ${JSON.stringify(stopSlow)}`);
                    failures++;
                }
            }

            await fixture.cleanup().catch(() => {});
        }

    } finally {
        // Close stdin to trigger orchestrator cleanup path.
        child.stdin.end();
        await new Promise((resolve) => {
            const t = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch {}
                resolve();
            }, 3000);
            child.once('exit', () => { clearTimeout(t); resolve(); });
        });
    }

    // Post-conditions
    await new Promise(r => setTimeout(r, 300));
    const leftover = await listSocketFiles();
    if (leftover.length === 0) ok('no leftover /tmp/rust-lldb-mcp.* sockets');
    else { bad(`leftover sockets: ${leftover.join(', ')}`); failures++; }

    const procs = await countLldbProcs();
    if (procs === 0) ok('no orphan rust-lldb processes');
    else { bad(`${procs} orphan lldb-related process(es) still running`); failures++; }

    if (failures === 0) {
        console.log(color('32', '\nSmoke test: all checks passed.'));
    } else {
        console.log(color('31', `\nSmoke test: ${failures} check(s) failed.`));
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(color('31', 'Harness error:'), err);
    process.exit(2);
});
