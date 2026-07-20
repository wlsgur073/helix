import { describe, expect, it } from 'vitest';
import { segmentOracle } from '../../scripts/pilot/segment-oracle.js';

const MD = [
  '# STATE', '## Decisions',
  '- Exit code two on usage error.',
  '- Store refuses duplicates (roadmap: split exit codes).',
  '- **Open question (roadmap):** conflates conditions.',
  '## Roadmap', '- do a thing later',
].join('\n');

describe('frozen segmentation rule', () => {
  it('takes top-level bullets, excludes roadmap/open-question entries and Roadmap sections', () => {
    const { entries } = segmentOracle(MD);
    expect(entries.map(e => e.excluded)).toEqual([false, true, true, true]);
    expect(entries[1]!.reason).toMatch(/roadmap/i);
  });
});
