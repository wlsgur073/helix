// Link targets a fresh-clone reader can follow. Absolute URLs, mailto: and pure in-page anchors are
// somebody else's problem; this is about paths that must exist in THIS repository.
import { existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Repo-relative link targets, anchors stripped. */
export function relativeLinkTargets(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(LINK_RE)) {
    const raw = m[1];
    if (raw === undefined) continue;
    if (/^(?:https?:|mailto:|#)/.test(raw)) continue;
    const path = raw.split('#')[0];
    if (path === undefined || path === '') continue;
    out.push(path);
  }
  return out;
}

/** The subset of those targets that do not exist, resolved from the citing file's directory. */
export function brokenLinks(root: string, file: string, markdown: string): string[] {
  const base = join(root, dirname(file));
  return relativeLinkTargets(markdown).filter((t) => !existsSync(normalize(join(base, t))));
}
