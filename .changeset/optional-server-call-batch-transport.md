---
'octane': patch
---

Load server-call collection and batch transport support only when an application uses batchServerCalls, keeping ordinary compiled RPC clients free of unused batching code.
