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
