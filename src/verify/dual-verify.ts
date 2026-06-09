import type { HelixConfig } from '../config.js';
import type { Availability, CodexRunner } from './codex.js';
import { buildAgreementMap, type AgreementMap } from './agreement-map.js';

export interface DualVerifyDeps {
  config: HelixConfig;
  runner: CodexRunner;
  checkAvailable: () => Promise<Availability>;
}

export interface DualVerifyParams {
  question: string;
  helixAnswer: string;
}

export interface DualVerifyResult {
  ran: boolean;
  reason?: string;
  mode?: HelixConfig['dualVerify']['mode'];
  codexAnswer?: string;   // raw Codex output — DATA, never executed
  agreement?: AgreementMap;
}

/**
 * Cross-validate helixAnswer against Codex. Gates: enabled -> available -> ran.
 * On any gate failure it degrades with a reason and NO codexAnswer (never fabricates).
 */
export async function dualVerify(params: DualVerifyParams, deps: DualVerifyDeps): Promise<DualVerifyResult> {
  if (!deps.config.dualVerify.enabled) return { ran: false, reason: 'dual-verify is disabled in config' };

  const avail = await deps.checkAvailable();
  if (!avail.available) return { ran: false, reason: avail.reason ?? 'codex unavailable' };

  const res = await deps.runner(params.question);
  if (!res.ok) return { ran: false, reason: `codex run failed: ${res.error}` };

  const agreement = buildAgreementMap(params.helixAnswer, res.answer);
  return { ran: true, mode: deps.config.dualVerify.mode, codexAnswer: res.answer, agreement };
}
