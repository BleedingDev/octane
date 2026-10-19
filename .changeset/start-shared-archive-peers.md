---
'@octanejs/tanstack-start': minor
'@octanejs/tanstack-router-ssr-query': minor
---

Require one consumer-owned router-core instance through an exact peer contract. Start also requires its matching Start client, server and storage helpers and the Octane router as peers. The exact Rspack compiler peer is optional for Vite consumers and must be supplied when using Rsbuild. Consumers must declare the authenticated archives directly; published packages no longer introduce archive URLs as transitive dependencies. The installed Start proof checks these peers resolve to the consumer's physical package instances with strict release-age and exotic-subdependency policies enabled.
