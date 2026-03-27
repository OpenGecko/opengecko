import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, loadRepoDotenv, resetRepoDotenvLoaderForTests } from '../src/config/env';

describe('repo dotenv loading', () => {
  beforeEach(() => {
    resetRepoDotenvLoaderForTests();
  });

  afterEach(() => {
    resetRepoDotenvLoaderForTests();
  });

  it('loads THEGRAPH_API_KEY from repo .env when shell env is unset', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-env-'));

    try {
      writeFileSync(join(tempDir, '.env'), 'THEGRAPH_API_KEY=repo-key\nDEFILLAMA_BASE_URL=https://llama.example\nDEFILLAMA_YIELDS_BASE_URL=https://yields.example\n');
      const env: NodeJS.ProcessEnv = {};

      expect(loadRepoDotenv({ cwd: tempDir, env })).toBe(true);
      expect(loadConfig(env).thegraphApiKey).toBe('repo-key');
      expect(loadConfig(env).defillamaBaseUrl).toBe('https://llama.example');
      expect(loadConfig(env).defillamaYieldsBaseUrl).toBe('https://yields.example');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves shell env values over repo .env values', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-env-'));

    try {
      writeFileSync(join(tempDir, '.env'), 'THEGRAPH_API_KEY=repo-key\n');
      const env: NodeJS.ProcessEnv = { THEGRAPH_API_KEY: 'shell-key' };

      expect(loadRepoDotenv({ cwd: tempDir, env })).toBe(true);
      expect(loadConfig(env).thegraphApiKey).toBe('shell-key');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads repo .env at most once per process', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-env-'));

    try {
      writeFileSync(join(tempDir, '.env'), 'THEGRAPH_API_KEY=repo-key\n');
      const env: NodeJS.ProcessEnv = {};

      expect(loadRepoDotenv({ cwd: tempDir, env })).toBe(true);
      env.THEGRAPH_API_KEY = 'mutated-key';
      expect(loadRepoDotenv({ cwd: tempDir, env })).toBe(false);
      expect(loadConfig(env).thegraphApiKey).toBe('mutated-key');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
