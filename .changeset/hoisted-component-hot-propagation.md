---
'octane': patch
---

Propagate hot updates to importers when authored code captures a component before its HMR wrapper initializes, including directly exported components. Keep compatible aliases created after initialization eligible for state-preserving hot updates. Ordinary component-local references remain self-accepting, and later component references evaluated at render time keep their state-preserving signal recipes.
