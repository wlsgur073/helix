import { describe, it, expect } from 'vitest';
import { detectSecret, findSecrets, redactSecrets, isHexCore } from '../../src/memory/secret-scan.js';
import { normalizeUntrusted } from '../../src/memory/content-frame.js';

describe('secret scanner', () => {
  it('flags PEM private key blocks', () => {
    expect(detectSecret('-----BEGIN RSA PRIVATE KEY-----\nMIIE...').hit).toBe(true);
  });
  it('flags AWS-style access keys and bearer/api tokens', () => {
    expect(detectSecret('AKIAIOSFODNN7EXAMPLE').hit).toBe(true);
    expect(detectSecret('authorization: Bearer ghp' + '_aBcD1234EfGh5678IjKl9012MnOp34Qr56').hit).toBe(true);
  });
  it('flags password= assignments (even when prefixed, e.g. db_password=)', () => {
    expect(detectSecret('db_password=Sup3rS3cretValue!').hit).toBe(true);
  });
  it('flags a high-entropy long token', () => {
    expect(detectSecret('token n2Xk9Lp4Qa7Zr3Vy8Wb1Mc6Td0Hs5Jf').hit).toBe(true);
  });
  it('does NOT flag ordinary prose', () => {
    expect(detectSecret('The migration script rewrites the users table.').hit).toBe(false);
  });

  // Kind precision: a named pattern must label the redaction (not the entropy catch-all),
  // so audit lines and inspect output say WHAT was redacted.
  it('labels OpenAI / Anthropic API keys by kind', () => {
    expect(detectSecret('OPENAI key sk' + '-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56')).toEqual({ hit: true, kind: 'openai-key' });
    expect(detectSecret('sk-ant' + '-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78')).toEqual({ hit: true, kind: 'anthropic-key' });
  });

  it('labels Slack, Google, and npm tokens by kind', () => {
    expect(detectSecret('xoxb' + '-2912345678-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx')).toEqual({ hit: true, kind: 'slack-token' });
    expect(detectSecret('maps key AIza' + 'SyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tUv')).toEqual({ hit: true, kind: 'google-api-key' });
    expect(detectSecret('npm' + '_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dE3fG')).toEqual({ hit: true, kind: 'npm-token' });
  });

  it('labels GitHub fine-grained PATs and JWTs by kind', () => {
    expect(detectSecret('github_pat' + '_11ABCDEFG0abcdefghijklmnopqrstuvwxyZ_AbCdEf')).toEqual({ hit: true, kind: 'github-token' });
    expect(detectSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_AbCdEfGh')).toEqual({ hit: true, kind: 'jwt' });
  });

  it('labels OpenSSH private key blocks via the PEM pattern', () => {
    expect(detectSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC...')).toEqual({ hit: true, kind: 'pem-private-key' });
  });

  it('negative controls: secret-like prose fragments do not trip the new patterns', () => {
    expect(detectSecret('we discussed skating and sk-i trips').hit).toBe(false);
    expect(detectSecret('the eyJ prefix marks a base64url JSON header').hit).toBe(false);
    expect(detectSecret('npm_config_registry is an env var name').hit).toBe(false);
  });
  it('redactSecrets replaces only the secret span, preserving surrounding text', () => {
    const content = 'aws key AKIAIOSFODNN7EXAMPLE here';
    const r = redactSecrets(content, findSecrets(content));
    expect(r.content).toBe('aws key [redacted:aws-access-key] here');
    expect(r.classification).toBe('secret-redacted');
    expect(r.content).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(r.kinds).toContain('aws-access-key');
  });

  // EH-1 Task 1: confidence-tier split. The secret-assignment keyword heuristic is now its own
  // low-confidence 'heuristic' tier (still redacted on the write path); provider patterns stay
  // 'named'; the entropy catch-all stays 'entropy'. Rank-based precedence on overlap.
  it('tags secret-assignment as the heuristic tier (not named)', () => {
    const spans = findSecrets('db_password=Sup3rS3cretValue!');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.tier).toBe('heuristic');
    expect(spans[0]!.kind).toBe('secret-assignment');
  });
  it('tags provider patterns as the named tier', () => {
    expect(findSecrets('AKIAIOSFODNN7EXAMPLE')[0]!.tier).toBe('named');
  });
  it('tags the high-entropy catch-all as the entropy tier', () => {
    expect(findSecrets('token n2Xk9Lp4Qa7Zr3Vy8Wb1Mc6Td0Hs5Jf').some((s) => s.tier === 'entropy')).toBe(true);
  });
  it('mergeSpans precedence: an overlapping provider+heuristic span resolves to named', () => {
    const spans = findSecrets('api_key=AKIAIOSFODNN7EXAMPLE');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.tier).toBe('named');
  });
  it('redaction still covers a heuristic-tier span (recall parity)', () => {
    const r = redactSecrets('db_password=Sup3rS3cretValue!', findSecrets('db_password=Sup3rS3cretValue!'));
    expect(r.content).not.toContain('Sup3rS3cretValue');
  });
});

