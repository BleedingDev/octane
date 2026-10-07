# External native snapshots

`externalSnapshotBoundary` renders an Octane component on another server, then
hydrates that output inside the host's existing scope. The browser keeps its
live ancestor providers and the host's scheduler. Each boundary owns a separate
signal authority and ID namespace.

This is useful when a Workers service renders the server component while Module
Federation supplies its browser component. Octane owns the snapshot protocol;
the transport forwards its serialized request and response unchanged.

```text
host native Suspense
  externalSnapshotBoundary
    request -> admitted publisher -> renderExternalSnapshot
    native HTML + style records + head + historical seeds
    browser native lazy component
      same server DOM, live host context, boundary-owned signals
```

## Host boundary

```ts
import { externalSnapshotBoundary, lazy } from 'octane';
import {
  decodeExternalSnapshot,
  serializeExternalSnapshotRequest,
} from 'octane';

const Remote = externalSnapshotBoundary({
  authority: { publisherBuildId: admittedClientBuildId, runtimeABI: 1 },
  component: lazy(loadNativeBrowserComponent),
  contextKeys: ['application.theme'],
  timeoutMs: 3000,
  async snapshot(request, signal) {
    const response = await transport.request({
      payload: serializeExternalSnapshotRequest(request),
      signal,
    });
    return decodeExternalSnapshot(response.payload);
  },
});
```

Use the publisher's validated client build ID. Obtain that authority before
constructing the boundary. An outer native `lazy` loader can suspend while the
transport admits the publication, then return the boundary component.

Both the server render and browser root receive the same trusted host document
identity through `externalSnapshots: { documentId }`. Allocate this identity for
the host document, alongside its normal streamed-signal bootstrap. A build ID
does not identify a document.

Place the boundary inside native `Suspense` to show pending content and recover
from server transport failures. `timeoutMs` aborts this boundary's snapshot
waiter. Completion or cancellation of the host render also aborts it. A later
server request starts a fresh load. A streaming Suspense arm may replace its
provisional request when it establishes its final ID namespace. Octane cancels
that request's transport waiter, and the callback renders the new request.
Browser component failures use the nearest
native error boundary.

## Publisher endpoint

```ts
import {
  decodeExternalSnapshotRequest,
  renderExternalSnapshot,
  serializeExternalSnapshot,
} from 'octane/server';

const authority = { publisherBuildId: ownClientBuildId, runtimeABI: 1 } as const;

async function render(payload: unknown, signal: AbortSignal) {
  const request = decodeExternalSnapshotRequest(payload, authority);
  const { default: Component } = await loadAdmittedExpose();
  return serializeExternalSnapshot(
    await renderExternalSnapshot(Component, request, { authority, signal }),
  );
}
```

The endpoint admits its publication and native authority before importing the
exposed module. The producer checks the expected authority again before decoding
context values or invoking the component. `request.props` is its only props
input. Namespace, document identity, context projections and nonce come from the
same immutable request.

An endpoint can install its own local providers through
`initializeContexts(provide)`, for example its nested federation transport.
Call `provide(Context, value)` synchronously. The producer adds these providers
without adding component frames or hydration markers. It rejects duplicate
contexts and stops accepting values when the initializer returns. These values
do not enter the wire payload or replace the browser's live host providers.

The producer uses native Hydrate framing and serializers. Its snapshot includes
native `use()` history and signal witnesses. The host feeds scoped style records
into its normal CSS collector, so styles shared with the host or another
boundary are deduplicated. Native head markers use the boundary namespace;
hydration adopts those exact head nodes and unmount removes only its own nodes.

## Context projections

Register each server context projection on the host and publisher:

```ts
import { registerExternalSnapshotContext } from 'octane';

const unregister = registerExternalSnapshotContext(Theme, {
  key: 'application.theme',
  encode: value => ({ title: value.title }),
  decode: value => ({ title: String(value.title) }),
});
```

Only the boundary's explicit `contextKeys` are transferred. Omitting the option
transfers none. Every selected key requires a registered codec and a real
ancestor provider. Codec output must be supported by Octane's native data codec.
Registration captures the key and functions until `unregister()` runs.

A decoder may return a value or a promise. It receives the producer's abort
signal as its second argument. The producer awaits every selected decoder
before running the exposed component, and cancels the wait when the request or
deadline expires.

These projections reconstruct publisher server providers. Browser hydration
reads the live host scope instead. Host and browser remote therefore share the
actual native Context function identity, normally through Module Federation's
singleton configuration. A wire key does not replace that browser identity.

## Ownership

The boundary keeps its host parent scope and render owner, while its data owner,
root signal ancestry and IDs start inside the boundary namespace. Its signal
globals belong to that boundary, even when two publishers use the same compiled
signal site. Each boundary consumes one host ID; publisher IDs do not advance
the host's later sibling allocator.

Streamed ingress and activation route by publisher build, host document and
boundary owner. Disposing a boundary releases only its own lease; sibling
publishers keep receiving results. Late frames for a disposed authority are
ignored. A lazy component that settles after unmount cannot reactivate its old
boundary.
