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

/** Negation markers, scanned on the RAW sentence — never on tokenSet. tokenSet's
 *  /[\p{L}\p{N}]+/gu splits "doesn't" into "doesn" + "t", so a token-based scan would silently
 *  lose the single most common negation form in prose. Deliberately narrow, three markers: bare
 *  "not", the "n't" contraction suffix (isn't/doesn't/won't/...), and the hyphenated "un-" prefix
 *  (not a bare "un" scan, which would false-positive on "under"/"until"/"union"). */
const NEGATION_MARKER_RE = /\bnot\b|n't\b|\bun-/gi;

/** Parity (even/odd count) of negation markers in a sentence's raw text. Parity, not presence:
 *  two markers cancel ("not un-safe" reads as affirmative), so a claim with a double negation can
 *  still pair with an unnegated claim asserting the same thing. */
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
 * heuristic, and a coarse one: it will false-'diverge' on rhetorical or discourse negation that
 * doesn't invert the claim ("Isn't this obviously safe?"), because the marker count can't tell
 * genuine polarity flips from rhetorical ones.
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