describe('EH-4: isHexCore (hex-literal shape for egress exemption)', () => {
  const SHA = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';                          // 40 hex
  const D256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // 64 hex

  it('is TRUE for clean and punctuation-wrapped pure-hex >= 24', () => {
    expect(isHexCore(SHA)).toBe(true);
    expect(isHexCore(SHA + '.')).toBe(true);
    expect(isHexCore('`' + SHA + '`')).toBe(true);
    expect(isHexCore('(' + SHA + '),')).toBe(true);
    expect(isHexCore('[' + SHA + ']')).toBe(true);
    expect(isHexCore('**' + SHA + '**')).toBe(true);
    expect(isHexCore(D256)).toBe(true);
  });

  it('is FALSE for letter-wrapped hex (closes the v1 false-exempt)', () => {
    expect(isHexCore('g' + SHA + 'z')).toBe(false);
    expect(isHexCore('Z3f8a1c9e7b2d4068f5a19c3e0d741b6eQ')).toBe(false);
  });

  it('is FALSE for label=/label: forms and the 0x prefix (interior non-hex)', () => {
    expect(isHexCore('secret=' + SHA)).toBe(false);
    expect(isHexCore('x=' + SHA)).toBe(false);
    expect(isHexCore('z:' + SHA)).toBe(false);
    expect(isHexCore('0x' + SHA)).toBe(false);
  });

  it('is FALSE for a rich-alphabet token and a sub-24 hex core', () => {
    expect(isHexCore('n2Xk9Lp4Qa7Zr3Vy8Wb1Mc6Td0Hs5Jf')).toBe(false);
    expect(isHexCore('`deadbeefdeadbeefdeadbe`')).toBe(false); // 22-hex core < 24
  });
});

describe('EH-4: findSecrets tags entropy spans with entropyHex', () => {
  it('sets entropyHex=true for a pure-hex entropy token', () => {
    const e = findSecrets('commit da39a3ee5e6b4b0d3255bfef95601890afd80709').find((s) => s.tier === 'entropy');
    expect(e).toBeDefined();
    expect(e!.entropyHex).toBe(true);
  });

  it('sets entropyHex=false for a rich-alphabet entropy token', () => {
    const e = findSecrets('token n2Xk9Lp4Qa7Zr3Vy8Wb1Mc6Td0Hs5Jf').find((s) => s.tier === 'entropy');
    expect(e).toBeDefined();
    expect(e!.entropyHex).toBe(false);
  });

  it('write-path: a pure-hex SHA still redacts to [redacted:high-entropy] (unchanged)', () => {
    const content = 'deployed commit da39a3ee5e6b4b0d3255bfef95601890afd80709 to prod';
    const r = redactSecrets(content, findSecrets(content));
    expect(r.content).toBe('deployed commit [redacted:high-entropy] to prod');
  });
});

describe('C2.2: findSecrets tags entropy spans with entropyWordChain', () => {
  const chainOf = (text: string) => findSecrets(text).find((s) => s.tier === 'entropy');

  it('true for the real observed FP: a dated governance filename path', () => {
    const e = chainOf('see docs/release/gate-decision-2026-07-22.md for the policy');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(true);
  });
  it('true for the real observed FP: a dated backup-archive filename', () => {
    const e = chainOf('archived to helix-docs-backup-2026-07-22-specs.tar.gz yesterday');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(true);
  });
  it('true when the token is backtick-wrapped (wrapper strip, EH-4 parallel)', () => {
    const e = chainOf('the file `helix-docs-backup-2026-07-22-specs.tar.gz` moved');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(true);
  });
  it('true for word+short-digit-suffix segments (specs2 / v2 style) and all-short-digit date chains', () => {
    const a = chainOf('kept helix-docs-backup-2026-07-22-specs2.tar.gz around');
    expect(a?.entropyWordChain).toBe(true);
    const b = chainOf('window 2026-07-22/2026-08-19-0102 spans the freeze');
    if (b !== undefined) expect(b.entropyWordChain).toBe(true); // may not even reach the entropy net
  });
  it('FALSE: a chain whose last segment is a long mixed-alnum secret chunk', () => {
    const e = chainOf('leaked prod-api-token-Zx9fQ2Lm8Kp3Vt5Rw7 today');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(false);
  });
  it('FALSE: interleaved mixed-alnum segments (a1b2 shapes)', () => {
    const e = chainOf('code a1b2-c3d4-e5f6-g7h8-i9j0-k1l2 given');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(false);
  });
  it('FALSE: a digit run longer than 4 in any segment', () => {
    const e = chainOf('ref build-1234567890123456-log-entry today');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(false);
  });
  it('FALSE: a single-segment mixed token is not a chain (classic secret shape stays in the net)', () => {
    const e = chainOf('token Zx9fQ2Lm8Kp3Vt5Rw7Aq1Bc2 here');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(false);
  });
  it('write-path: the exempt filename STILL redacts (exemption is egress-gate-only, EH-4 symmetry)', () => {
    const content = 'kept docs/release/gate-decision-2026-07-22.md tracked';
    const r = redactSecrets(content, findSecrets(content));
    expect(r.content).toBe('kept [redacted:high-entropy] tracked');
  });
});

