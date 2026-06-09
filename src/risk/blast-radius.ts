import type { BlastRadius } from '../types.js';

export interface ActionDescriptor {
  kind: 'read' | 'write' | 'exec' | 'spawn' | 'network';
  target?: string;   // path or URL
  command?: string;  // for exec/spawn
}

/**
 * Classify how dangerous an action is. Deterministic, no LLM.
 * Fail-safe: anything not recognized as clearly safe -> hard-to-reverse.
 */
export function classifyAction(action: ActionDescriptor): BlastRadius {
  switch (action.kind) {
    case 'read':
      return 'read-only';
    case 'network':
    case 'spawn':
      return 'external';
    case 'write':
      return 'local-reversible';
    case 'exec':
      // An arbitrary shell command is not provably safe or reversible, so it is
      // conservatively hard-to-reverse. (Per-command refinement can come later.)
      return 'hard-to-reverse';
    default:
      return 'hard-to-reverse'; // unknown kind -> fail safe
  }
}
