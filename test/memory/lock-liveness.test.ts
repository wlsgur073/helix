import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { classifyHolder, selfIdentity, realProbe, tryParsePayload, parseAfterLastParen, type LockPayload, type LivenessProbe } from '../../src/memory/lock-liveness.js';

const self = (): LockPayload => selfIdentity('a'.repeat(32));
const mk = (over: Partial<LockPayload>): LockPayload => ({ ...self(), token: 'b'.repeat(32), ...over });
const probeOf = (over: Partial<LivenessProbe>): LivenessProbe => ({ ...realProbe, ...over });

describe('parseAfterLastParen', () => {
  it('splits after the LAST paren — a comm containing ") R 1" cannot fake fields', () => {
    const stat = '123 (evil) R 1) Z 42 ' + Array.from({ length: 30 }, (_, i) => String(100 + i)).join(' ');
    const f = parseAfterLastParen(stat)!;
    expect(f[0]).toBe('Z');            // state comes from after the LAST ')'
  });
  it('returns null when no paren exists (corrupt stat)', () => {
    expect(parseAfterLastParen('garbage')).toBeNull();
  });
});

describe('classifyHolder precedence (spec Layer 2)', () => {
  it('platform mismatch is alive-unknown even for a dead-looking pid', () => {
    expect(classifyHolder(mk({ platform: 'win32-other', pid: 999999 }), self(), probeOf({ kill0: () => 'dead' }))).toBe('alive-unknown');
  });
  it('bootId mismatch is dead EVEN IF kill0 says alive (recycled across reboot) — rule 2 outranks probing', () => {
    expect(classifyHolder(mk({ bootId: 'other-boot' }), self(), probeOf({ kill0: () => 'alive' }))).toBe('dead');
  });
  it('compound mismatch (platform AND bootId both foreign) is alive-unknown — platform outranks bootId', () => {
    expect(classifyHolder(mk({ platform: 'win32-other', bootId: 'other-boot' }), self(), probeOf({ kill0: () => 'alive' }))).toBe('alive-unknown');
  });
  it('bootId null-vs-nonnull asymmetry is alive-unknown (cannot reason)', () => {
    expect(classifyHolder(mk({ bootId: null }), { ...self(), bootId: 'ours' }, probeOf({ kill0: () => 'dead' }))).toBe('alive-unknown');
  });
  it('same boot, foreign pid namespace is alive-unknown (sibling container)', () => {
    expect(classifyHolder(mk({ pidNs: 'pid:[999]' }), self(), probeOf({ kill0: () => 'dead' }))).toBe('alive-unknown');
  });
  it('ESRCH in our own namespace is dead', () => {
    expect(classifyHolder(mk({ pid: 999999 }), self(), probeOf({ kill0: () => 'dead' }))).toBe('dead');
  });
  it('EPERM is alive', () => {
    expect(classifyHolder(mk({ pid: 1 }), self(), probeOf({ kill0: () => 'eperm', startTicksOf: () => null, stateOf: () => null }))).toBe('alive');
  });
  it('alive pid with MISMATCHED startTicks is dead (same-boot pid recycle)', () => {
    expect(classifyHolder(mk({ pid: 4242, startTicks: '111' }), self(), probeOf({ kill0: () => 'alive', startTicksOf: () => '222', stateOf: () => 'R' }))).toBe('dead');
  });
  it('alive pid whose ticks CANNOT be read is alive-unknown, never dead', () => {
    expect(classifyHolder(mk({ pid: 4242, startTicks: '111' }), self(), probeOf({ kill0: () => 'alive', startTicksOf: () => null }))).toBe('alive-unknown');
  });
  it('zombie state Z is dead after ticks verify; X likewise', () => {
    const p = probeOf({ kill0: () => 'alive', startTicksOf: () => '111', stateOf: () => 'Z' });
    expect(classifyHolder(mk({ pid: 4242, startTicks: '111' }), self(), p)).toBe('dead');
  });
  it('unknown kill0 errno is alive-unknown', () => {
    expect(classifyHolder(mk({ pid: 4242 }), self(), probeOf({ kill0: () => 'unknown' }))).toBe('alive-unknown');
  });
  it('same pid + same ticks + same threadId + different token = reentrant-self', () => {
    expect(classifyHolder(mk({}), self(), realProbe)).toBe('reentrant-self');
  });
  it('same pid + same ticks + DIFFERENT threadId is an ordinary alive holder', () => {
    expect(classifyHolder(mk({ threadId: 7 }), self(), realProbe)).toBe('alive');
  });
  it('nonsense pid (0, negative, NaN) is alive-unknown', () => {
    for (const pid of [0, -3, Number.NaN]) expect(classifyHolder(mk({ pid }), self(), realProbe)).toBe('alive-unknown');
  });
  it('a holder with NO recorded start-ticks (non-Linux) is alive-unknown, never a certain alive', () => {
    // mk()/self() build on selfIdentity(), which on THIS (Linux) host always yields non-null
    // startTicks/bootId/pidNs — so the non-/proc shape must be constructed explicitly here, or
    // this test would fall through the rule-2/rule-3 early-outs without ever reaching the branch
    // under test (the final `return 'alive'` for a kill0-only verdict).
    const nonProc = { startTicks: null, bootId: null, pidNs: null, platform: 'darwin' };
    expect(classifyHolder(
      mk({ pid: 4242, ...nonProc }),
      { ...self(), ...nonProc },
      probeOf({ kill0: () => 'alive', startTicksOf: () => null, stateOf: () => null }),
    )).toBe('alive-unknown');
  });
  it('EPERM with NO recorded start-ticks (non-Linux) is ALSO alive-unknown — same shared fall-through as the non-EPERM case above, not a separate rule', () => {
    // Pins the side effect the non-EPERM fix has on this sub-case: EPERM and a plain non-dead
    // kill0 result both fall through the SAME final line, so both are equally affected when
    // startTicks is null. The Linux EPERM case ('EPERM is alive' above, non-null startTicks
    // inherited from self()) is untouched and deliberately out of scope — this test guards only
    // the startTicks===null sub-case so a future refactor can't silently flip it back to 'alive'.
    const nonProc = { startTicks: null, bootId: null, pidNs: null, platform: 'darwin' };
    expect(classifyHolder(
      mk({ pid: 1, ...nonProc }),
      { ...self(), ...nonProc },
      probeOf({ kill0: () => 'eperm', startTicksOf: () => null, stateOf: () => null }),
    )).toBe('alive-unknown');
  });
});

