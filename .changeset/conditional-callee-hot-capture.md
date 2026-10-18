---
'octane': patch
---

Propagate development hot updates to importers when a conditional or logical callee can capture a hoisted component before initialization, including constructors and tagged templates. Calls deferred until rendering remain eligible for hot replacement.
