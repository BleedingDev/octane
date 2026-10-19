---
'octane': patch
---

Propagate development hot updates to importers when a module-time call receives a local callback that may capture a hoisted component before initialization. This conservatively includes unresolved callees whose callback behavior cannot be proven; calls deferred until rendering remain eligible for hot replacement.
