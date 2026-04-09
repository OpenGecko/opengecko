import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getLastResolvedConfig, loadConfig, loadRepoDotenv, mergeConfig, resetRepoDotenvLoaderForTests } from '../src/config/env';

describe('repo dotenv loading', () => {
  beforeEach(() => {
    resetRepoDotenvLoaderForTests();
  });

  afterEach(() => {
    resetRepoDotenvLoaderForTests();
  });

  it('loads repo .env values when shell env is unset', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-env-'));

    try {
      writeFileSync(join(tempDir, '.env'), 'DEFILLAMA_BASE_URL=https://llama.example\nDEFILLAMA_YIELDS_BASE_URL=https://yields.example\n');
      const env: NodeJS.ProcessEnv = {};

      expect(loadRepoDotenv({ cwd: tempDir, env })).toBe(true);
      expect(loadConfig(env).defillamaBaseUrl).toBe('https://llama.example');
      expect(loadConfig(env).defillamaYieldsBaseUrl).toBe('https://yields.example');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves shell env values over repo .env values', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-env-'));

    try {
      writeFileSync(join(tempDir, '.env'), 'DEFILLAMA_BASE_URL=https://repo.example\n');
      const env: NodeJS.ProcessEnv = { DEFILLAMA_BASE_URL: 'https://shell.example' };

      expect(loadRepoDotenv({ cwd: tempDir, env })).toBe(true);
      expect(loadConfig(env).defillamaBaseUrl).toBe('https://shell.example');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads repo .env at most once per process', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-env-'));

    try {
      writeFileSync(join(tempDir, '.env'), 'DEFILLAMA_BASE_URL=https://repo.example\n');
      const env: NodeJS.ProcessEnv = {};

      expect(loadRepoDotenv({ cwd: tempDir, env })).toBe(true);
      env.DEFILLAMA_BASE_URL = 'https://mutated.example';
      expect(loadRepoDotenv({ cwd: tempDir, env })).toBe(false);
      expect(loadConfig(env).defillamaBaseUrl).toBe('https://mutated.example');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reloads repo .env when the cwd changes', () => {
    const firstDir = mkdtempSync(join(tmpdir(), 'opengecko-env-'));
    const secondDir = mkdtempSync(join(tmpdir(), 'opengecko-env-'));

    try {
      writeFileSync(join(firstDir, '.env'), 'DEFILLAMA_BASE_URL=https://first.example\n');
      writeFileSync(join(secondDir, '.env'), 'DEFILLAMA_BASE_URL=https://second.example\n');
      const env: NodeJS.ProcessEnv = {};

      expect(loadRepoDotenv({ cwd: firstDir, env })).toBe(true);
      expect(env.DEFILLAMA_BASE_URL).toBe('https://first.example');

      delete env.DEFILLAMA_BASE_URL;
      expect(loadRepoDotenv({ cwd: secondDir, env })).toBe(true);
      expect(loadConfig(env).defillamaBaseUrl).toBe('https://second.example');
    } finally {
      rmSync(firstDir, { recursive: true, force: true });
      rmSync(secondDir, { recursive: true, force: true });
    }
  });

  it('accepts common string boolean env values without breaking backward compatibility', () => {
    const env: NodeJS.ProcessEnv = {
      LOG_PRETTY: 'false',
      DISABLE_REMOTE_CURRENCY_REFRESH: '1',
    };

    const config = loadConfig(env);

    expect(config.logPretty).toBe(false);
    expect(config.disableRemoteCurrencyRefresh).toBe(true);
  });

  it('retains the last successfully resolved config for deterministic startup failure logging', () => {
    const env: NodeJS.ProcessEnv = {
      HOST: '127.0.0.1',
      PORT: '3103',
      DATABASE_URL: ':memory:',
    };

    const config = loadConfig(env);

    expect(getLastResolvedConfig()).toEqual(config);
  });

  it('updates the last resolved config when mergeConfig applies overrides', () => {
    const merged = mergeConfig({
      host: '127.0.0.1',
      port: 3103,
      databaseUrl: './data/opengecko.db',
      logLevel: 'error',
    });

    expect(getLastResolvedConfig()).toEqual(merged);
    expect(getLastResolvedConfig()).toMatchObject({
      host: '127.0.0.1',
      port: 3103,
      logLevel: 'error',
    });
  });
});
