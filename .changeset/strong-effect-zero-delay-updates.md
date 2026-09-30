---
'octane': patch
'@octanejs/mcp-server': patch
---

Close zero-delay and custom-hook bypasses of Strong's synchronous effect update check. `OCTANE_STRONG_EFFECT_STATE_UPDATE` now treats callbacks that run before the next paint as effect setup: `startTransition`, a `useTransition` start function, `queueMicrotask`, `.then`/`.catch`/`.finally` on `Promise.resolve(value)` or `Promise.reject()`, `setTimeout` without a positive delay, and code after awaiting a value that is not a pending promise. It also follows state tuples, updaters, callbacks, and transition starts returned by same-module custom hooks, in `.tsrx`, `.tsx`, and plain TypeScript modules. `requestAnimationFrame`, timers with a positive delay, and external subscription callbacks remain event-driven. Compatibility modules and emitted code are unchanged.
