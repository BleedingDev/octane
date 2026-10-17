---
'octane': minor
'@octanejs/tanstack-router': minor
---

Add opt-in native external snapshot boundaries with explicit publisher and document authority, selected context codecs, and a single-use prepare/render/release request lifetime. Adopt publisher HTML inside its existing parent root while isolating streamed results and component IDs.

Add registered router render profiles and public capture, restore and disposal contracts for request-owned routing snapshots without rerunning application loaders or lifecycle hooks.

Router capture requires the server-load pending-state fix in TanStack/router#8740. The current router-core 1.171.34 pin is not qualified for this feature; adopt the fixed core before publishing these APIs.
