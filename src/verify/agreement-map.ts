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

const norm = (s: string): string => s.toLowerCase();

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : inter / union;
}

/**
 * Compare Helix's answer with Codex's answer. Both are DATA: this function only inspects
 * and reports, it never interprets either side as instructions. Comparison is
 * case-insensitive, but original text is preserved in agreements/divergences so the user
 * sees exactly what each side said. v1 uses a sentence-overlap heuristic; a richer claim
 * extractor can replace it later behind the same signature.
 */
export function buildAgreementMap(helixAnswer: string, codexAnswer: string): AgreementMap {
  const helix = sentences(helixAnswer);
  const codex = sentences(codexAnswer);
  const helixKeys = new Set(helix.map(norm));
  const codexKeys = new Set(codex.map(norm));

  const agreements = helix.filter((s) => codexKeys.has(norm(s)));
  const divergences = [
    ...helix.filter((s) => !codexKeys.has(norm(s))),
    ...codex.filter((s) => !helixKeys.has(norm(s))),
  ];

  const verdict: AgreementMap['verdict'] = jaccard(helixKeys, codexKeys) > 0.5 ? 'agree' : 'diverge';
  return { verdict, agreements, divergences };
}