// F6 — the write path scanned RAW bytes while the render path NFKC-folds, so a fullwidth-encoded
// credential was stored verbatim and came back out as a live key. The egress guard learned this
// exact lesson already (classifyEgress scans BOTH forms because "the raw form is blind to a
// confusable that normalization folds back into a live secret"); the write path never got the same
// treatment. Spans must still index the RAW string — redactSecrets splices the caller's bytes.
describe('F6: findSecrets sees confusables that NFKC folds back into a credential', () => {
  const FULLWIDTH_AWS = 'ＡＫＩＡＩＯＳＦＯＤＮＮ７ＥＸＡＭＰＬＥ';

  it('flags a fullwidth-encoded provider key that only matches after folding', () => {
    const raw = `deploy key ${FULLWIDTH_AWS} rotate quarterly`;
    const spans = findSecrets(raw);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.kind).toBe('aws-access-key');
    expect(spans[0]!.tiers).toContain('named');
  });

  it('the span indexes the RAW string, so redaction removes the confusable bytes themselves', () => {
    const raw = `deploy key ${FULLWIDTH_AWS} rotate quarterly`;
    const out = redactSecrets(raw, findSecrets(raw));
    expect(out.content).toBe('deploy key [redacted:aws-access-key] rotate quarterly');
    // The decisive assertion: what is persisted must not fold back into a working credential.
    expect(out.content.normalize('NFKC')).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('the same blind spot on the heuristic tier: a fullwidth assignment folds into one', () => {
    const raw = 'note ｐａｓｓｗｏｒｄ＝Ｓｕｐ３ｒＳ３ｃｒｅｔ here';
    const spans = findSecrets(raw);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.tiers).toContain('heuristic');
  });

  it('the same blind spot on the entropy tier: fullwidth digits/letters defeat the raw net', () => {
    // The raw token has length >= 24 but no [A-Za-z] and no [0-9] in ASCII terms, so the entropy
    // net never sees it; folded, it is the same token the ASCII test above already flags.
    const raw = 'token ｎ２Ｘｋ９Ｌｐ４Ｑａ７Ｚｒ３Ｖｙ８Ｗｂ１Ｍｃ６Ｔｄ０Ｈｓ５Ｊｆ end';
    const spans = findSecrets(raw);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.tiers).toContain('entropy');
  });

  it('leaves ordinary prose alone — folding must not manufacture hits', () => {
    expect(findSecrets('The migration script rewrites the users table.')).toEqual([]);
    expect(findSecrets('ﬁle uses a ligature but carries no credential')).toEqual([]);
  });
});

// F6 ROUND 2 — the fold above models NFKC ALONE, but the render path is
// `breakFenceRuns(stripControls(s.normalize('NFKC')))`: it also deletes every Cc/Cf code point.
// A zero-width or format character placed INSIDE a credential therefore survives the write scan
// (no PATTERN matches the interrupted token, and NFKC does not remove it), lands verbatim on disk,
// and is stripped back out at render — handing the model a working key. Same lesson as the
// fullwidth case above, one transform later: the write scan must model what the render path
// PRODUCES, not one chosen step of it. Exposure is on-disk and in-context; egress stays blocked
// because trifecta.ts scans both the raw and the outbound form.
describe('F6 round 2: findSecrets sees credentials broken by characters the render path strips', () => {
  const AWS = 'AKIAIOSFODNN7EXAMPLE';
  const INVISIBLES: Array<[string, string]> = [
    ['ZWSP U+200B', String.fromCharCode(0x200b)],
    ['ZWJ U+200D', String.fromCharCode(0x200d)],
    ['SOFT HYPHEN U+00AD', String.fromCharCode(0x00ad)],
    ['BOM U+FEFF', String.fromCharCode(0xfeff)],
  ];

  for (const [name, ch] of INVISIBLES) {
    it(`flags a provider key interrupted by ${name}`, () => {
      const raw = `deploy key AKIAIOSFODNN7${ch}EXAMPLE rotate quarterly`;
      const spans = findSecrets(raw);
      expect(spans).toHaveLength(1);
      expect(spans[0]!.kind).toBe('aws-access-key');
    });
  }

  // The decisive assertion, and the reason this suite imports the real renderer: what survives
  // redaction is fed through the ACTUAL render transform. Binding to normalizeUntrusted rather
  // than to a hand-copied fold is what keeps the two paths from drifting apart again.
  it('what is persisted cannot be rendered back into a working credential', () => {
    for (const [, ch] of INVISIBLES) {
      const raw = `deploy key AKIAIOSFODNN7${ch}EXAMPLE rotate quarterly`;
      const out = redactSecrets(raw, findSecrets(raw));
      expect(normalizeUntrusted(out.content)).not.toContain(AWS);
    }
  });

  it('leaves ordinary prose alone — stripping must not manufacture hits', () => {
    const zwsp = String.fromCharCode(0x200b);
    expect(findSecrets(`The migration${zwsp} script rewrites the users table.`)).toEqual([]);
  });
});

