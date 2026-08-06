import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** Everything `installSelfTermination` touches is injected, so it is unit-testable
 *  without a real process. The real wiring (index.ts) passes process/transport/server. */
export interface SelfTerminationDeps {
  stdin: Pick<NodeJS.ReadStream, 'on' | 'readableEnded' | 'destroyed'>;
  stdout: Pick<NodeJS.WriteStream, 'on'>;
  transport: Pick<Transport, 'onclose'>;
  closeServer: () => Promise<void>;
  /** Best-effort wait for any in-flight tool handler (e.g. a helix_dual_verify call an abort just
   *  unblocked and is now writing its completion audit row) to finish, bounded by the budget passed
   *  in -- it must never wait longer than that, or a hung handler turns a clean shutdown into a
   *  hang. Optional: omitting it preserves the exact prior behavior (close then exit, no drain). */
  drainInFlight?: (budgetMs: number) => Promise<void>;
  onSignal: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void;
  exit: (code: number) => void;
  setTimer: (fn: () => void, ms: number) => { unref: () => void };
  fallbackMs?: number;
  log?: (msg: string) => void; // ASCII only
}

/**
 * Self-terminate the MCP server when its stdio client disconnects. The SDK's
 * StdioServerTransport listens only to stdin 'data'/'error' and never exits on
 * EOF, so without this the process outlives a dead client. Triggers (all idempotent
 * -> one shutdown): stdin end/close (primary), transport.onclose, stdout EPIPE
 * (backstop for an inherited write handle), SIGTERM/SIGINT (external shutdown).
 * No parent-PID watchdog (false-positive risk per design spec). Never throws.
 */
export function installSelfTermination(deps: SelfTerminationDeps): void {
  const fallbackMs = deps.fallbackMs ?? 500;
  let shuttingDown = false;

  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log?.(`helix: self-terminating (${reason})`);
    let exited = false;
    const finish = (): void => { if (exited) return; exited = true; deps.exit(0); };
    // Force-exit if graceful close + drain hangs. Unref'd so it never keeps the process alive itself.
    deps.setTimer(finish, fallbackMs).unref();
    // Best-effort graceful close, THEN drain any in-flight handler -- e.g. an abort-unblocked
    // dual-verify call still writing its completion audit row -- before exiting. The drain shares
    // the SAME fallbackMs budget as the force-exit timer above rather than adding a second one on
    // top of it: worst case is still one fallbackMs from shutdown, not two stacked waits.
    Promise.resolve()
      .then(() => deps.closeServer())
      .then(() => deps.drainInFlight?.(fallbackMs), () => deps.drainInFlight?.(fallbackMs))
      .then(finish, finish);
  };

  // 1. stdin EOF (primary): parent's pipe write end closed (clean exit OR forced kill).
  deps.stdin.on('end', () => shutdown('stdin-end'));
  deps.stdin.on('close', () => shutdown('stdin-close'));
  // Install-time race: stdin may already have ended before we attached the listeners.
  if (deps.stdin.readableEnded || deps.stdin.destroyed) shutdown('stdin-already-ended');

  // 2. transport closed by the client. Preserve the Server's own onclose (set by connect()).
  const prevOnclose = deps.transport.onclose;
  deps.transport.onclose = (): void => { prevOnclose?.(); shutdown('transport-close'); };

  // 3. stdout EPIPE backstop: client gone but stdin stayed open -> next write faults.
  //    The SDK never registers a stdout 'error' listener, so this also prevents an
  //    otherwise-unhandled EPIPE from throwing (cf. src/verify/codex.ts:131).
  deps.stdout.on('error', () => shutdown('stdout-error'));

  // 4. external shutdown signals.
  deps.onSignal('SIGTERM', () => shutdown('SIGTERM'));
  deps.onSignal('SIGINT', () => shutdown('SIGINT'));
}
