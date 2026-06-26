import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { installSelfTermination, type SelfTerminationDeps } from '../../src/server/lifecycle.js';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Harness {
  deps: SelfTerminationDeps;
  stdin: EventEmitter & { readableEnded: boolean; destroyed: boolean };
  stdout: EventEmitter;
  transport: { onclose?: () => void };
  signals: Map<string, () => void>;
  exitCodes: number[];
  fireTimer: () => void;
  setClose: (impl: () => Promise<void>) => void;
}

function harness(over: Partial<{ readableEnded: boolean; destroyed: boolean }> = {}): Harness {
  const stdin = Object.assign(new EventEmitter(), { readableEnded: false, destroyed: false, ...over });
  const stdout = new EventEmitter();
  const transport: { onclose?: () => void } = {};
  const signals = new Map<string, () => void>();
  const exitCodes: number[] = [];
  let timerFn: (() => void) | null = null;
  let closeImpl: () => Promise<void> = () => Promise.resolve();
  const deps: SelfTerminationDeps = {
    stdin: stdin as unknown as SelfTerminationDeps['stdin'],
    stdout: stdout as unknown as SelfTerminationDeps['stdout'],
    transport,
    closeServer: () => closeImpl(),
    onSignal: (sig, handler) => { signals.set(sig, handler); },
    exit: (code) => { exitCodes.push(code); },
    setTimer: (fn) => { timerFn = fn; return { unref: () => {} }; },
    fallbackMs: 500,
  };
  return {
    deps, stdin, stdout, transport, signals, exitCodes,
    fireTimer: () => timerFn?.(),
    setClose: (impl) => { closeImpl = impl; },
  };
}

describe('installSelfTermination', () => {
  it('exits(0) once on stdin end', async () => {
    const h = harness(); installSelfTermination(h.deps);
    h.stdin.emit('end'); await tick();
    expect(h.exitCodes).toEqual([0]);
  });

  it('exits(0) on stdin close', async () => {
    const h = harness(); installSelfTermination(h.deps);
    h.stdin.emit('close'); await tick();
    expect(h.exitCodes).toEqual([0]);
  });

  it('exits(0) on transport.onclose AND calls the previous onclose first', async () => {
    const h = harness();
    const order: string[] = [];
    h.transport.onclose = () => order.push('prev');
    installSelfTermination(h.deps);
    h.transport.onclose!(); await tick();
    expect(order).toEqual(['prev']);
    expect(h.exitCodes).toEqual([0]);
  });

  it('exits(0) on stdout error (EPIPE backstop)', async () => {
    const h = harness(); installSelfTermination(h.deps);
    h.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); await tick();
    expect(h.exitCodes).toEqual([0]);
  });

  it('exits(0) on SIGTERM and on SIGINT', async () => {
    const a = harness(); installSelfTermination(a.deps); a.signals.get('SIGTERM')!(); await tick();
    expect(a.exitCodes).toEqual([0]);
    const b = harness(); installSelfTermination(b.deps); b.signals.get('SIGINT')!(); await tick();
    expect(b.exitCodes).toEqual([0]);
  });

  it('is idempotent: two triggers cause exactly one exit', async () => {
    const h = harness(); installSelfTermination(h.deps);
    h.stdin.emit('end'); h.stdin.emit('close'); await tick();
    expect(h.exitCodes).toEqual([0]);
  });

  it('still exits(0) when server.close() rejects', async () => {
    const h = harness(); h.setClose(() => Promise.reject(new Error('close failed')));
    installSelfTermination(h.deps);
    h.stdin.emit('end'); await tick(); await tick();
    expect(h.exitCodes).toEqual([0]);
  });

  it('force-exits via the fallback timer when close() hangs', async () => {
    const h = harness(); h.setClose(() => new Promise<void>(() => { /* never settles */ }));
    installSelfTermination(h.deps);
    h.stdin.emit('end'); await tick();
    expect(h.exitCodes).toEqual([]);   // close hasn't settled yet
    h.fireTimer();                     // fallback fires
    expect(h.exitCodes).toEqual([0]);
  });

  it('exits(0) immediately if stdin already ended at install time', async () => {
    const h = harness({ readableEnded: true }); installSelfTermination(h.deps);
    await tick();
    expect(h.exitCodes).toEqual([0]);
  });
});
