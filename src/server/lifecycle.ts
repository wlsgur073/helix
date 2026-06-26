import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** Everything `installSelfTermination` touches is injected, so it is unit-testable
 *  without a real process. The real wiring (index.ts) passes process/transport/server. */
export interface SelfTerminationDeps {
  stdin: Pick<NodeJS.ReadStream, 'on' | 'readableEnded' | 'destroyed'>;
  stdout: Pick<NodeJS.WriteStream, 'on'>;
  transport: Pick<Transport, 'onclose'>;
  closeServer: () => Promise<void>;
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
    // Force-exit if graceful close hangs. Unref'd so it never keeps the process alive itself.
    deps.setTimer(finish, fallbackMs).unref();
    // Best-effort graceful close; a rejecting close() is incidental noise -> still exit(0).
    Promise.resolve().then(() => deps.closeServer()).then(finish, finish);
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
