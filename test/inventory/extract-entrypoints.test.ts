import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractHooks, extractClis } from '../../scripts/inventory/extract-entrypoints.js';

describe('hook extraction', () => {
  it('derives hooks from the registration, and resolves each to an existing bundle', () => {
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const hooks = extractHooks();
    expect(hooks.map((h) => h.event).sort()).toEqual(['SessionEnd', 'SessionStart']);
    for (const h of hooks) {
      // 빈 문자열을 먼저 배제한다. `join(ROOT, '')`는 `ROOT` 자신으로 정규화되고 저장소
      // 루트는 항상 존재하므로, 이 단언이 없으면 정규식이 실패해 `bundle`이 비어도 아래
      // 두 검사가 모두 통과한다. Task 4의 스냅샷은 이 값을 그대로 고정한다.
      expect(h.bundle.length, `${h.event} resolved to an empty bundle path`).toBeGreaterThan(0);
      // 스냅샷에 들어가는 값은 저장소 기준 상대 경로이다. 절대 경로는 기계마다 달라져
      // Task 4의 표류 테스트를 이 기계 밖에서 무의미하게 만든다.
      expect(h.bundle.startsWith('/'), `${h.event} carries an absolute path: ${h.bundle}`).toBe(false);
      expect(existsSync(join(ROOT, h.bundle)), `${h.event} resolves to a missing bundle: ${h.bundle}`).toBe(true);
    }
  });

  it('carries the declared timeout, which is part of the contract', () => {
    for (const h of extractHooks()) {
      expect(typeof h.timeout, `${h.event} has no declared timeout`).toBe('number');
    }
  });
});

describe('operator CLI extraction', () => {
  it('recovers each CLI usage line by executing it with no arguments', () => {
    const clis = extractClis();
    expect(clis.length).toBe(2);
    for (const c of clis) {
      expect(c.usage.length, `${c.bundle} printed no usage`).toBeGreaterThan(0);
      expect(c.noArgsExitCode, `${c.bundle} did not exit 2 on a usage error`).toBe(2);
    }
  }, 60_000);

  it('the trigger CLI declares required arguments in its usage', () => {
    const trigger = extractClis().find((c) => c.bundle.includes('helix-trigger'));
    expect(trigger, 'the trigger CLI is no longer shipped').toBeDefined();
    // 문서가 제시하는 인자 없는 호출이 실행되지 않는 근거가 되는 계약.
    expect(trigger!.usage).toContain('--root');
    expect(trigger!.usage).toContain('--run');
  }, 60_000);
});
