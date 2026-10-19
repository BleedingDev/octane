# @octanejs/tanstack-router-ssr-query

Octane port of `@tanstack/react-router-ssr-query` — wires TanStack Query
dehydration/hydration into TanStack Router SSR streaming and wraps the app
in a `QueryClientProvider`. Delegates to the framework-agnostic
`@tanstack/router-ssr-query-core`.

## Installation

```sh
npm install @octanejs/tanstack-router-ssr-query @octanejs/tanstack-query @octanejs/tanstack-router @tanstack/router-core@1.171.38
pnpm add @octanejs/tanstack-router-ssr-query @octanejs/tanstack-query @octanejs/tanstack-router @tanstack/router-core@1.171.38
```

The application owns the shared `@tanstack/router-core` dependency at version
`1.171.38`. When using a verified core archive, select it for that application
dependency so the router bindings and Start resolve the same core instance.
