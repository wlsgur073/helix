/** FROZEN derivation rule v1 (pilot protocol §derivation). Deterministic, no I/O, no randomness.
 *  Changing ANY behavior here after the METHOD FREEZE commit is a protocol deviation. */
const STOPWORDS = new Set(('a an and are as at be but by for from has have if in into is it its of on or ' +
  'that the this to was were will with not no now must never every each when after before only').split(' '));

export function topicTerms(text: string): string[] {
  const noFormerly = text.split(/\bFormerly:/)[0]!;          // current form is the probe target
  const noCode = noFormerly.replace(/`[^`]*`/g, ' ');        // strip code spans (answer-leakage guard)
  const noDigits = noCode.replace(/[0-9]+/g, ' ');           // strip numerals (ids, exit codes)
  const tokens = noDigits.toLowerCase().match(/[a-z][a-z-]+/g) ?? [];
  const out: string[] = [];
  for (const t of tokens) {
    if (STOPWORDS.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length === 8) break;
  }
  return out;
}
export function deriveQuery(text: string): string { return topicTerms(text).join(' '); }
