export function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.path === pathname) return { route, params: {} };
    const pattern = "^" + route.path.replace(/:([^/]+)/g, "([^/]+)") + "$";
    const match   = pathname.match(new RegExp(pattern));
    if (match) {
      const keys   = [...route.path.matchAll(/:([^/]+)/g)].map((m) => m[1]);
      const params = Object.fromEntries(keys.map((k, i) => [k, match[i + 1]]));
      return { route, params };
    }
  }
  return null;
}
