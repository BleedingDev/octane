---
'octane': patch
'@octanejs/app-core': patch
'@octanejs/vite-plugin': patch
---

Render external snapshots under the response document authority in production and development. Load document lifecycle handling separately from streamed signals for ordinary pages, while preserving document identity checks and frozen-document signal reads.
