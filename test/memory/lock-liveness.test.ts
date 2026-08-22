import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { classifyHolder, selfIdentity, realProbe, tryParsePayload, parseAfterLastParen, gateUptime, type LockPayload, type LivenessProbe } from '../../src/memory/lock-liveness.js';

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

describe('the uptime policy gate (contracts 2 and 10a)', () => {
  it('contract 2: the derived boot instant precedes this process own start', () => {
    // An INVARIANT, run unmocked, that must hold both before and after the change — which is what
    // makes it catch a wrong unit or a flipped sign introduced by the change. The expectation is
    // computed from process.uptime(), never from the code under test, so a defect cannot move both
    // sides together. A missing `* 1000` or a `+` would put the result near Date.now(), far above.
    const boot = realProbe.bootInstantMs()!;
    expect(boot).toBeLessThan(Date.now() - process.uptime() * 1000 + 1_000);
  });

  it('contract 10a: the gate admits linux and win32 and refuses everything else', () => {
    expect(gateUptime('linux', 5_000)).toBe(5_000);
    expect(gateUptime('win32', 5_000)).toBe(5_000);
    expect(gateUptime('darwin', 5_000)).toBeNull();   // kern.boottime + time(NULL) are read apart
    expect(gateUptime('aix', 5_000)).toBeNull();      // unproven backend: refuse by default
    expect(gateUptime('linux', null)).toBeNull();     // no reading is not a reading
  });
});

describe('the uptime witness field (contract 6)', () => {
  const raw = (uptimeSecLiteral: string): string =>
    `{"v":1,"token":"${'f'.repeat(32)}","pid":4242,"startTicks":null,"bootId":null,` +
    `"pidNs":null,"threadId":0,"platform":"win32","uptimeSec":${uptimeSecLiteral}}`;

  it('selfIdentity records a finite uptime on an allowlisted platform', () => {
    expect(Number.isFinite(selfIdentity('a'.repeat(32)).uptimeSec)).toBe(true);   // this host is linux
  });

  it('a present but non-numeric uptimeSec is REJECTED, not coerced', () => {
    // The same fail-OPEN shape isStringOrNull exists for: a wrongly typed field that survives
    // parsing goes on to be compared, and a bad comparison here mis-classifies a LIVE holder.
    expect(tryParsePayload(raw('"1225"'))).toBeNull();
    expect(tryParsePayload(raw('true'))).toBeNull();
    expect(tryParsePayload(raw('{"s":1}'))).toBeNull();
  });

  it('a present but NON-FINITE uptimeSec is rejected — reachable from raw JSON, unlike Infinity', () => {
    // JSON cannot spell Infinity, so serialising it yields null and looks unreachable. PARSING is
    // different: the literal 1e309 overflows to Infinity. Measured, not assumed.
    expect(JSON.parse('{"u":1e309}').u).toBe(Infinity);
    expect(tryParsePayload(raw('1e309'))).toBeNull();
  });

  it('accepts a finite number (including zero) and an explicit null', () => {
    expect(tryParsePayload(raw('1225.5'))!.uptimeSec).toBe(1225.5);
    expect(tryParsePayload(raw('0'))!.uptimeSec).toBe(0);   // 0 is a legal uptime — `??` must keep it, not fold it into null like `||` would
    expect(tryParsePayload(raw('null'))!.uptimeSec).toBeNull();
  });

  it('a payload from an older build, with the field absent, parses and NORMALISES to null', () => {
    const older = JSON.parse(raw('null')) as Record<string, unknown>;
    delete older.uptimeSec;
    const parsed = tryParsePayload(JSON.stringify(older));
    expect(parsed).not.toBeNull();
    expect(parsed!.uptimeSec).toBeNull();
  });
});

