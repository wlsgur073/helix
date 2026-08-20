export interface AgreementMap {
  verdict: 'agree' | 'diverge' | 'indeterminate';
  agreements: string[];
  divergences: string[];
  /** How many assigned pairs the figure clamp declined to rule on (H1, see PASS 3). Zero on every
   *  pre-H1 shape. It exists because 'indeterminate' now has two routes that a caller CANNOT tell
   *  apart from the other three fields — with a single withheld pair, `agreements` is empty and
   *  `divergences` holds one entry, exactly like a one-sentence zero-pair comparison — and a caller
   *  that explains the verdict has to say something different in each case or state a falsehood.
   *  A count, not a flag re-derived from the note text: `divergences` carries untrusted answer bytes,
   *  so any string test over it is a rule an adversary can aim at. */
  withheldPairs: number;
}

/** Split an answer into trimmed claim-sentences, preserving original casing for display.
 *  A period terminates a sentence only before whitespace/end-of-input, so file paths
 *  (src/verify/codex.ts:12), version numbers (0.144.1) and markdown link targets stay
 *  single claims instead of being shredded into non-claims (H3, dogfood 07-26..07-30). */
function sentences(answer: string): string[] {
  return answer
    .split(/\n+|;+\s*|(?<=\S)\.(?=\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Content tokens of a sentence: lowercased runs of letters/digits (punctuation/spacing dropped). */
function tokenSet(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : inter / union;
}

/** A claim "matches" one on the other side when their content-token overlap clears this bar.
 *  This makes reordering and paraphrase count as agreement; the prior verbatim-sentence heuristic
 *  treated any rewording as divergence, so the verdict read 'diverge' for almost every real pair. */
const SENTENCE_SIM = 0.5;

/** Bare (non-hyphenated) un-prefixed negated adjectives worth matching as whole words. A blanket
 *  \bun[a-z]+\b scan was considered and rejected: "under", "until", "union", "unique", "united"
 *  are far more common in ordinary prose than genuine un-negated adjectives are, and each one that
 *  appears on only one side of a pair would flip that pair's parity for free, trading a closed
 *  false-'agree' hole for an open false-'diverge' one on ordinary vocabulary. A bounded list is
 *  deliberately narrower — it will miss an un-negated word not on the list (e.g. "unnecessary",
 *  "uncertain") rather than risk that blast radius. Extend this list, don't switch to a blanket
 *  scan, when a new miss is found. */
const UNPREFIXED_NEGATIONS = ['unsafe', 'unavailable', 'unreachable'] as const;

/** NEGATOR half of the marker set, scanned on the RAW sentence — never on tokenSet. tokenSet's
 *  /[\p{L}\p{N}]+/gu splits "doesn't" into "doesn" + "t", so a token-based scan would silently
 *  lose the single most common negation form in prose. Covers: bare "not"; the "n't" contraction
 *  suffix (isn't/doesn't/won't/...); "no"; "never"; "cannot" (its own alternative because "not"
 *  isn't a separately-\b-bounded token inside "cannot" — the two letters "n" before it block the
 *  boundary). The un- forms are deliberately NOT here: they are the OTHER bit (see UN_FORM_RE and
 *  negationPolarity), because in this repo they are topic vocabulary as often as they are negation
 *  morphology, and one shared bit conflated the two roles (C1, final review 2026-08-12).
 *  The contraction's apostrophe is a CLASS, not U+0027 alone: U+2019 (RIGHT SINGLE QUOTATION MARK)
 *  is what editors and most model output actually emit, and U+02BC (MODIFIER LETTER APOSTROPHE)
 *  turns up in pasted text. Before the class, "doesn’t" carried no negator at all and a direct
 *  contradiction so phrased rendered 'agree' (I2, measured 2026-08-12) — the negators were listed,
 *  they failed on the codepoint. Kept as ONE literal interpolated into both regexes below because
 *  that duplication WAS the I2 defect: the same widening has to reach the cancellation regex, and a
 *  shared literal makes that structural instead of something to remember.
 *  Known false-positive source, by design left unguarded rather than chasing an ever-growing
 *  exclusion list: "no" is a genuine negator in "no race" but an intensifier, not a negator, in
 *  idioms like "no doubt" or "no wonder" — those count a marker that isn't semantically negating
 *  anything. The verdict direction this corrupts is NOT fixed to false-'diverge' — an earlier
 *  version of this comment claimed exactly that, and it was never actually true (measured
 *  2026-08-12, review round 1): the direction depends on the PAIRED sentence's own polarity, not on
 *  this sentence alone. Against a genuinely unnegated partner the spurious marker produces
 *  false-'diverge' ("No doubt the migration is safe." vs "The migration is safe." — both really
 *  agree, the scan says diverge). Against a genuinely negated partner it produces false-'agree'
 *  instead ("No doubt the migration is safe." vs "The migration is not safe." — a real
 *  contradiction, both sides scan to polarity 1, the scan says agree). Neither direction is safer
 *  than the other; both stay open. */
const NEGATOR_ALTERNATIVES = String.raw`\bnot\b|n['’ʼ]t\b|\bno\b|\bnever\b|\bcannot\b`;

/** UN-FORM half: the hyphenated "un-" prefix (e.g. "un-safe", not a bare "un" scan — see
 *  UNPREFIXED_NEGATIONS for why) plus that bounded whole-word list.
 *  The two families get SEPARATE non-global regexes — non-global on purpose: `.test()` on a /g/
 *  regex advances lastIndex between calls, so a shared global regex would make one sentence's
 *  polarity depend on how many sentences were scanned before it. */
const NEGATOR_RE = new RegExp(NEGATOR_ALTERNATIVES, 'i');
const UN_FORM_RE = new RegExp(String.raw`\bun-|\b(?:${UNPREFIXED_NEGATIONS.join('|')})\b`, 'i');

/** Characters allowed to sit between the negator and the un- form and still count as adjacent:
 *  whitespace plus inline markdown emphasis (`*`, `_`), strikethrough (`~`) and the code backtick.
 *  NOTHING ELSE — in particular no quote marks, parentheses or brackets. Two rounds shaped this:
 *   1. A literal \s+ was the original rule, so "not **unsafe**" never collapsed. Re-measured under the
 *      two-bit rule (M12, 2026-08-12) that leaves a REAL false-'agree': a markup-wrapped cancellation
 *      scores negator+un-form (3) and so does a reinforcing partner ("is unsafe and cannot be
 *      applied"), so opposites agree while the markup-free control correctly diverges. Hence a class.
 *   2. That class first included quotes/parens/brackets, and THAT WAS A CRITICAL DEFECT (round 2,
 *      2026-08-12): those characters OPEN A CLAUSE, so a negator could reach an un- word that is not
 *      its complement at all and delete itself against it. Measured, all four reading 'agree' before
 *      the narrowing and 'diverge' after:
 *        'Compaction drops rows ... on a crash.' vs 'Compaction does not ("unreachable" rows aside)
 *        drop rows ... on a crash.'   (and the same shape with never/[..]/'..')
 *      A direct contradiction rendering 'agree' with an empty divergence list — the most dangerous
 *      direction. Closed by dropping the clause-delimiting characters, per the owner precedent: close
 *      the false-'agree', accept a false-'diverge'. The accepted cost is that quote-wrapped un- words
 *      no longer cancel ('The lock is not "unsafe".' vs 'The lock is safe.' now reads 'diverge');
 *      pinned as a documented limit, not as a cancellation.
 *      `_` is KEPT among the emphasis characters. It is markdown emphasis like `*`, it cannot open or
 *      close a clause, and measured against all four Critical rows it changes none of them (their gaps
 *      carry parens/quotes, not underscores). Dropping it would additionally have flipped the pinned
 *      hyphenated-underscore cancellation "not _un-safe_" from 'agree' to 'diverge' for no gain.
 *  WHAT THIS GUARD DOES PREVENT, measured over every ASCII letter and digit and over
 *  " ' “ ” ‘ ’ ( ) [ ] , : — – : none of them collapses when placed in the gap. So an intervening
 *  WORD ("Do not use unsafe mode." — the gap " use " has letters) and an intervening CLAUSE OPENER are
 *  both excluded, which is what keeps a real warning from folding down to permission.
 *  WHAT IT DOES NOT PREVENT, equally measured: the collapse still assumes the FIRST un- word after the
 *  negator is that negator's complement. An aside wrapped in the allowed markup defeats that —
 *  'The sweep does not *unsafe mode aside* mark the scope broken.' still collapses. That weakness is
 *  NOT introduced by this class and is not closable by narrowing it: with a whitespace-only gap the
 *  markup-free spelling ('does not unreachable rows aside drop rows') collapses too, i.e. it predates
 *  the M12 widening. What the allowed markup adds is one more spelling of a pre-existing hole, and
 *  what round 2 removed was the punctuation route that made ordinary prose hit it. Recorded as such
 *  rather than claimed closed.
 *  Measured residue: `_` is in the class but is ALSO a regex word character, so the
 *  `\b(?:unsafe|...)\b` alternative fails against it in BOTH regexes that carry it — the pair does
 *  not collapse (CANCELLING_PAIR_RE) AND the un-bit does not set (UN_FORM_RE). "not _unsafe_"
 *  therefore scores polarity 1, indistinguishable from a plain negation rather than the 3 a set
 *  un-bit would give, so the residue has NO fixed direction: false-'diverge' against an affirmative
 *  partner, false-'agree' against a negated one — the same partner-dependence NEGATOR_ALTERNATIVES
 *  records for idiomatic "no doubt". "not _un-safe_" still collapses, since the `un-` alternative
 *  carries no leading `\b`, so `_` earns its place for the hyphenated spelling only. Closing the
 *  bare-word half means changing that boundary (the twin-regex asymmetry left alone on 2026-08-12)
 *  and needs its own measurement. Both directions and both spellings pinned.
 *  The trailing `+` cannot be tightened to `*` observably, and a sweep reporting that as a survivor is
 *  reporting an EQUIVALENT mutant (proved 2026-08-12): every negator alternative ends in `\b` and every
 *  un- form starts with a word character, so a ZERO-length gap would need a word boundary between two
 *  word characters, which never holds. `+` is kept because it says what is meant. */
const COLLAPSE_GAP = String.raw`[\s*_~\u0060]+`;

/** FIGURE TOKENS of a sentence, scanned on the RAW text (H1, 2026-08-20). Two reasons it cannot run
 *  on tokenSet: tokenSet has by then shredded "codex.ts:12" and "0.144.1" into separate tokens, and
 *  it is a SET, so "3" appearing twice on one side and once on the other would compare equal.
 *  Shape: digits, then further digit runs joined by the separators that hold a figure together
 *  (`,` `.` `:` — thousands, decimals, times and file:line cites), then an optional single space and
 *  up to 8 letters or a `%` so the UNIT travels with the number ("25 minutes" vs "25 seconds" is a
 *  substitution this must see). The bound is 8 because it is a unit-catcher, not a phrase-catcher —
 *  it deliberately grabs the following word whether or not that word is a unit ("12 next" out of
 *  "codex.ts:12 next to"), which costs nothing because both sides are normalized the same way and
 *  only compared with each other.
 *  A separator counts ONLY between digits. The looser `[\d,.:]*` this started as swallowed ordinary
 *  sentence punctuation and the word after it, so "the retry limit is 3, always" yielded "3, always"
 *  and did not match a plain "3" — the clamp fired on a pair that quotes the SAME figure, which is
 *  exactly the false-'diverge' cost the limits header warned this rule could carry. Found by the
 *  boundary test below, not reasoned about; that test is the guard on this bound.
 *  Normalization is then only case plus whitespace shape ("30 Minutes" / "30\tminutes"): with the
 *  separator tightened, a match can no longer END in punctuation, so nothing needs stripping. */
const FIGURE_RE = /\d+(?:[.,:]\d+)*\s?[\p{L}%]{0,8}/gu;

function figuresOf(s: string): string[] {
  return (s.match(FIGURE_RE) ?? []).map((f) => f.toLowerCase().replace(/\s/g, ' '));
}

/** Render a figure list for the divergence note; an empty list is stated, never left blank. */
function cites(figures: string[]): string {
  return figures.length === 0 ? 'no figure' : figures.join(', ');
}

/** MULTISET equality, not set equality: an answer that says "3" twice does not agree with one that
 *  says it once, and sorting is what makes order irrelevant without making count irrelevant too. */
function sameFigures(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, k) => v === y[k]);
}

/** Genuinely-cancelling ADJACENT pair: a negator followed by an un- form with nothing but
 *  whitespace/inline markup between them ("not un-safe", "not unsafe", "not **unsafe**", "never
 *  un-X"). Only this shape reads as a cancelled double negation; markers that are merely CO-PRESENT
 *  in a sentence ("No, ... not ...", "cannot ... never") reinforce the negation rather than cancel
 *  it. A separated genuine cancellation ("cannot be unsafe") is still NOT collapsed and scores 3
 *  (negator bit + un-form bit). Under the old single presence bit that made it indistinguishable
 *  from a plain negation ("cannot be safe", also 1) and the two silently agreed; the two-bit rule
 *  separates THAT pair (3 vs 1) without widening the collapse — see the closed-limit test. What
 *  survives is narrower: two sentences that BOTH score 3, one cancelling and one reinforcing, still
 *  agree, because the un-bit records presence and not attachment. Pinned as the un-bit residue. */
const CANCELLING_PAIR_RE = new RegExp(
  String.raw`(?:${NEGATOR_ALTERNATIVES})${COLLAPSE_GAP}(?:un-|\b(?:${UNPREFIXED_NEGATIONS.join('|')})\b)`,
  'gi',
);

/** Polarity of a sentence's raw text as TWO INDEPENDENT BITS: collapse cancelling adjacent pairs
 *  first, then report bit 0 = a negator is present, bit 1 = an un- form is present. Four values,
 *  compared for equality by the caller: 0 affirmative, 1 negator only, 2 un- form only, 3 both.
 *  Two rules preceded this and each failed in its own direction:
 *    - count%2 parity read every even marker count as affirmative, so a contradiction carrying two
 *      markers ("No, X is not Y") silently AGREED with "X is Y" (N-VERDICT even-parity class,
 *      refuter-measured 2026-08-12).
 *    - a single PRESENCE bit closed that, but conflated the un- forms' two roles. In this repo
 *      "unsafe"/"unavailable"/"unreachable" are topic vocabulary as often as negation morphology, so
 *      a sentence using one as plain vocabulary saturated the bit to 1 and so did its explicit
 *      negation (negator + un-word, non-adjacent, so the collapse never fires) — equal, hence
 *      'agree' on a flat "X does Y" vs "X does not do Y" contradiction, and a REGRESSION against
 *      parity, which caught those rows (C1, final review 2026-08-12).
 *  Splitting the roles into separate bits is what fixes C1: plain un-word vocabulary is 2, adding a
 *  negator makes 3, and 2 != 3. It also closed the separated-cancellation pair ("cannot be unsafe"
 *  3 vs "cannot be safe" 1) that the presence rule had to pin as a known limit.
 *  Its own accepted cost, ruled acceptable when the rule was approved: an un- form and a negated
 *  antonym state the SAME claim on different bits, so "The migration is unsafe." vs "The migration is
 *  not safe." renders false-'diverge' (2 vs 1) — the declared-safe direction, since false-'diverge'
 *  surfaces as visible doubt while false-'agree' produces false confidence. Pinned as a limit test.
 *  Widening EITHER marker family changes what COLLAPSES as well as what is scanned —
 *  NEGATOR_ALTERNATIVES and UNPREFIXED_NEGATIONS are both interpolated into CANCELLING_PAIR_RE, and
 *  UNPREFIXED_NEGATIONS additionally decides bit 1. So an added word has three effects, not one; an
 *  earlier version of this line claimed the opposite ("no longer changes any cancellation
 *  arithmetic") and was simply false. Re-run the whole negation block when touching any of them.
 *  MUTANTS THAT ARE EQUIVALENT HERE, proved not assumed (targeted probe 2026-08-12), so a future sweep
 *  does not re-report them as coverage gaps: the return value is only ever compared with `===` (see
 *  agreesWithPool), which makes it a PARTITION LABEL rather than a magnitude — so every BIJECTION on
 *  {0,1,2,3} induces the same equality classes and cannot change a verdict. Inverting either bit,
 *  renumbering the un- bit from 2 to 4, and `|` -> `+` (the bits are disjoint) are all bijections and
 *  all survive by construction. What is NOT equivalent, and is pinned: folding the un- bit back into
 *  bit 0 (that is the C1 defect), dropping either bit, and skipping the collapse — each of those
 *  MERGES or SPLITS classes, and each is killed by tests. */
function negationPolarity(s: string): number {
  const collapsed = s.replace(CANCELLING_PAIR_RE, ' ');
  return (NEGATOR_RE.test(collapsed) ? 1 : 0) | (UN_FORM_RE.test(collapsed) ? 2 : 0);
}

/**
 * Compare Helix's answer with Codex's. Both are DATA: this only inspects and reports, it never
 * interprets either side as instructions. Scoring, assignment and classification are three separate
 * passes: a claim on one side is a lexical CANDIDATE for a claim on the other side when their
 * content-token overlap clears SENTENCE_SIM; candidates are then ASSIGNED ONE-TO-ONE, greedily over
 * the similarity ranking, so each claim has at most one counterpart; and an assigned pair AGREES
 * only when both sides share a negation polarity — an assigned pair at opposite polarity (e.g. "is
 * safe" vs "is not safe") is a divergence, not an agreement, even though the words otherwise overlap
 * heavily. Assignment is what stops a claim from borrowing agreement off a counterpart that belongs
 * to some other claim (H1, see hole (4) below). Original casing is preserved in the lists so the
 * user sees exactly what each side said.
 * v1 used a richer claim extractor's place-holder (verbatim-sentence overlap); this is still a
 * heuristic, and a coarse one, wrong in BOTH directions — both are load-bearing for the caller to
 * know about, not just the quieter one:
 *   - False 'diverge' (over-flagging): rhetorical or discourse negation that doesn't invert the
 *     claim ("Isn't this obviously safe?", idiomatic "no doubt"/"no wonder") still counts as a
 *     marker, because a marker scan can't tell a genuine polarity flip from a rhetorical one.
 *     This direction is comparatively safe against an AFFIRMATIVE partner — it reads as an aligner
 *     failure, and the guidance line below tells the caller to go read both answers themselves —
 *     but the SAME spurious marker paired against a genuinely NEGATED claim flips to false-'agree'
 *     instead (see NEGATOR_ALTERNATIVES's false-positive note above); "comparatively safe" describes
 *     the partner-dependent case, not a property of the marker alone. The two-bit rule adds one more
 *     member of this class on purpose: an un- form and a negated antonym say the same thing on
 *     different bits, so "is unsafe" vs "is not safe" (2 vs 1) reads 'diverge' — the accepted cost,
 *     pinned. Two more members were added deliberately, both pinned as documented limits: an
 *     underscore-emphasised "not _unsafe_" (see COLLAPSE_GAP's residue note), and — from round 2's
 *     Critical fix — any QUOTE-, paren- or bracket-wrapped un- word, since those characters had to
 *     leave the gap class to stop a negator reaching across a clause boundary. 'The lock is not
 *     "unsafe".' vs 'The lock is safe.' therefore reads 'diverge' although the two agree. Each of
 *     those trades a false-'agree' (dangerous) for a false-'diverge' (visible), the standing rule here.
 *   - False 'agree' (under-flagging, THE MORE DANGEROUS DIRECTION): a real contradiction that the
 *     marker scan doesn't catch reads as silent agreement, which is the one failure mode that
 *     produces false confidence instead of visible doubt. Two instances of it are CLOSED and pinned:
 *     the even-parity class (N-VERDICT — "No, ... not ..." counted even under count%2 and agreed with
 *     an unnegated claim), closed by collapse-then-presence; and UN-WORD SATURATION (C1 — an un- word
 *     used as plain topic vocabulary saturated the single presence bit to the same value as its own
 *     explicit negation), closed by splitting polarity into two independent bits. Both closures are
 *     recorded WITH their history because the second hole was OPENED by the first fix: presence closed
 *     even-parity but lost a distinction parity had, and C1 is the class parity caught and presence did
 *     not. Only the C1 fix was repairing a regression; the even-parity fix was repairing parity's own
 *     bug. Read that as the standing warning on this function — a change here trades error classes
 *     rather than removing them, so re-measure the WHOLE pin set, never just the class in hand.
 *     Four open holes remain, deliberately not chased further here:
 *       (1) the negator list is a bounded list of English negators, not a parser — an unlisted
 *           negator ("hardly", "rarely", "seldom") still reads as unnegated. Its apostrophe
 *           sub-case, where a LISTED negator failed on the codepoint ("doesn’t" with U+2019), was a
 *           different defect and is closed (I2); this hole is about words that are absent, not
 *           spellings that were missed. Adding a word closes that word and nothing else. Named here
 *           since the polarity work and tested NOWHERE until 2026-08-16, when all three were
 *           measured false-'agree' and pinned — a limit that only a comment asserts is a limit
 *           nothing can stop from drifting.
 *       (2) CONTENT-CARRIED CONTRADICTION. Among lexical candidates the sole test is polarity
 *           equality (see agreesWithPool), so a contradiction is visible ONLY when it moves bit 0
 *           or bit 1. An earlier version of this line said "TRUE ANTONYM PAIRS" and named one
 *           instance as though it were the boundary. The boundary is wider, and the honest
 *           statement is the general one: any contradiction NOT carried by negation morphology is
 *           invisible here. Measured 2026-08-16, every one rendering 'agree' as a lone pair —
 *           figure substitution ("the retry limit is 3" / "is 30"), unit substitution ("25 minutes"
 *           / "25 seconds"), polar adjectives ("safe" / "dangerous"), quantifier and modality
 *           shifts ("every" / "some", "must" / "may"), direction reversals ("before" / "after",
 *           "increases" / "decreases"), and ROLE SWAPS where both sides carry an IDENTICAL token
 *           set (jaccard 1.0) and differ only in which noun fills which slot. The role swap is what
 *           bounds the whole approach: there is no lexical difference to find, so no rule over
 *           token sets can separate them — a fix would have to read structure, which this module
 *           does not have and does not claim to.
 *           SCOPE, stated because the unqualified version is false. "Renders 'agree' with an EMPTY
 *           divergence list" is the LONE-PAIR case. Add one ordinary unpaired sentence and the
 *           verdict flips to 'diverge' for a reason unrelated to the contradiction, which is then
 *           printed under `agreements:` — the caller sees a tool that appears to have found a
 *           conflict and is pointed at the wrong sentence. That is hole (4) seen from the caller's
 *           side, and it is arguably worse than silent agreement; see the pinned multi-claim
 *           absorption test.
 *           THE FIGURE AND UNIT ROWS ARE NOW CLAMPED (H1, 2026-08-20); the rest of the list is not.
 *           Splitting out the token-VISIBLE corner was considered 2026-08-16 and DEFERRED then as
 *           unmeasurable rather than unsound — the suite held no case of agreement across differing
 *           figures, so the rule's cost (turning legitimate agreements that quote different numbers
 *           into false verdicts) could not be seen at all and every test stayed green either way.
 *           One was added the same day for exactly that reason, and it is what made the decision
 *           takeable. What shipped is narrower than the corner as stated: FIGURES AND UNITS ONLY,
 *           not identifiers, and it WITHHOLDS rather than accuses — a pair whose figures differ
 *           leaves `agreements`, contributes a note naming both figure sets, and clamps the verdict
 *           to 'indeterminate' rather than 'diverge' (see PASS 3). That is what bounds the cost the
 *           deferral was worried about: an agreement quoting different numbers now reads as an
 *           abstention with both numbers printed, not as a manufactured conflict. The rule runs on
 *           the RAW sentence, as NEGATOR_RE already does — by tokenSet, "agreement-map.ts:130" is
 *           five tokens and a repeated figure has collapsed to one set member.
 *           STILL OPEN, none of them token-visible in this way: polar adjectives ("safe" /
 *           "dangerous"), quantifier and modality shifts ("every" / "some", "must" / "may"),
 *           direction reversals ("before" / "after", "increases" / "decreases"), and the role swap.
 *           See the "true antonym pair", role swap and caller-visible-face tests for pinned examples.
 *       (3) UN-BIT ATTACHMENT (re-derived 2026-08-12 after the two-bit change): bit 1 records that an
 *           un- form is PRESENT, not what it attaches to. The pair this hole used to be stated as —
 *           a separated cancellation "cannot be unsafe" agreeing with the genuine negation "cannot be
 *           safe" — is now CLOSED (3 vs 1), because giving the un- form its own bit separated them
 *           without widening the collapse. What survives is narrower: two sentences that BOTH score 3,
 *           one cancelling ("cannot be unsafe" = safe) and one reinforcing ("is unsafe and cannot be
 *           used" = unsafe), are indistinguishable and read 'agree' though they are opposites.
 *           Telling those apart needs scope/attachment analysis, not another bit. Collapse stays
 *           adjacency-scoped (whitespace + emphasis/backtick only, see COLLAPSE_GAP). Re-derived by
 *           measurement in round 2 rather than restated: what that scoping actually buys is that an
 *           intervening WORD or CLAUSE OPENER cannot be skipped, which is what keeps "Do not use unsafe
 *           mode." negated — a real warning must not fold down to permission. What it does NOT buy,
 *           and an earlier version of this line implied it did, is any guarantee that the un- word
 *           reached IS the negator's complement: "does not *unsafe mode aside* mark the scope broken"
 *           still collapses, and so does the markup-free "does not unreachable rows aside drop rows"
 *           under the whitespace-only rule that predates the gap class. That is a complement-attachment
 *           hole of the same family as this one, not a character-class problem, and narrowing the class
 *           cannot close it. See the pinned un-bit residue test and the round-2 residual test.
 *       (4) CROSS-PAIRING — CLOSED 2026-08-20 by the one-to-one assignment pass (H1); kept here with
 *           its history because the closure is what the two passes above now depend on. Measured
 *           2026-08-12 and PRE-EXISTING then (the polarity work neither introduced nor changed it):
 *           polarity was judged per SENTENCE while agreement was an OR over every lexical candidate,
 *           so a claim counted as agreed if ANY same-polarity candidate existed — not necessarily the
 *           one it actually corresponded to. In a multi-claim answer whose claims are parallel and
 *           differ by one noun, each claim paired with the WRONG sentence on the other side: "The
 *           lock is safe. The sweep is not safe." vs "The lock is not safe. The sweep is safe."
 *           contradicts on BOTH claims yet rendered 'agree' with an EMPTY divergence list, because
 *           claim 1 found its match in the other side's claim 2 and vice versa. Assignment consumes
 *           each claim at most once, so both pairs now stand on their true counterparts and both are
 *           polarity-discordant. WHAT IS NOT CLOSED: assignment is GREEDY, not an optimal matching,
 *           so on a set of near-equal candidates it can take a locally-best pair that forces a worse
 *           one later. That residue points at false-'diverge' (a mis-assigned pair reads as a
 *           divergence), the declared-safe direction here. See the pinned cross-pairing tests.
 * 'indeterminate' has TWO routes, and they mean the same thing at different depths — the module has
 * established no relationship it is willing to report:
 *   - No lexical candidates ANYWHERE (jaccard is symmetric, so zero one way implies zero the other):
 *     no comparability at all (empty inputs included; they must not read as vacuous agreement).
 *   - Every pair that survived polarity had its figures WITHHELD by the clamp (H1): comparability
 *     was established, the relationship was not.
 * Both are distinct from having candidates that are all polarity-discordant — that IS comparability
 * AND a genuine finding, so it reads 'diverge'. A comparison carrying both a real divergence and a
 * withheld pair reads 'diverge' too: the real finding outranks the abstention, and the withheld
 * pair's note travels in `divergences` beside it either way.
 * NOTE FOR CALLERS that branch on 'indeterminate' to explain themselves: the two routes are NOT
 * distinguishable from the returned shape when the withheld pair is the only pair, so text reading
 * "no claim pairs were found" is false on the second route. See server/handlers.ts, which words its
 * abstention line to cover both.
 */
export function buildAgreementMap(helixAnswer: string, codexAnswer: string): AgreementMap {
  const helix = sentences(helixAnswer);
  const codex = sentences(codexAnswer);
  const helixTok = helix.map(tokenSet);
  const codexTok = codex.map(tokenSet);
  const helixPolarity = helix.map(negationPolarity);
  const codexPolarity = codex.map(negationPolarity);

  // PASS 1 — SCORE. Every (helix claim, codex claim) whose content-token overlap clears the bar is
  // a lexical CANDIDATE. `>=` is a PINNED boundary, not an incidental choice: a jaccard sitting
  // exactly on SENTENCE_SIM is a candidate, and `>` drops such a comparison all the way to
  // 'indeterminate' without any other visible symptom (see the exactly-0.5 test).
  const candidates: { i: number; j: number; sim: number }[] = [];
  for (let i = 0; i < helix.length; i++) {
    for (let j = 0; j < codex.length; j++) {
      const sim = jaccard(helixTok[i]!, codexTok[j]!);
      if (sim >= SENTENCE_SIM) candidates.push({ i, j, sim });
    }
  }
  // anyCandidate tracks whether the aligner found ANY lexical pairing, independent of polarity —
  // this is what 'indeterminate' actually means (no anchor at all). agreements.length alone can no
  // longer stand in for that: a fully polarity-discordant comparison now leaves agreements empty
  // while still having found (and rejected) every candidate, which is a 'diverge', not an abstention.
  // Read off the candidate list rather than off the ASSIGNMENT below, and the two are equivalent
  // anyway: the top-ranked candidate always assigns, since nothing is taken when it is considered.
  const anyCandidate = candidates.length > 0;

  // PASS 2 — ASSIGN, one-to-one (H1, 2026-08-20). Until this pass existed, agreement was an OR over
  // every candidate, so a claim counted as agreed if ANY same-polarity candidate existed anywhere on
  // the other side — not necessarily the claim it actually corresponds to. Two parallel claims that
  // differ by one noun could therefore each pair with the OTHER one's counterpart and cancel out:
  // 'The lock is safe. The sweep is not safe.' vs 'The lock is not safe. The sweep is safe.'
  // contradicts on both claims and rendered 'agree' with an EMPTY divergence list. Greedy over the
  // similarity ranking with each claim consumed at most once is what closes it; the tie-break is
  // input order (i, then j) so that equal-scoring candidates resolve identically on every run.
  // This is an ASSIGNMENT heuristic, not an optimal matching — greedy can pick a locally-best pair
  // that forces a worse global one. That direction is the safe one here (a mis-assigned pair reads
  // as a divergence, not as agreement), and an optimal matching would need a different algorithm
  // than a defensible verdict heuristic warrants.
  candidates.sort((a, b) => b.sim - a.sim || a.i - b.i || a.j - b.j);
  const partnerOfHelix = new Array<number>(helix.length).fill(-1);
  const partnerOfCodex = new Array<number>(codex.length).fill(-1);
  for (const c of candidates) {
    if (partnerOfHelix[c.i] !== -1 || partnerOfCodex[c.j] !== -1) continue;
    partnerOfHelix[c.i] = c.j;
    partnerOfCodex[c.j] = c.i;
  }

  // PASS 3 — CLASSIFY each assigned pair. Three outcomes per claim, not two:
  //   'divergent'      — unassigned (no counterpart at all), or assigned at opposite polarity.
  //   'agreed'         — assigned, same polarity, and the two claims quote the same figures.
  //   'figures-differ' — assigned and same polarity, but the figures inside them do NOT match (H1).
  // The third is the FIGURE CLAMP. A figure substitution ("the retry limit is 3" / "is 30", "25
  // minutes" / "25 seconds") moves neither polarity bit, so before this the pair counted as a plain
  // agreement — the review's own repro. Note what the clamp does NOT claim: it cannot tell a
  // contradiction from two claims that legitimately quote different numbers ("reduced from 10 to 3"
  // beside "the limit is 3"), so it reports neither agreement nor conflict. It withholds the pair —
  // the claims leave `agreements`, a note NAMING both figure sets enters `divergences`, and the
  // verdict is clamped away from 'agree'. Deliberately NOT recorded as an ordinary divergence: doing
  // so would drive the verdict to 'diverge' and assert a conflict this module has no evidence for,
  // which is the same over-claiming, in the other direction, that H1 is about.
  type ClaimStatus = 'agreed' | 'divergent' | 'figures-differ';
  const helixStatus = new Array<ClaimStatus>(helix.length).fill('divergent');
  const codexStatus = new Array<ClaimStatus>(codex.length).fill('divergent');
  const figureNotes: string[] = [];
  for (let i = 0; i < helix.length; i++) {
    const j = partnerOfHelix[i]!;
    if (j < 0) continue;
    if (helixPolarity[i]! !== codexPolarity[j]!) continue;
    const helixFigures = figuresOf(helix[i]!);
    const codexFigures = figuresOf(codex[j]!);
    if (sameFigures(helixFigures, codexFigures)) {
      helixStatus[i] = 'agreed';
      codexStatus[j] = 'agreed';
      continue;
    }
    helixStatus[i] = 'figures-differ';
    codexStatus[j] = 'figures-differ';
    // Both claims and both figure sets go in the note: the figures are what differ, but the caller
    // needs the sentences to judge whether the difference is a conflict. A side that quotes no
    // figure at all reads "cites no figure" rather than an empty gap.
    figureNotes.push(
      `figures differ \u2014 "${helix[i]}" cites ${cites(helixFigures)}; "${codex[j]}" cites ${cites(codexFigures)}`,
    );
  }

  const agreements = helix.filter((_, i) => helixStatus[i] === 'agreed');
  // Withheld pairs are NOT here — that is what keeps them out of the 'diverge' branch below.
  const trueDivergences = [
    ...helix.filter((_, i) => helixStatus[i] === 'divergent'),
    ...codex.filter((_, j) => codexStatus[j] === 'divergent'),
  ];
  const divergences = [...trueDivergences, ...figureNotes];

  // Zero candidates is a failure to COMPARE, not a finding of disagreement (2026-07-26 dogfood
  // specimen: a prose paragraph vs a bulleted list reaching the same conclusion paired nothing
  // and rendered 'diverge'). With no anchor the heuristic has no evidence for agree OR diverge.
  // Candidates that exist but are all polarity-discordant DO have evidence — hence branching on
  // anyCandidate, not on agreements.length as the pre-polarity version did.
  // A withheld figure pair is the SECOND route to 'indeterminate' and it is deliberate: comparability
  // was established (the claims paired) but the relationship was not (see the clamp above). It ranks
  // BELOW a true divergence — a comparison carrying both a real divergence and a withheld pair reads
  // 'diverge', because the real finding is the one the caller must act on, and the note travels with
  // it in `divergences` either way.
  const verdict: AgreementMap['verdict'] = !anyCandidate
    ? 'indeterminate'
    : trueDivergences.length > 0
      ? 'diverge'
      : figureNotes.length > 0
        ? 'indeterminate'
        : 'agree';
  return { verdict, agreements, divergences, withheldPairs: figureNotes.length };
}
