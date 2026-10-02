---
'octane': patch
---

Hydrate a keyed or dynamic component call in an `@if` or `@switch` arm when the server rendered another arm with the same static roots. The client adopts the server arm's nodes through its template, so the server node at the call's position is an element of the other arm, not the component's range. The call built its content but left that element on screen. A call after an adopted static root removed that root instead. The call now replaces exactly the server node at its position, the arm's adopted nodes keep their identity, and hydration reports the mismatch once through `onRecoverableError`.
