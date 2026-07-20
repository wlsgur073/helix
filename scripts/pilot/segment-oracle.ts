/** FROZEN segmentation rule v1 (pilot protocol §enumeration). An entry = a top-level "- " bullet.
 *  Exclusion classes (frozen): (a) any entry whose text matches /roadmap|open question/i;
 *  (b) every entry under a section whose heading matches /roadmap/i. */
export function segmentOracle(md: string): { entries: { text: string; excluded: boolean; reason?: string }[] } {
  const entries: { text: string; excluded: boolean; reason?: string }[] = [];
  let sectionExcluded = false;
  for (const line of md.split('\n')) {
    const h = line.match(/^#{1,3}\s+(.*)/);
    if (h) { sectionExcluded = /roadmap/i.test(h[1]!); continue; }
    const b = line.match(/^- (.*)/);
    if (!b) continue;
    const text = b[1]!;
    if (sectionExcluded) entries.push({ text, excluded: true, reason: 'roadmap section' });
    else if (/roadmap|open question/i.test(text)) entries.push({ text, excluded: true, reason: 'roadmap/open-question entry' });
    else entries.push({ text, excluded: false });
  }
  return { entries };
}
