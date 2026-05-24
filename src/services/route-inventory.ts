import type { HTTPMethods, RouteOptions } from 'fastify';

export type OpenGeckoRouteInventoryEntry = {
  method: HTTPMethods;
  path: string;
  family: string;
  scope: 'coingecko_compatible' | 'opengecko_diagnostics' | 'opengecko_operational';
};

export type OpenGeckoRouteInventory = {
  recordRoute: (routeOptions: RouteOptions) => void;
  listRoutes: () => OpenGeckoRouteInventoryEntry[];
};

function inferRouteFamily(path: string) {
  if (path === '/ping') return 'health';
  if (path === '/health') return 'health';
  if (path === '/apis') return 'apis';
  if (path === '/metrics') return 'metrics';
  if (path === '/exchange_rates') return 'simple';
  if (path.startsWith('/simple/')) return 'simple';
  if (path.startsWith('/asset_platforms') || path.startsWith('/token_lists/')) return 'assets';
  if (path.startsWith('/coins/')) return 'coins';
  if (path.startsWith('/exchanges')) return 'exchanges';
  if (path.startsWith('/derivatives')) return 'derivatives';
  if (path.startsWith('/entities/') || path.startsWith('/public_treasury/') || path.includes('/public_treasury/')) return 'treasury';
  if (path.startsWith('/onchain/')) return 'onchain';
  if (path.startsWith('/search')) return 'search';
  if (path.startsWith('/global')) return 'global';
  if (path.startsWith('/diagnostics/')) return 'diagnostics';

  return 'unknown';
}

function inferRouteScope(path: string): OpenGeckoRouteInventoryEntry['scope'] {
  if (path.startsWith('/diagnostics/')) {
    return 'opengecko_diagnostics';
  }

  if (path === '/apis' || path === '/health' || path === '/metrics') {
    return 'opengecko_operational';
  }

  return 'coingecko_compatible';
}

function routeKey(method: HTTPMethods, path: string) {
  return `${method} ${path}`;
}

export function createRouteInventory(): OpenGeckoRouteInventory {
  const routes = new Map<string, OpenGeckoRouteInventoryEntry>();

  return {
    recordRoute(routeOptions) {
      const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];

      for (const method of methods) {
        if (method === 'HEAD') {
          continue;
        }

        const path = routeOptions.url;
        routes.set(routeKey(method, path), {
          method,
          path,
          family: inferRouteFamily(path),
          scope: inferRouteScope(path),
        });
      }
    },
    listRoutes() {
      return [...routes.values()].sort((left, right) =>
        left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
      );
    },
  };
}

export function buildRouteInventoryDiagnostics(inventory: OpenGeckoRouteInventory) {
  const routes = inventory.listRoutes();

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    route_count: routes.length,
    methods: [...new Set(routes.map((route) => route.method))].sort(),
    routes,
  };
}
