import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // A review worktree under .claude/ is a COPY of this project, not part of it. Without this the
    // copy's test files are collected as if they were ours, and the suite reports on a tree nobody
    // is working in -- measured once as 615 files and four failures that meant nothing.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