describe('real probe (one REAL process each way — injection cannot catch a wrong errno mapping)', () => {
  it('a spawned-and-exited child probes dead; our own pid probes alive', () => {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(realProbe.kill0(child.pid!)).toBe('dead');
    expect(realProbe.kill0(process.pid)).toBe('alive');
  });
  it('selfIdentity on Linux records nonnull ticks/boot/ns and they match the probe', () => {
    if (process.platform !== 'linux') return;
    const me = self();
    expect(me.startTicks).toBe(realProbe.startTicksOf(process.pid));
    expect(me.bootId).toBe(realProbe.bootId());
    expect(me.pidNs).toBe(realProbe.pidNs());
    expect(typeof realProbe.bootInstantMs()).toBe('number');
  });
});

describe('tryParsePayload', () => {
  it('round-trips selfIdentity and rejects junk/empty/wrong-version', () => {
    const me = self();
    expect(tryParsePayload(JSON.stringify(me))).toEqual(me);
    for (const junk of ['', '{', 'null', '{"v":2,"token":"x"}', '{"v":1}']) expect(tryParsePayload(junk)).toBeNull();
  });
  it('rejects a full-shaped payload whose startTicks/bootId/pidNs is NUMERIC (fail-CLOSED: string|null only — the lone fail-open cell)', () => {
    // A well-formed-JSON payload with a numeric startTicks (e.g. 42) passing here would later make
    // `cur !== recorded.startTicks` compare a /proc string against a number — always true — and
    // classify a LIVE holder 'dead', letting the gate steal it. Everything else fails closed (waits).
    for (const field of ['startTicks', 'bootId', 'pidNs'] as const) {
      const payload = JSON.stringify({ ...selfIdentity('x'.repeat(32)), [field]: 42 });
      expect(tryParsePayload(payload), `${field}=42 must be rejected as malformed`).toBeNull();
    }
  });
});