// E-CITE — the guard blocked the workflow the project mandates. CLAUDE.md requires Codex questions
// to carry "file:line pointers rather than inlining whole files", but a path with a `:NN` suffix has
// no `:` in the C2.2 separator class, so its final segment (`ts:112`) disqualifies the whole chain
// and the citation lands in the entropy net. The give-away that this is arbitrary rather than
// protective: `src/memory/store.ts:628` passes only because it is 23 chars, one short of the length
// threshold — the same citation shape blocks or passes on path length alone.
//
// The fix strips a trailing line reference and then runs the UNCHANGED chain test on what is left,
// so the exemption inherits every existing anti-greedy rule instead of adding new trust. The strip
// must be EARNED by the prefix's grammar — file-shaped, with each number at most 5 digits. A bare
// bounded-digit strip is not enough: it launders past the sibling "no digit run over 4" rule the
// moment a separator becomes a colon, which is what the control pair below locks.
describe('E-CITE: a source citation with a line reference is a benign word chain', () => {
  const chainOf = (text: string) => findSecrets(text).find((s) => s.tier === 'entropy');

  it('true for the real blocked FP: a path with a line number', () => {
    const e = chainOf('the clamp lives at src/memory/verified-projection.ts:112 today');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(true);
  });
  it('true for a line RANGE and for a line:column pair', () => {
    expect(chainOf('see src/server/helix-server.ts:44-45 for the schema')!.entropyWordChain).toBe(true);
    expect(chainOf('see test/memory/firewall.test.ts:45:7 for the lock')!.entropyWordChain).toBe(true);
  });
  it('true when the citation is backtick-wrapped (wrapper strip composes with the line strip)', () => {
    expect(chainOf('the guard `src/memory/verified-projection.ts:112` moved')!.entropyWordChain).toBe(true);
  });

  it('FALSE: the path part is still judged — a secret-shaped segment is not laundered by a :NN suffix', () => {
    const e = chainOf('ref prod-api-token-Zx9fQ2Lm8Kp3Vt5Rw7.ts:112 here');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(false);
  });
  it('FALSE: a colon-separated credential pair is not a line reference', () => {
    const e = chainOf('creds deploybot:Zx9fQ2Lm8Kp3Vt5Rw7Aq1Bc2 rotated');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(false);
  });
  it('FALSE: a long digit run after the colon is not a plausible line number', () => {
    const e = chainOf('ref path/to/file.ts:1234567890123456 today');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(false);
  });
  it('FALSE: only a TRAILING line reference is stripped, never an interior colon', () => {
    const e = chainOf('ref path/to/file.ts:112/Zx9fQ2Lm8Kp3Vt5Rw7Aq1 here');
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(false);
  });

  // The Codex compare review refuted the first version of this fix, which stripped any bounded digit
  // tail. Whatever is stripped is thereafter judged by nothing, so the strip must be earned by the
  // GRAMMAR of what precedes it — otherwise a colon is all it takes to launder digits past the
  // sibling "no digit run over 4" rule. The control pair below is the whole argument: same digits,
  // same prefix, only the separator differs, and both must reach the same verdict.
  it('FALSE: a numeric value behind a word label is NOT a citation — the colon form must match the dot form', () => {
    const withDot = chainOf('code backup.recovery.identifier.593821 issued');
    const withColon = chainOf('code backup.recovery.identifier:593821 issued');
    expect(withDot!.entropyWordChain).toBe(false);
    expect(withColon!.entropyWordChain).toBe(false); // the regression the first fix introduced
  });
  it('FALSE: a word-labelled pair of numeric groups (passphrase + recovery shape)', () => {
    expect(chainOf('note winter.garden.lantern:593821-047216 kept')!.entropyWordChain).toBe(false);
  });
  it('FALSE: a position wider than five digits is not a line number', () => {
    expect(chainOf('ref alpha.beta.gamma.delta:1234567 here')!.entropyWordChain).toBe(false);
    expect(chainOf('ref alpha.beta.gamma.delta:123456-654321 here')!.entropyWordChain).toBe(false);
  });
  it('FALSE: a repeated suffix chain is not a line:column pair (one optional group, anchored)', () => {
    expect(chainOf('ref path/to/file.ts:12:34:56789 here')!.entropyWordChain).toBe(false);
  });
  it('a five-digit line number still works (a real bundle line is that long)', () => {
    expect(chainOf('the disjunct sits at src/memory/verified-projection.ts:13040 today')!.entropyWordChain).toBe(true);
    // The bundle's own citation never even reaches the entropy net — 23 chars, one under the
    // threshold. Recorded because it is the same length accident that made this defect look benign.
    expect(chainOf('the disjunct sits at bin/helix-mcp.mjs:13040 today')).toBeUndefined();
  });
  it('write-path: an exempt citation STILL redacts (egress-gate-only, EH-4 symmetry)', () => {
    const content = 'the clamp lives at src/memory/verified-projection.ts:112 today';
    const r = redactSecrets(content, findSecrets(content));
    expect(r.content).toBe('the clamp lives at [redacted:high-entropy] today');
  });
});

