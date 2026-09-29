---
'@octanejs/pdf': patch
---

Type the host `ref` prop as `OctaneRef<HTMLDivElement>`. `Page` and `Outline`
forward it to their root `<div>` alongside their own ref, and an object ref typed
for another element was not assignable there.
