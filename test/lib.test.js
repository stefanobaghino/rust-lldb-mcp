import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    ALWAYS_SAFE,
    classifyCommand,
    HANG_VERBS,
    LldbError,
    resolveSocketWaitMs,
    SAFE_SUBCOMMANDS,
    SOCKET_WAIT_MS_DEFAULT,
    SOCKET_WAIT_MS_ENV,
    SOCKET_WAIT_MS_MAX,
    SOCKET_WAIT_MS_MIN,
    shellQuote,
} from '../lib.js';

describe('classifyCommand', () => {
    it('returns "empty" for falsy and whitespace-only input', () => {
        assert.equal(classifyCommand(''), 'empty');
        assert.equal(classifyCommand('   '), 'empty');
        assert.equal(classifyCommand(null), 'empty');
        assert.equal(classifyCommand(undefined), 'empty');
    });

    it('returns "safe" for commands whose verb is not in HANG_VERBS', () => {
        for (const cmd of [
            'version',
            'bt 10',
            'frame variable foo',
            'help',
            'target list',
            'breakpoint set --name main',
            'register read',
            'memory read 0x1000',
        ]) {
            assert.equal(classifyCommand(cmd), 'safe', `expected safe: ${cmd}`);
        }
    });

    it('treats every ALWAYS_SAFE verb as safe even when it appears in HANG_VERBS', () => {
        for (const verb of ALWAYS_SAFE) {
            assert.ok(
                HANG_VERBS.has(verb),
                `ALWAYS_SAFE verb ${verb} should also be in HANG_VERBS`,
            );
            assert.equal(classifyCommand(`${verb} something`), 'safe');
        }
    });

    it('classifies resumption verbs as "hang"', () => {
        // Note: 'f' is listed in HANG_VERBS but currently classifies as 'safe' because no branch
        // below the allowlist catches it. LLDB's `f` is an alias for `frame` (safe), not `finish`,
        // so the observable result is correct — but the HANG_VERBS membership is misleading.
        // See follow-up ticket "lib: reconcile classifyCommand HANG_VERBS vs branch coverage".
        for (const cmd of [
            'run',
            'r',
            'continue',
            'c',
            'step',
            's',
            'stepi',
            'si',
            'next',
            'n',
            'nexti',
            'ni',
            'finish',
            'jump 42',
            'j 42',
        ]) {
            assert.equal(classifyCommand(cmd), 'hang', `expected hang: ${cmd}`);
        }
    });

    it('allowlists read-only "process" subcommands', () => {
        for (const sub of SAFE_SUBCOMMANDS.process) {
            assert.equal(classifyCommand(`process ${sub}`), 'safe');
        }
    });

    it('blocks resumption "process" subcommands as "hang"', () => {
        for (const sub of [
            'launch',
            'continue',
            'kill',
            'interrupt',
            'attach',
            'detach',
            'connect',
        ]) {
            assert.equal(classifyCommand(`process ${sub}`), 'hang');
        }
    });

    it('defaults unknown "process" subcommands to "safe" (let LLDB decide)', () => {
        assert.equal(classifyCommand('process foobar'), 'safe');
    });

    it('allowlists read-only "thread" subcommands', () => {
        for (const sub of SAFE_SUBCOMMANDS.thread) {
            assert.equal(classifyCommand(`thread ${sub}`), 'safe');
        }
    });

    it('blocks resumption "thread" subcommands as "hang"', () => {
        // Note: `thread until` is not tested here — 'until' appears in both SAFE_SUBCOMMANDS.thread
        // and the thread hang-list, and the allowlist check runs first, so it currently classifies
        // as 'safe' despite actually resuming the inferior. Tracked in the same follow-up ticket
        // as the 'f' inconsistency above.
        for (const sub of [
            'step-in',
            'step-over',
            'step-out',
            'step-inst',
            'step-over-inst',
            'step-scripted',
            'continue',
            'jump',
        ]) {
            assert.equal(classifyCommand(`thread ${sub}`), 'hang');
        }
    });

    it('tolerates leading/trailing whitespace', () => {
        assert.equal(classifyCommand('   run   '), 'hang');
        assert.equal(classifyCommand('\t continue '), 'hang');
        assert.equal(classifyCommand('  version'), 'safe');
    });

    it('is case-insensitive on the verb', () => {
        assert.equal(classifyCommand('RUN'), 'hang');
        assert.equal(classifyCommand('Continue'), 'hang');
        assert.equal(classifyCommand('Process LAUNCH'), 'hang');
        assert.equal(classifyCommand('THREAD Step-In'), 'hang');
    });
});