// Issues #5 and #12: the chain test (isBenignWordChain, read through entropyWordChain by the write path
// and by the egress exemption alike, owner ruling 2026-10-18) also accepts the spellings a Windows
// path, an environment-variable reference and a NAME=value setting take.
describe('issues #5 and #12: the chain test accepts Windows paths, environment-variable references and settings', () => {
  const span = (text: string) => findSecrets(text).find((s) => s.tier === 'entropy');
  const KEPT: Array<[string, string]> = [
    ['a drive path with backslashes', 'the config is C:\\Users\\dev\\projects\\app2\\src\\main.ts here'],
    ['a drive path with forward slashes', 'the config is C:/Users/dev/projects/app2/src/main.ts here'],
    ['a relative backslash path', 'the config is projects\\app2\\src\\main.ts here'],
    ['the hosts file', 'the hosts file is C:\\Windows\\System32\\drivers\\etc\\hosts here'],
    ['a UNC path', 'the share is \\\\fileserver\\builds\\app2\\release\\notes.txt here'],
    ['a cmd environment variable', 'the settings are in %USERPROFILE%\\.m2\\settings.xml here'],
    ['a PowerShell environment variable', 'the modules are in $env:APPDATA\\npm\\node_modules\\pkg2 here'],
    ['a POSIX environment variable', 'the config is $HOME/.config/app2/settings.json here'],
    ['a braced POSIX environment variable', 'the config is ${XDG_CONFIG_HOME}/app2/settings.json here'],
    ['a setting in a code span', 'set `PYTHONIOENCODING=utf-8` before printing'],
    ['a setting in double quotes', 'set "PYTHONIOENCODING=utf-8" before printing'],
    ['a --flag=value option', 'run node with --max-old-space-size=4096 for big builds'],
    ['a setting whose value is another setting', 'set JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 for the JVM'],
    ['a backslash path with a line reference', 'the clamp is at src\\memory\\verified-projection.ts:112 today'],
    ['a PowerShell reference written $Env:', 'the modules are in $Env:APPDATA\\npm\\node_modules\\pkg2 here'],
    ['a short credential word inside a longer name part', 'the value SPINNER_MODE=blue-sky-2024-mango-kiwi was set'],
    ['a camelCase Java system property', 'run with -Dhttp.proxyHost=proxy2.example.org now'],
  ];
  for (const [name, text] of KEPT) {
    it(`true for ${name}`, () => {
      const e = span(text);
      expect(e).toBeDefined();
      expect(e!.entropyWordChain).toBe(true);
    });
  }

  const REDACTED: Array<[string, string]> = [
    ['a random token', 'the synthetic token Zx9Qv4Lm2Rt7Kp1Wc8Ny5Hb3 is not a real secret'],
    ['a setting whose name carries a credential word', 'the value AUTH_TOKEN=blue-sky-2024-mango-kiwi was set'],
    ['a key-named setting', 'the value MASTER_KEY=zebra-mango-2024-kiwi-lemon was set'],
    ['a credential word in a later name of the chain', 'run with NODE_OPTIONS=--auth-token=blue-sky-2024-mango-kiwi now'],
    ['an option named after a token', 'run with --deploy-token=blue-sky-2024-mango-kiwi now'],
    ['a setting with a random value', 'set BUILD_ID=Zx9fQ2Lm8Kp3Vt5Rw7Aq1Bc2 here'],
    ['a drive path with one random segment', 'the config is C:\\Users\\dev\\Zx9fQ2Lm8Kp3Vt5Rw7\\main.ts here'],
    ['a backslash path with a long digit run', 'the log is C:\\builds\\1234567\\app2\\out.log here'],
    ['a drive prefix with a single segment', 'the blob is C:\\Zx9fQ2Lm8Kp3Vt5Rw7Aq1Bc2 here'],
    ['a drive-shaped colon inside the token', 'the pair is app2\\cfg\\D:\\data\\notes.txt here'],
    ['an environment reference whose name is random', 'the blob is %Zx9fQ2Lm8Kp3Vt5Rw7Aq1Bc2%\\app2\\notes.txt here'],
    ['a colon-separated credential pair', 'creds deploybot:Zx9fQ2Lm8Kp3Vt5Rw7Aq1Bc2 rotated'],
    ['padded base64 whose pieces look like words', 'the blob is Sb6/TpCTGo/OhIheobTuig== here'],
    ['a drive letter with no separator after the colon', 'the value k:blue-sky-2024-mango-kiwi-lemon was set'],
    ['a credential word the sigils split', 'set %SEC%RET=correct-horse-battery-2024 now'],
    ['names the sigils join into one segment', 'ref (${A}%B%$env:C${D}%E%$F1 here'],
    ['base64 padding followed by a separator', 'the blob is Sb6/TpCTGo/OhIheobTuig==/ here'],
    ['a padding run after word-like urlsafe pieces, then a suffix', 'the blob is Abcdef-Ghijkl_Mnopqr-Stuvw2==/old here'],
    ['a single trailing = after word-like urlsafe pieces (a 32-byte key)', 'the key is Abcdef-Ghijkl_Mnopqr-Stuvwx_Yzabcd-Efgh12= here'],
    ['an = after text that is not a setting name', 'the pair is app2/cfg=blue-sky-2024-mango-kiwi here'],
    ['a single pad after a mixed-case base64 body, then a path', 'the blob AbCdEfGhIjKlMnOpQrStUvW=/cfg2 here'],
    ['a single trailing = after a lower-case chain (an = before no value)', 'the key is abcdef-ghijkl-mnopqr-stuvwx-2024= here'],
    ['a mixed-case name is not taken for a setting name', 'set ProgramFiles=Tools-2024-release-x64 here'],
    ['a credential part inside a camelCase Java property name', 'the value -Dapp.adminCode=correct-horse-battery-2024 was set'],
  ];
  for (const [name, text] of REDACTED) {
    it(`false for ${name}`, () => {
      const e = span(text);
      expect(e).toBeDefined();
      expect(e!.entropyWordChain).toBe(false);
    });
  }
  // Every credential word is pinned: a word dropped from the list would persist a secret value
  // written as a word chain behind that name. Long words count anywhere in the name, short ones
  // only as a whole part of it.
  for (const w of ['key', 'token', 'secret', 'pass', 'pwd', 'auth', 'cred', 'cookie', 'sess', 'private', 'sign', 'salt', 'pepper', 'bearer', 'hmac', 'nonce', 'mnemonic', 'seed', 'recovery', 'license', 'serial', 'cipher', 'kennwort', 'contrasen', 'senha', 'parola', 'wachtwoord', 'haslo', 'heslo', 'salasana', 'jelszo', 'losenord', 'adgangskode', 'geheim', 'clave', 'chave', 'schluessel']) {
    it(`false for a setting whose name holds "${w}"`, () => {
      const e = span(`the value MY${w.toUpperCase()}X=correct-horse-battery-2024 was set`);
      expect(e).toBeDefined();
      expect(e!.entropyWordChain).toBe(false);
    });
  }
  // Short words that rarely end an English word are also caught at the end of a name part, where
  // a real key often glues them on (`rootpw` is an OpenLDAP and kickstart key).
  for (const name of ['ROOTPW', 'rootpw', 'ADMINPW2', 'DBPW', 'USERPIN', 'ADMINPin', 'WIFIPSK', 'MYOTP', 'APPTOTP', 'APPJWT', 'USERSID', 'ADMINMFA', 'USER2FA', 'ROOT2FA', 'ADMINMDP', 'ADMIN_PW12', 'PINCODE', 'OTPCODES', 'MFACODE']) {
    it(`false for a setting whose name ends in a short credential word: ${name}`, () => {
      const e = span(`the value ${name}=correct-horse-battery-2024 was set`);
      expect(e).toBeDefined();
      expect(e!.entropyWordChain).toBe(false);
    });
  }
  for (const w of ['p', 'pw', 'pin', 'otp', 'totp', 'hotp', 'mfa', '2fa', 'psk', 'jwt', 'sig', 'sid', 'sk', 'pk', 'mdp', 'code', 'codes', 'phrase', 'answer']) {
    it(`false for a setting with "${w}" as a part of its name`, () => {
      for (const name of [`ADMIN_${w.toUpperCase()}`, `admin${w[0]!.toUpperCase()}${w.slice(1)}`, `--${w}`, `ADMIN_${w.toUpperCase()}2`]) {
        const e = span(`the value ${name}=correct-horse-battery-2024 was set`);
        expect(e, name).toBeDefined();
        expect(e!.entropyWordChain, name).toBe(false);
      }
    });
  }
  it('a code span still counts toward the 24-character floor (the length is judged on the token as written)', () => {
    const e = span('the code is `Zx9fQ2Lm8Kp3Vt5Rw7Aq1B` here');   // 22 characters inside the span
    expect(e).toBeDefined();
    expect(e!.entropyWordChain).toBe(false);
  });
});

