---
'octane': patch
---

Preserve descendant component Blocks and their hook state during development hot updates when the authored component, slot path, and key still match. Release retained descendants when they are removed or their owner unmounts, and keep them available while a refreshed Suspense boundary waits. Descendant retention applies only to HMR.

Also defer teardown of a restarted initial Suspense primary until its root render commits. A later root suspension can then restore its live hooks and DOM for retry, including single-root components. Preserve writable signal owners and unchanged in-flight queries across that rollback, and cancel deferred retirement when the old primary is restored. Retire those owners and pending hook scopes when an earlier deletion cleanup unmounts or replaces the root, even if later commit callbacks stop. These rollback and cleanup corrections also apply to production renders.
