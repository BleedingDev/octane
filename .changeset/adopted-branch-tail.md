---
'octane': patch
---

Remove the server content left after an adopted `@if` or `@switch` arm during hydration. When the server rendered another arm whose content starts with what the client arm renders, the client adopted that prefix and kept the rest of the server arm on screen without a report. Hydration now discards the stale remainder after the arm's content and reports it once through `onRecoverableError`, plus a located development warning. The nodes the arm adopted keep their identity. To find where a multi-root arm ends without parsing its template in production, the compiler now passes the template's root count to `template()`.
