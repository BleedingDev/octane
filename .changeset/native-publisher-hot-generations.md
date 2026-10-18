---
'octane': minor
'@octanejs/cli': patch
'@octanejs/rspack-plugin': minor
---

Add native publisher boundaries and compiler declaration manifests for isolated hot updates. Rebind compatible signal declarations, cancel replaced query producers, and remount incompatible publisher components while retaining the host document and sibling state.

Have the Rspack plugin validate each hot factory generation before adopting its declarations and reject stale or unadmitted updates.

Include the new hot declaration diagnostics in the CLI reference data.