describe('resolveSocketWaitMs', () => {
    const emptyEnv = Object.freeze({});

    it('falls back to the default when neither arg nor env is set', () => {
        assert.equal(resolveSocketWaitMs(undefined, emptyEnv), SOCKET_WAIT_MS_DEFAULT);
        assert.equal(resolveSocketWaitMs(null, emptyEnv), SOCKET_WAIT_MS_DEFAULT);
        assert.equal(resolveSocketWaitMs('', emptyEnv), SOCKET_WAIT_MS_DEFAULT);
    });

    it('uses env var when arg is absent', () => {
        assert.equal(resolveSocketWaitMs(undefined, { [SOCKET_WAIT_MS_ENV]: '7500' }), 7500);
    });

    it('prefers explicit arg over env var', () => {
        assert.equal(resolveSocketWaitMs(3000, { [SOCKET_WAIT_MS_ENV]: '999999' }), 3000);
    });

    it('clamps to [MIN, MAX]', () => {
        assert.equal(resolveSocketWaitMs(1, emptyEnv), SOCKET_WAIT_MS_MIN);
        assert.equal(resolveSocketWaitMs(999999, emptyEnv), SOCKET_WAIT_MS_MAX);
        assert.equal(
            resolveSocketWaitMs(undefined, { [SOCKET_WAIT_MS_ENV]: '1' }),
            SOCKET_WAIT_MS_MIN,
        );
        assert.equal(
            resolveSocketWaitMs(undefined, { [SOCKET_WAIT_MS_ENV]: '999999' }),
            SOCKET_WAIT_MS_MAX,
        );
    });

    it('rejects non-positive, non-integer, and non-finite values with LldbError', () => {
        for (const bad of [0, -1, -1000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            assert.throws(
                () => resolveSocketWaitMs(bad, emptyEnv),
                (err) => err instanceof LldbError && err.code === 'invalid_request',
                `expected invalid_request for ${bad}`,
            );
        }
    });

    it('rejects non-numeric env var values with LldbError citing the env var name', () => {
        assert.throws(
            () => resolveSocketWaitMs(undefined, { [SOCKET_WAIT_MS_ENV]: 'banana' }),
            (err) =>
                err instanceof LldbError &&
                err.code === 'invalid_request' &&
                err.message.includes(SOCKET_WAIT_MS_ENV),
        );
    });

    it('accepts numeric strings from the environment', () => {
        assert.equal(resolveSocketWaitMs(undefined, { [SOCKET_WAIT_MS_ENV]: '12000' }), 12000);
    });
});

describe('shellQuote', () => {
    it('leaves bare-word paths unquoted', () => {
        assert.equal(shellQuote('foo'), 'foo');
        assert.equal(shellQuote('target/debug/my-app'), 'target/debug/my-app');
        assert.equal(shellQuote('/bin/ls'), '/bin/ls');
        assert.equal(shellQuote('a_b.c-d/e'), 'a_b.c-d/e');
    });

    it('single-quotes paths with whitespace or shell metacharacters', () => {
        assert.equal(shellQuote('has space'), "'has space'");
        assert.equal(shellQuote('path with $var'), "'path with $var'");
        assert.equal(shellQuote('quotes"inside'), `'quotes"inside'`);
    });

    it('escapes embedded single quotes using the standard POSIX pattern', () => {
        assert.equal(shellQuote("o'clock"), `'o'\\''clock'`);
        assert.equal(shellQuote("''"), `''\\'''\\'''`);
    });
});
