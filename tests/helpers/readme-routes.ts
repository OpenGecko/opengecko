import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readRepoFile(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

export function normalizeRouteTemplate(route: string) {
  return route
    .replace(/:[A-Za-z0-9_]+/g, '{param}')
    .replace(/\{[^}]+}/g, '{param}');
}

export function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}

export function extractReadmeApiCoverageGetRoutes() {
  const readme = readRepoFile('README.md');
  const apiCoverage = readme.match(/## API Coverage([\s\S]*?)## Configuration/)?.[1];

  if (!apiCoverage) {
    throw new Error('README.md is missing the API Coverage section before Configuration.');
  }

  return uniqueSorted(
    [...apiCoverage.matchAll(/`GET ([^`]+)`/g)]
      .map((match) => normalizeRouteTemplate(match[1])),
  );
}
