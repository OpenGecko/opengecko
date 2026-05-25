import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function readProjectFile(path: string) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('frontend route navigation resilience source contracts', () => {
  it('mounts a shared route navigation shell on product routes without duplicating the dashboard nav', () => {
    const layout = readProjectFile('frontend/src/routes/+layout.svelte');

    expect(layout).toContain("import RouteNavigation from '$lib/RouteNavigation.svelte'");
    expect(layout).toContain("$page.url.pathname === '/'");
    expect(layout).toContain('{#if !isDashboardRoute}');
    expect(layout).toContain('<RouteNavigation />');
  });

  it('exposes route-polish surfaces in desktop and mobile navigation as frontend product paths', () => {
    const routeNavigation = readProjectFile('frontend/src/lib/RouteNavigation.svelte');

    for (const expected of ["href: '/#markets'", "href: '/categories'", "href: '/#exchanges'", "href: '/status'", "href: '/api'"]) {
      expect(routeNavigation).toContain(expected);
    }

    expect(routeNavigation).toContain('aria-label="Route polish surfaces"');
    expect(routeNavigation).toContain('aria-label="Mobile route polish surfaces"');
    expect(routeNavigation).toContain('Product routes stay frontend-owned');
    expect(routeNavigation).not.toContain("href: '/coins'");
    expect(routeNavigation).not.toContain("href: '/exchanges'");
  });

  it('keeps dashboard fetches on the same API helper/proxy path used by route pages', () => {
    const dashboard = readProjectFile('frontend/src/routes/+page.svelte');

    expect(dashboard).toContain("import { apiBase, apiUrl, rawApiUrl } from '$lib/api'");
    expect(dashboard).toContain('frontend relative proxy /__opengecko_api → configured OpenGecko API');
    expect(dashboard).not.toContain("const apiBase = import.meta.env.PUBLIC_OPENGECKO_API_BASE_URL ?? ''");
  });
});
