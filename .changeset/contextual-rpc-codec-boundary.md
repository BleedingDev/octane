---
"octane": patch
---

Compile server calls with ServerCallContext to a bounded-protocol target so their browser chunks omit the unused legacy serializer. Preserve local cancellation, streaming result handling, and legacy calls through the shared transport.
