---
'octane': minor
'@octanejs/tanstack-router': minor
---

Add opt-in native external snapshot boundaries with explicit publisher and document authority, selected context codecs, and a single-use prepare/render/release request lifetime. Adopt publisher HTML inside its existing parent root while isolating streamed results and component IDs.

Carry native stylesheet resources across snapshot boundaries by href, preserving precedence, authored attributes and streaming order while deduplicating nested and sibling publishers within each document.

Initialize renderer-local context providers on their first compiled DOM render, and preserve external snapshot nodes and typed input while reconciling live host context values.

Add registered router render profiles and public capture, restore and disposal contracts for request-owned routing snapshots without rerunning application loaders or lifecycle hooks.

Rebuild snapshot route trees from a request-local parent index to preserve sibling order without rescanning all routes for every parent.

Router capture requires the server-load pending-state fix in TanStack/router#8740. The adapter now takes router-core 1.171.38 as an exact peer so the application owns one shared core instance without a transitive archive request. Qualify the final merged core archive and its resolved identity before publishing these APIs.

Keep `octane/server` declarations usable without Node ambient types by isolating the unchanged Node stream adapter behind `octane/static`.

Avoid mutating non-extensible hoisted component functions when adding development/HMR identity metadata.

Conservatively propagate hot updates to importers when early local calls, constructors, tagged templates, getters, local aliases or arguments, destructuring/defaults, static class initializers, spreads, iteration or decorators can capture a hoisted component. Iterative, cached local aggregate checks handle deep binding chains without recursive stack exhaustion. These checks include all reachable closures: unrelated early property reads, alias/closure assignments, static initializers and local lazy-helper arguments may also propagate, while ordinary initializer reads deferred until rendering remain eligible. Opaque calls and early JSX evaluation remain pre-existing analysis limitations.