// Issue #12: the chain test also splits on code punctuation (brackets, quotes, the backtick, `,` and
// `;`, the pairs `${`, `?.` and `!.`, `#` inside a URL) and judges a URL with its scheme as a segment and
// without the port after its host, so ordinary source code is judged by its words. A lone password
// symbol, `+`, `:` and an `=` outside a setting are not separators (random passwords, base64 padding,
// `label:secret`). A widened token (code punctuation or a URL) that names a credential keyword, or
// whose mixed case does not read as words, stays in the net, and so does a URL with a segment in
// mixed case; the segment rules are unchanged. All of it applies on the write path and at egress alike.
describe('issue #12: the chain test judges code by its words', () => {
  const span = (text: string) => findSecrets(text).find((s) => s.tier === 'entropy');
  for (const tok of [
    'items.get(0).equals(order.getCustomerId()))',
    'response.setStatusCode(200);',
    'result.setRetryCount(0);',
    'list.subList(1,list.size());',
    '"2".equals(status.trim());',
    'Pattern.compile("[A-Za-z][A-Za-z0-9_]*");',
    '"http://mybatis.org/dtd/mybatis-3-mapper.dtd">',
    'fetch("http://localhost:3000/api/v2/items");',
    'members[0]!.targetDigest.slice(0,8)',
    'cfg.get("node.retry_limit")?.value2',
    '`${lockPath}.lk-${randomBytes(16).toString("hex")}.tmp`;',
    'out.indexOf(openMatch![0]);',
    'https://github.com/org/repo/blob/main/src/x.ts#L42',
    'svn+ssh://repo.example.org/trunk/app2/src',
    'fetch("http://localhost:12345/v1/items");',
    'expect(t1.supersedes).toBeNull();',
    'https://github.com/org/repo/issues/12',
    'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404',
    'expect(t1.kind).toBe("a2");',
    'response.getHTTPStatusCode(404);',
    'client2.connect("aBcDe12");',
  ]) {
    it(`true for the code token ${tok}`, () => {
      const e = span(`code ${tok} here`);
      expect(e, tok).toBeDefined();
      expect(e!.entropyWordChain, tok).toBe(true);
    });
  }
  for (const [name, tok] of [
    ['a random value in a call', 'client.connect("Zx9Qv4Lm2Rt7Kp1Wc8Ny5");'],
    ['a random value among arguments', 'fn(a,"Ab3dEf9hIj2kLm4nOp6q")'],
    ['base64 with a + inside a call', 'atob("U2VjcmV0K2tleQ+Zm9vYmFy2a==")'],
    ['a value whose pieces between + look like words (+ never splits)', 'fn("Abcdefgh+Ijklmnop+Qrst12")'],
    ['a random path segment in a URL', 'fetch("https://api.example.com/v1/files/Zx9Qv4Lm2Rt7Kp1Wc8");'],
    ['credentials in a URL', 'https://admin:hunter2@db.example.com/app2'],
    ['a port with no scheme before it', 'see deploy.bot:12345/x2/release-notes'],
    ['five digits behind a label', 'code backup.recovery.identifier:59382 issued'],
    ['an internal-digit identifier (not widened)', 'import org.slf4j.LoggerFactory;'],
    ['an = comparison inside a token', "process.platform2==='win32';"],
    ['a random value over letters, digits and !@#$%^&* (a lone symbol never separates)', 'Gq&Lw*Tz!Rb^Mx@Nc#Pv$Kd9'],
    ['the same value after -p on a command line', '-pGq&Lw*Tz!Rb^Mx@Nc#Pv$Kd9'],
    ['a # outside a URL', 'Gq#Lw#Tz#Rb#Mx#Nc#Pv#Kd9'],
    ['a random scheme (the scheme is a segment)', 'Xk9Qm2Lp7Rt4Vz8Nw3Bc6Hy1Jd5://localhost/x'],
    ['a numeric password in URL userinfo', 'https://admin:84213@db.example.com/app2'],
    ['a port of six digits (no URL is read)', 'fetch("http://localhost:123456/v1/items");'],
    ['a setter that names a password', 'db.setPassword("tiger-lily-2024");'],
    ['a builder that names a client secret', 'withClientSecret(`maple-otter-77`)'],
    ['a camelCase pw in a setter', 'db.setPw("tiger-lily-2024-otter");'],
    ['a URL that names a password', 'https://vault.example.org/password/tiger-lily-2024'],
    ['an optional chain that names a password', 'user?.password.reset.v2.token'],
    ['a non-null chain that names a password', 'opts!.password.reset2.flowName'],
    ['a $ inside an identifier (a bundler rename)', 'exports$1.push(...fileExports);'],
    // review round 2
    ['a random mixed-case id in a share link (every URL segment in one case)', 'http://localhost:8080/s/nZTDAGXu'],
    ['a camelCase segment in a URL', 'https://github.com/Microsoft/TypeScript/pull/9163'],
    ['a random mixed-case value in code (it does not read as camelCase words)', 'client2.connect("hQrYTofCgUEf");'],
    ['a mixed-case value whose words average two letters', 'client2.connect("qRtyUiOpAsDf");'],
    ['six mixed-case letters that do not read as words (the floor is six)', 'client2.connect("aBcDeF");'],
    ['seven of them', 'client2.connect("aBcDeFg");'],
    ['digits after a port of five', 'http://h:12345678/files/report'],
    ['a scheme that does not start its run', '9.https://files.example.org/v2/docs'],
    ['a tag that names a password', '<password>tiger-lily-dawn-2024</password>'],
    ['quotes that name a secret', '"secret"."tiger-lily-dawn-2024"'],
    ['an index that names a secret', 'secrets[tiger-lily-dawn-2024]'],
  ] as const) {
    it(`false for ${name}`, () => {
      const e = span(`code ${tok} here`);
      expect(e, tok).toBeDefined();
      expect(e!.entropyWordChain, tok).toBe(false);
    });
  }
  // Review round 1: each separator splits on its own, a symbol of a password alphabet does not, and
  // `!` separates only before `.`, a bracket, `,` or `;`, `?` only before `.`.
  for (const sep of ['-', '.', '_', '/', '\\', '(', ')', '[', ']', '{', '}', '<', '>', '"', "'", '`', ',', ';', '?.', '!.', '![', '!)', '!]', '!,', '!;']) {
    it(`${JSON.stringify(sep)} separates`, () => {
      expect(span(`code Alpha${sep}Bravo${sep}Charlie${sep}Delta2${sep}Echo here`)!.entropyWordChain).toBe(true);
    });
  }
  for (const sym of ['?', '&', '#', '$', '%', '|', '^', '*', '!', '@', '~', '+', '=', ':']) {
    it(`${JSON.stringify(sym)} alone does not separate`, () => {
      expect(span(`code Alpha${sym}Bravo${sym}Charlie${sym}Delta2${sym}Echo here`)!.entropyWordChain).toBe(false);
    });
  }
  // Review round 3 and the check after it: two parts of the residual SECURITY.md states, pinned so that
  // a change to either shows. A share link whose random id is in one case passes, as 10035b8 passed the
  // same link written without its scheme, and letters alone in mixed case can average 2.5 letters a
  // word (`nZTDAGXu`: 2.67), so in code they pass.
  it('the documented residual: a one-case id in a share link and mixed-case letters that read as words', () => {
    for (const tok of ['http://localhost:8080/s/ombqfxiv', 'client2.connect("nZTDAGXu");']) {
      expect(span(`code ${tok} here`)!.entropyWordChain, tok).toBe(true);
    }
  });
  // A path or a quoted path is not a widened token, so neither the credential check nor the camelCase
  // test applies to it.
  it('a path that names a credential keyword, or carries a bundler hash, is judged as before issue #12', () => {
    for (const tok of ['docs/secret-rotation/2024-plan.md', '"docs/secret-rotation/2024-plan.md"', "'./chunks/environment.d.CrsxCzP1.js';"]) {
      expect(span(`code ${tok} here`)!.entropyWordChain, tok).toBe(true);
    }
  });
});
