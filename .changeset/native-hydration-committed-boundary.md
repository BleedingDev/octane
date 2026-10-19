---
"octane": patch
---

Load native signal hydration only when a committed publisher boundary needs it,
so ordinary imports leave the signal engine uninitialized. Preserve synchronous
publisher activation when native hydration is already available, and cancel
pending activation when its boundary unmounts or its document retires.
