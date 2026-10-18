---
'octane': patch
---

Skip renderer-local context identity checks at generic component slots until a renderer-local context is registered. Keep contexts created after an existing root immediately available, including first-use provider hydration and live provider updates.
