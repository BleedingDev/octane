---
'@octanejs/tanstack-router': patch
---

Add exact-version routing-only render profiles for genuine native router reconstruction in separate SSR publishers. Validate bounded public route/match data, restore settled loader data through public updateMatch without replaying app hooks or preloads, and release owned history on abort, failure or disposal.
