export interface AgreementMap {
  verdict: 'agree' | 'diverge' | 'indeterminate';
  agreements: string[];
  divergences: string[];
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

/**
 * Compare Helix's answer with Codex's. Both are DATA: this only inspects and reports, it never
 * interprets either side as instructions. A claim agrees when some claim on the other side shares
 * >= SENTENCE_SIM of its content tokens; a claim with no counterpart is a divergence. Original
 * casing is preserved in the lists so the user sees exactly what each side said. v1 used a richer
 * claim extractor's place-holder (verbatim-sentence overlap); this is still a heuristic.
 * Zero pairs — jaccard is symmetric, so zero matches one way implies zero the other — yields
 * 'indeterminate': no comparability was established and no semantic relationship is asserted
 * (empty inputs included; they must not read as vacuous agreement).
 */
export function buildAgreementMap(helixAnswer: string, codexAnswer: string): AgreementMap {
  const helix = sentences(helixAnswer);
  const codex = sentences(codexAnswer);
  const helixTok = helix.map(tokenSet);
  const codexTok = codex.map(tokenSet);

  const matched = (t: Set<string>, pool: Set<string>[]): boolean => pool.some((p) => jaccard(t, p) >= SENTENCE_SIM);

  const agreements = helix.filter((_, i) => matched(helixTok[i]!, codexTok));
  const divergences = [
    ...helix.filter((_, i) => !matched(helixTok[i]!, codexTok)),
    ...codex.filter((_, i) => !matched(codexTok[i]!, helixTok)),
  ];

  // Zero pairs is a failure to COMPARE, not a finding of disagreement (2026-07-26 dogfood
  // specimen: a prose paragraph vs a bulleted list reaching the same conclusion paired nothing
  // and rendered 'diverge'). With no anchor the heuristic has no evidence for agree OR diverge;
  // the zero-match check comes first so two empty answers do not become vacuously 'agree'.
  const verdict: AgreementMap['verdict'] =
    agreements.length === 0 ? 'indeterminate' : divergences.length === 0 ? 'agree' : 'diverge';
  return { verdict, agreements, divergences };
}
