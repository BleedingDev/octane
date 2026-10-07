# @octanejs/tanstack-router

[TanStack Router](https://tanstack.com/router) for the [octane](https://github.com/octanejs/octane) UI framework.

## Installation

```sh
npm install @octanejs/tanstack-router
pnpm add @octanejs/tanstack-router
```

TanStack Router splits a framework-agnostic core (`@tanstack/router-core` — the
router, route tree, matching, history, and the reactive store) from a thin React
binding (`@tanstack/react-router`). Mirroring `@octanejs/tanstack-query`, this package
re-exports the core **verbatim** and reimplements the framework binding on octane's
hooks. The main runtime surface follows `@tanstack/react-router`, so most router
code works by changing the import.

```tsx
import {
  createRouter,
  createRootRoute,
  createRoute,
  RouterProvider,
  Outlet,
  Link,
  useParams,
} from '@octanejs/tanstack-router';
import { createRoot } from 'octane';

const rootRoute = createRootRoute({ component: RootLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Home });
const itemRoute = createRoute({ getParentRoute: () => rootRoute, path: 'item/$id', component: Item });

const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, itemRoute]) });

createRoot(document.getElementById('app')!).render(() => <RouterProvider router={router} />);

function RootLayout() @{
  <div>
    <Link to="/">{'Home'}</Link>
    <Outlet />
  </div>
}

function Item() @{
  const { id } = useParams({ strict: false });
  <h1>{('Item ' + id) as string}</h1>
}
```

The same code works in React-style `.tsx` too (`className`, `return <jsx>`, `<Link>Home</Link>`) — see `tests/_fixtures/basic-react.tsx`.

## How it works

`@tanstack/router-core` keeps the router state in a reactive store. On the client,
`createRouter` supplies the store factory (`createAtom`/`batch` from
`@tanstack/store` — framework-agnostic), whose atoms expose `.subscribe`/`.get`.
`useStore` binds those to octane's `useSyncExternalStore`, and every read hook
(`useRouterState`, `useLocation`, `useParams`, …) is a selector over it. The match
tree renders **pull-based**: `RouterProvider` renders the first match, and each route
component's `<Outlet/>` looks up the next match via `matchContext` — so navigation
re-renders only the matches that changed.

## Same-route search navigation

Same-route search navigations now render store updates urgently. If the route
component suspends on the new search input, its pending fallback can replace the
current content; the previous automatic same-route hold no longer applies. To
retain stale content while the new data loads, use `useDeferredValue` from `octane`
on the search input (for example, `page`) and render the suspending content from
that deferred value. The router location still advances when navigation commits.

## Scope

Included: `createRouter`, `createRootRoute`, `createRoute`, `RouterProvider`,
`Outlet`, `Link`, `Navigate`, `useRouter`, `useRouterState`, `useLocation`,
`useParams`, `useSearch`, `useLoaderData`, `useMatches`, `useNavigate`,
**`ScrollRestoration`**, **`Await`/`useAwaited` + `defer` (streaming deferred data)**,
and **`lazyRouteComponent` (lazy/code-split route components)**, and **not-found
rendering** (`notFoundComponent`/`defaultNotFoundComponent`/`notFoundMode` — an
unknown URL or a loader throwing `notFound()` renders the not-found UI inside the
layout, per TanStack's fuzzy/root boundary rules), plus the full
`@tanstack/router-core` re-export (`redirect`, `notFound`, history, search helpers,
types). The typed route factories, route-bound hooks, and `Link` surface preserve
TanStack Router's registered-route inference.

The 2026-07-06 gap-closure sweep (see `docs/tanstack-parity-audit.md`) additionally
landed the full Match pipeline (per-route Suspense/CatchBoundary/CatchNotFound,
pending/error/redirected/notFound statuses), router lifecycle events, `useBlocker`/
`Block`, the complete read-hook family (`useMatch`, `useRouteContext`,
`useLoaderDeps`, `useParentMatches`/`useChildMatches`, …), `getRouteApi`/
`createRouteMask`, `useMatchRoute`/`MatchRoute`, `ClientOnly`, search-param
validation/middleware, and full `Link` parity (preloading, masking,
`activeProps`/`inactiveProps`) — differential-verified byte-equal against the real
`@tanstack/react-router`.

File routing is supported through `createFileRoute` and `createLazyFileRoute`.
`@octanejs/tanstack-start` consumes the exported
`@octanejs/tanstack-router/generator-plugin` from its package-owned generator; the
integration masks native `.tsrx` template bodies without changing source offsets,
so generated route-tree edits preserve authored Octane route modules.

The `@octanejs/tanstack-router/ssr/server` and `/ssr/client` entries provide
`RouterServer`, `RouterClient`, buffered rendering, and readable-stream rendering.
Route-owned `Html`/`Head`/`Body`, `HeadContent`, `Scripts`, and `ScriptOnce` preserve
full-document SSR, head assets, and hydration. Streaming uses Octane's native
injection source, so the document begins with a doctype, renderer styles are placed
inside `<head>` with the configured CSP nonce, and serialized router data can stream
without a byte-level HTML transform. These entries are the router foundation used
by `@octanejs/tanstack-start`.

```tsx
// streaming a deferred loader value
<Await promise={data.slow} fallback={'loading…'}>
  {(value) => <pre>{JSON.stringify(value) as string}</pre>}
</Await>

// scroll restoration: either the component or createRouter({ scrollRestoration: true })
<ScrollRestoration />

// code-split a route's component
createRoute({ path: 'item/$id', component: lazyRouteComponent(() => import('./Item')) })
```

Current scope, divergences, and verification status are tracked in the generated
[bindings status table](../../docs/bindings-status.md) (sourced from this
package's `status.json`).

## Divergences from `@tanstack/react-router`

- **Refs are props** (octane's model) — `createLink`'s `forwardRef` becomes a `ref`
  prop.
- **Native DOM events** — link callbacks receive browser events rather than React
  synthetic events.
- Router devtools are distributed separately and are not part of this binding.

## Worker render snapshots

`captureRouterRenderSnapshot` projects a settled router for a separate SSR
publisher. It requires an explicitly associated, locally registered profile with
an exact `{ key, version }`. The wire contains bounded plain JSON: route geometry,
public URL and user history state, derived match IDs/params/search, settled loader
data, and the profile's declared public context. Internal history keys and router
objects, functions, controllers and promises do not cross the boundary.

`restoreRouterRenderSnapshot` creates a fresh native route tree, memory history
and Router, then awaits genuine `router.load()`. It checks the native matches and
URL before restoring loader data through public `router.updateMatch`. Its local
restoration tree must contain no loaders, lifecycle hooks, lazy routes or view
components (including preload-capable components). A named profile supplies
routing-only reconstruction for custom search/params behavior; it cannot replay
the original app's effects. The built-in defaults guard rejects custom routing
functions and per-route case sensitivity unless a named profile admits them.

```ts
const unregister = registerRouterRenderProfile({
  id: { key: 'catalog-routing', version: '1' },
  assertHost(router) { assertDefaultRouterRenderHost(router); },
  createRoutingTree(snapshot) { return createRouterRenderRouteTree(snapshot.routes); },
  routingOptions() { return {}; },
});
associateRouterRenderProfile(hostRouter, {
  id: { key: 'catalog-routing', version: '1' },
  publicContext: { catalog: 'public' },
});
const projection = captureRouterRenderSnapshot(hostRouter);
const restored = await restoreRouterRenderSnapshot(projection, { signal });
try {
  // Provide this genuine Router through the native router Context for SSR.
} finally {
  disposeRouterRenderSnapshot(restored);
  unregister();
}
```

Profiles must be registered at ordinary startup on both host and publisher before
request admission. A profile identity describes locally installed routing
behavior; publisher authentication remains the transport owner's responsibility.
A successfully restored router can be captured for a further Worker hop while its
lease remains live. Its exact profile, routing options and native tree retain
owning provenance; mutation, profile replacement or disposal invalidates capture.
Abort cancels native matches and releases the owned memory history. The module is
browser-safe and exported from the main entry as well as `/ssr/server`.
