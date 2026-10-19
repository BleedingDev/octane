---
'octane': patch
---

Propagate development hot updates when module-time calls receive local callable aggregates, including objects, arrays, classes and namespaces, whose callbacks may capture a hoisted component before initialization. Ordinary data and deferred calls remain eligible for hot replacement; intrinsic descriptor inspection preserves target values without invoking them while still checking key coercion.

Inspect computed property keys for local coercion callbacks that capture a hoisted component before initialization, so development updates propagate to importers instead of retaining a stale component identity.
