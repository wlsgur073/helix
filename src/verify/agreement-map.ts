export interface AgreementMap {
  verdict: 'agree' | 'diverge' | 'indeterminate';
  agreements: string[];
  divergences: string[];
}

/** Split an answer into trimmed claim-sentences, preserving original casing for display. */
function sentences(answer: string): string[] {
  return answer
    .split(/[.\n;]+/)
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

/** Negation markers, scanned on the RAW sentence — never on tokenSet. tokenSet's
 *  /[\p{L}\p{N}]+/gu splits "doesn't" into "doesn" + "t", so a token-based scan would silently
 *  lose the single most common negation form in prose. Covers: bare "not"; the "n't" contraction
 *  suffix (isn't/doesn't/won't/...); "no"; "never"; "cannot" (its own alternative because "not"
 *  isn't a separately-\b-bounded token inside "cannot" — the two letters "n" before it block the
 *  boundary); the hyphenated "un-" prefix (e.g. "un-safe", not a bare "un" scan — see
 *  UNPREFIXED_NEGATIONS for why); and UNPREFIXED_NEGATIONS's bounded whole-word list.
 *  Known false-positive source, by design left unguarded rather than chasing an ever-growing
 *  exclusion list: "no" is a genuine negator in "no race" but an intensifier, not a negator, in
 *  idioms like "no doubt" or "no wonder" — those would count a marker that isn't semantically
 *  negating anything, which can only produce a false 'diverge' (the direction that reads as an
 *  aligner failure the caller notices and re-reads both answers for), never a false 'agree' (the
 *  direction that reads as false confidence and slips by unnoticed). */
const NEGATION_MARKER_RE = new RegExp(
  String.raw`\bnot\b|n't\b|\bno\b|\bnever\b|\bcannot\b|\bun-|\b(?:${UNPREFIXED_NEGATIONS.join('|')})\b`,
  'gi',
);

/** Parity (even/odd count) of negation markers in a sentence's raw text. Parity, not presence:
 *  two markers cancel ("not un-safe" reads as affirmative), so a claim with a double negation can
 *  still pair with an unnegated claim asserting the same thing. Widening the marker set changes
 *  this arithmetic too — a sentence using both "cannot" and "not" now counts 2, not 1 — so any
 *  future marker addition must re-run the even-parity guard test, not just its own new case. */
function negationParity(s: string): number {
  return (s.match(NEGATION_MARKER_RE) ?? []).length % 2;
}

/**
 * Compare Helix's answer with Codex's. Both are DATA: this only inspects and reports, it never
 * interprets either side as instructions. Pairing and classification are separate passes
 * (pair-then-classify): a claim on one side is a lexical CANDIDATE for a claim on the other side
 * when their content-token overlap clears SENTENCE_SIM; among its candidates, a claim AGREES only
 * with ones sharing its negation parity — a lexical candidate at opposite parity (e.g. "is safe"
 * vs "is not safe") is a divergence, not an agreement, even though the words otherwise overlap
 * heavily. Original casing is preserved in the lists so the user sees exactly what each side said.
 * v1 used a richer claim extractor's place-holder (verbatim-sentence overlap); this is still a
 * heuristic, and a coarse one, wrong in BOTH directions — both are load-bearing for the caller to
 * know about, not just the quieter one:
 *   - False 'diverge' (over-flagging): rhetorical or discourse negation that doesn't invert the
 *     claim ("Isn't this obviously safe?", idiomatic "no doubt"/"no wonder") still counts as a
 *     marker, because marker-counting can't tell a genuine polarity flip from a rhetorical one.
 *     This direction is comparatively safe — it reads as an aligner failure, and the guidance line
 *     below tells the caller to go read both answers themselves.
 *   - False 'agree' (under-flagging, THE MORE DANGEROUS DIRECTION): this is what N-VERDICT was —
 *     a real contradiction that the marker scan doesn't catch reads as silent agreement, which is
 *     the one failure mode that produces false confidence instead of visible doubt. Two open
 *     holes, deliberately not chased further here: (1) NEGATION_MARKER_RE is a bounded list of
 *     English negators, not a parser — an unlisted negator (e.g. "hardly", "rarely", "seldom")
 *     still reads as unnegated; (2) TRUE ANTONYM PAIRS with unrelated word roots and no negation
 *     morphology at all — "safe" vs "dangerous", "safe" vs "risky" — are categorically outside
 *     what a marker scan can ever catch, negated or not; there is no marker to find. A
 *     contradiction phrased purely as antonyms renders 'agree' today and will keep doing so under
 *     this design; see the "true antonym pair" test for a pinned example.
 * No lexical candidates ANYWHERE (jaccard is symmetric, so zero one way implies zero the other)
 * yields 'indeterminate': no comparability was established and no semantic relationship is
 * asserted (empty inputs included; they must not read as vacuous agreement). This is distinct from
 * having candidates that are all polarity-discordant — that IS comparability, and a genuine
 * finding, so it reads 'diverge', not 'indeterminate'.
 */
export function buildAgreementMap(helixAnswer: string, codexAnswer: string): AgreementMap {
  const helix = sentences(helixAnswer);
  const codex = sentences(codexAnswer);
  const helixTok = helix.map(tokenSet);
  const codexTok = codex.map(tokenSet);
  const helixParity = helix.map(negationParity);
  const codexParity = codex.map(negationParity);

  // anyCandidate tracks whether the aligner found ANY lexical pairing, independent of polarity —
  // this is what 'indeterminate' actually means (no anchor at all). agreements.length alone can no
  // longer stand in for that: a fully polarity-discordant comparison now leaves agreements empty
  // while still having found (and rejected) every candidate, which is a 'diverge', not an abstention.
  let anyCandidate = false;
  const agreesWithPool = (
    tok: Set<string>,
    parity: number,
    poolTok: Set<string>[],
    poolParity: number[],
  ): boolean => {
    let agree = false;
    for (let j = 0; j < poolTok.length; j++) {
      if (jaccard(tok, poolTok[j]!) >= SENTENCE_SIM) {
        anyCandidate = true;
        if (parity === poolParity[j]) agree = true;
      }
    }
    return agree;
  };

  const helixAgrees = helix.map((_, i) => agreesWithPool(helixTok[i]!, helixParity[i]!, codexTok, codexParity));
  const codexAgrees = codex.map((_, j) => agreesWithPool(codexTok[j]!, codexParity[j]!, helixTok, helixParity));

  const agreements = helix.filter((_, i) => helixAgrees[i]);
  const divergences = [
    ...helix.filter((_, i) => !helixAgrees[i]),
    ...codex.filter((_, j) => !codexAgrees[j]),
  ];

  // Zero candidates is a failure to COMPARE, not a finding of disagreement (2026-07-26 dogfood
  // specimen: a prose paragraph vs a bulleted list reaching the same conclusion paired nothing
  // and rendered 'diverge'). With no anchor the heuristic has no evidence for agree OR diverge.
  // Candidates that exist but are all polarity-discordant DO have evidence — hence branching on
  // anyCandidate, not on agreements.length as the pre-polarity version did.
  const verdict: AgreementMap['verdict'] = !anyCandidate
    ? 'indeterminate'
    : divergences.length === 0
      ? 'agree'
      : 'diverge';
  return { verdict, agreements, divergences };
}
