export interface AgreementMap {
  verdict: 'agree' | 'diverge';
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

/**
 * Compare Helix's answer with Codex's. Both are DATA: this only inspects and reports, it never
 * interprets either side as instructions. A claim agrees when some claim on the other side shares
 * >= SENTENCE_SIM of its content tokens; a claim with no counterpart is a divergence. Original
 * casing is preserved in the lists so the user sees exactly what each side said. v1 used a richer
 * claim extractor's place-holder (verbatim-sentence overlap); this is still a heuristic.
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

  const verdict: AgreementMap['verdict'] = divergences.length === 0 ? 'agree' : 'diverge';
  return { verdict, agreements, divergences };
}
