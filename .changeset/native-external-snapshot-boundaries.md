---
'octane': minor
'@octanejs/tanstack-router': patch
---

Add native external snapshot boundaries for server transports such as Workers.
Hydration retains the host's live context and scheduler while isolating publisher
signal state, IDs and streamed ownership. Native context codecs admit explicit
server projections, and native style records deduplicate across publishers.

Fix hydration of fragment roots containing only component or control-flow
siblings, and support directly compiled renderer-local context providers.

Keep safe protocol-relative router links external during SSR, hydration and
reactive link updates.