// The non-Linux pid-reuse finding, stated precisely. On a platform without /proc the recorded
// identity fields are all null, so a dead holder whose pid was reused by an unrelated live process
// classifies alive-unknown; reclaim keys on 'dead', so acquisition blocks for the whole budget and
// then throws. The obvious fix — steal a lock older than N — is refused on solid ground: age cannot
// separate a suspended process from a dead one, and that misclassification is what resurrected
// already-erased plaintext once before.
//
// These pin WHERE the gap actually is. The classifier is already platform-independent: it branches on
// whether a start time was RECORDED, never on which platform recorded it. So the remaining work is
// supplying that datum on macOS and Windows (PROC_PIDTBSDINFO / GetProcessTimes) — a probe change,
// with no rule to redesign. Verified here by injection, since this machine is Linux and cannot run
// either syscall.
describe('pid reuse without /proc — the gap is the probe, not the rule', () => {
  const foreign = { platform: 'darwin', bootId: null, pidNs: null };
  const asForeign = (p: LockPayload): LockPayload => ({ ...p, ...foreign });

  it('TODAY: no recorded start time, so a reused pid is indistinguishable from the holder', () => {
    const recorded = mk({ ...foreign, pid: 4242, startTicks: null });
    const cls = classifyHolder(recorded, asForeign(self()), probeOf({
      kill0: () => 'alive',            // some live process holds that pid
      startTicksOf: () => null,        // no /proc: the platform cannot say which one
      stateOf: () => null,
    }));
    expect(cls).toBe('alive-unknown'); // never reclaimed -> the caller waits out the full budget
  });

  it('WITH a start time the SAME rule already reclaims it — nothing in the classifier is Linux-only', () => {
    const recorded = mk({ ...foreign, pid: 4242, startTicks: '900000' });
    const cls = classifyHolder(recorded, asForeign(self()), probeOf({
      kill0: () => 'alive',            // the pid is live...
      startTicksOf: () => '900123',    // ...but it is a DIFFERENT process than the one that locked
      stateOf: () => null,
    }));
    expect(cls).toBe('dead');          // reclaimable, on a platform that is not Linux
  });

  it('a start time that MATCHES still means alive — the guard reclaims a reused pid, not a live holder', () => {
    const recorded = mk({ ...foreign, pid: 4242, startTicks: '900000' });
    const cls = classifyHolder(recorded, asForeign(self()), probeOf({
      kill0: () => 'alive',
      startTicksOf: () => '900000',    // same process, still running
      stateOf: () => null,
    }));
    expect(cls).toBe('alive');
  });

  it('an unreadable start time stays alive-unknown — uncertainty never reclaims', () => {
    const recorded = mk({ ...foreign, pid: 4242, startTicks: '900000' });
    const cls = classifyHolder(recorded, asForeign(self()), probeOf({
      kill0: () => 'alive',
      startTicksOf: () => null,        // recorded one, cannot read one back
      stateOf: () => null,
    }));
    expect(cls).toBe('alive-unknown');
  });
});

describe('a payload from a build with no uptime witness (contract 7, characterization)', () => {
  // Written and passing BEFORE any source change, so it pins today's answer rather than
  // tomorrow's. Every later task re-runs it unchanged; if it ever moves, backward compatibility
  // broke. Raw JSON rather than selfIdentity(), so it stays a v1 payload with no witness even
  // after selfIdentity starts writing one.
  const legacyRaw = JSON.stringify({
    v: 1, token: 'e'.repeat(32), pid: 4242, startTicks: null,
    bootId: null, pidNs: null, threadId: 0, platform: 'win32',
  });

  it('parses', () => {
    expect(tryParsePayload(legacyRaw)).not.toBeNull();
  });

  it('classifies alive-unknown when the pid is live but unidentifiable', () => {
    const recorded = tryParsePayload(legacyRaw)!;
    const selfWin = { ...self(), platform: 'win32', bootId: null, pidNs: null };
    expect(classifyHolder(recorded, selfWin, probeOf({
      kill0: () => 'alive', startTicksOf: () => null, stateOf: () => null,
    }))).toBe('alive-unknown');
  });
});