describe('cross-boot uptime witness (contracts 3, 4, 5, 8)', () => {
  const win = { platform: 'win32', bootId: null, pidNs: null };
  const asWin = (p: LockPayload): LockPayload => ({ ...p, ...win, uptimeSec: 5_000 });

  it('contract 3: a recorded uptime ABOVE the fresh sample is dead', () => {
    const recorded = mk({ ...win, pid: 4242, startTicks: null, uptimeSec: 5_000 });
    expect(classifyHolder(recorded, asWin(self()), probeOf({
      uptimeSec: () => 10,             // the machine has been up 10 s; the holder recorded 5000
      kill0: () => 'alive',            // and some live process now holds that pid
      startTicksOf: () => null, stateOf: () => null,
    }))).toBe('dead');
  });

  it('contract 4: a recorded uptime EQUAL to the fresh sample is alive-unknown', () => {
    // Uptime is coarse, so a waiter can legitimately read the value the holder recorded.
    // Relaxing the strict < to <= here manufactures a false dead and steals a live lock.
    const recorded = mk({ ...win, pid: 4242, startTicks: null, uptimeSec: 5_000 });
    expect(classifyHolder(recorded, asWin(self()), probeOf({
      uptimeSec: () => 5_000,
      kill0: () => 'alive', startTicksOf: () => null, stateOf: () => null,
    }))).toBe('alive-unknown');
  });

  it('contract 5: Darwin stays alive-unknown even with a recorded uptime above the sample', () => {
    const mac = { platform: 'darwin', bootId: null, pidNs: null };
    const recorded = mk({ ...mac, pid: 4242, startTicks: null, uptimeSec: 5_000 });
    expect(classifyHolder(recorded, { ...self(), ...mac, uptimeSec: 5_000 }, probeOf({
      uptimeSec: () => 10,             // would be 'dead' on an allowlisted platform
      kill0: () => 'alive', startTicksOf: () => null, stateOf: () => null,
    }))).toBe('alive-unknown');
  });

  it('contract 8: the sample is taken at CLASSIFICATION time, not from the pre-loop self snapshot', () => {
    // The defect this locks out: lock.ts's acquireFileLock builds `self` ONCE (via selfIdentity)
    // before the `for (;;)` retry loop, and its classifyHolder(parsed, self, probe) call inside
    // that loop reuses that snapshot every iteration. A rule reading self.uptimeSec would compare a
    // stale reading against a lock acquired AFTER the waiter started, see now < recorded, and steal
    // a live holder's lock. Three DISTINCT values, so the result alone identifies which reading was
    // used: 200 for the stale snapshot, 150 recorded, 100 fresh. Only the fresh reading yields dead
    // — 200 < 150 is false, so an implementation reading the snapshot answers alive-unknown. The
    // RESULT carries the proof; no call-count assertion, which would pin a count no contract fixes.
    const seq = [200, 100];
    let calls = 0;
    const probe = probeOf({
      uptimeSec: () => seq[calls++] ?? 100,
      kill0: () => 'alive', startTicksOf: () => null, stateOf: () => null,
    });
    const staleSelf = { ...selfIdentity('c'.repeat(32), probe), ...win };
    expect(staleSelf.uptimeSec).toBe(200);            // the snapshot really is the first reading
    const recorded = mk({ ...win, pid: 4242, startTicks: null, uptimeSec: 150 });
    expect(classifyHolder(recorded, staleSelf, probe)).toBe('dead');
  });

  it('ruling T2-1: a negative fresh sample never classifies dead, even against a positive recorded uptime', () => {
    // Task 2's review found that a negative uptimeSec passes the "finite" validator. A negative
    // RECORDED value is harmless — it only makes `now < recorded` harder to satisfy. But a negative
    // FRESH sample against a positive recorded value DOES satisfy `now < recorded`, and an unguarded
    // rule would answer dead: a stolen live lock, the one outcome this module forbids outright. No
    // real source goes negative (Linux reads /proc/uptime or CLOCK_BOOTTIME, Windows reads
    // GetTickCount64()), so this is a nonsense reading rather than a live scenario — but uncertainty
    // resolves to alive-unknown here, never to evidence.
    const recorded = mk({ ...win, pid: 4242, startTicks: null, uptimeSec: 5_000 });
    expect(classifyHolder(recorded, asWin(self()), probeOf({
      uptimeSec: () => -1,
      kill0: () => 'alive', startTicksOf: () => null, stateOf: () => null,
    }))).toBe('alive-unknown');
  });

  it('a null fresh sample never classifies dead — an allowlisted platform whose probe could not read uptime this round', () => {
    // The `now !== null` conjunct, isolated the same way ruling T2-1 isolates non-negativity: a
    // gated sampler can still come back null (rawUptimeSec's own try/catch, or a probe that fails
    // this one call), and that is uncertainty — never evidence of a different boot.
    const recorded = mk({ ...win, pid: 4242, startTicks: null, uptimeSec: 5_000 });
    expect(classifyHolder(recorded, asWin(self()), probeOf({
      uptimeSec: () => null,
      kill0: () => 'alive', startTicksOf: () => null, stateOf: () => null,
    }))).toBe('alive-unknown');
  });

  it('a non-finite fresh sample never classifies dead — NaN/Infinity is uncertainty, not a low reading', () => {
    // The `Number.isFinite(now)` conjunct, isolated the same way. A non-finite reading must not be
    // compared against the recorded uptime at all, even though `Infinity < recorded.uptimeSec` is
    // false anyway here — a differently-shaped recorded value must not change this verdict.
    const recorded = mk({ ...win, pid: 4242, startTicks: null, uptimeSec: 5_000 });
    expect(classifyHolder(recorded, asWin(self()), probeOf({
      uptimeSec: () => Infinity,
      kill0: () => 'alive', startTicksOf: () => null, stateOf: () => null,
    }))).toBe('alive-unknown');
  });

  it('ruling T3-1: rule 2b requires matching pidNs too — a container waiter must not "prove" a live host holder dead via a lower virtualized /proc/uptime reading', () => {
    // boot_id is NOT namespaced, so a sibling container reads the host's own value — it matches here
    // naturally (both sides are real values read from this Linux host, exactly as in the pre-existing
    // "same boot, foreign pid namespace" test above) and rule 2 stays silent. /proc/uptime IS
    // virtualized under lxcfs: without the pidNs conjunct in usableUptimeWitness, a container waiter
    // sampling a lower reading than a live HOST holder recorded would satisfy `now < recorded` and
    // steal that live lock. Only pidNs differs from a real, matching, self()-derived fixture.
    const recorded = mk({ pidNs: 'pid:[999]', pid: 4242, startTicks: null, uptimeSec: 5_000 });
    expect(classifyHolder(recorded, self(), probeOf({
      uptimeSec: () => 10,              // the container's own, virtualization-lowered reading
      kill0: () => 'alive', startTicksOf: () => null, stateOf: () => null,
    }))).toBe('alive-unknown');
  });
});
