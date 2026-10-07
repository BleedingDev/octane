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
    request -> prepare -> decode + validate -> expose import -> render
    finally -> release prepared request
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
  prepareExternalSnapshotRequest,
  releasePreparedExternalSnapshotRequest,
  renderExternalSnapshot,
  serializeExternalSnapshot,
} from 'octane/server';

const authority = { publisherBuildId: ownClientBuildId, runtimeABI: 1 } as const;

async function render(payload: unknown, signal: AbortSignal) {
  const prepared = await prepareExternalSnapshotRequest(payload, {
    authority,
    signal,
    timeoutMs: 3000,
  });
  try {
    const { default: Component } = await loadAdmittedExpose(prepared.signal);
    prepared.signal.throwIfAborted();
    return serializeExternalSnapshot(await renderExternalSnapshot(Component, prepared));
  } finally {
    await releasePreparedExternalSnapshotRequest(prepared);
  }
}
```

`prepareExternalSnapshotRequest(payload, options)` checks the required
`options.authority`, admits the immutable request, reconstructs its selected
contexts and validates them before the endpoint imports exposed code. Its
opaque, frozen handle exposes only `signal`. `renderExternalSnapshot(Component,
prepared)` consumes that handle once. Always await
`releasePreparedExternalSnapshotRequest(prepared)` in `finally`, including when
the expose import fails.

The producer uses the request's props, namespace, document identity, context
projections and nonce. For a component that is already loaded,
`renderExternalSnapshot(Component, request, options)` prepares and releases
internally. Both forms return `Promise<ExternalSnapshot>`.

After synchronous request admission, `timeoutMs` covers asynchronous context
decoding and validation, expose loading and rendering. Rendering keeps the
original deadline. Producer `timeoutMs: 0` disables its timer. Pass the prepared
signal to a loader that accepts cancellation. A native module import cannot be
canceled; if it finishes after expiry, the closed handle prevents rendering.

An endpoint can install its own local providers through
the preparation option `initializeContexts(provide)`, for example its nested
federation transport. Initialization runs after selected context validation.
Call `provide(Context, value)` synchronously, and return synchronously from the
initializer itself; returning a promise is rejected. The producer adds these
providers without adding component frames or hydration markers. It rejects duplicate
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
  decode: (value, signal) => restoreTheme(value, signal),
  dispose: value => releaseTheme(value),
});
```

Only the boundary's explicit `contextKeys` are transferred. Omitting the option
transfers none. Every selected key requires a registered codec and a real
ancestor provider. Codec output must be supported by Octane's native data codec.
Registration captures the key and functions until `unregister()` runs.

`decode(value, signal?)` may return a value or a promise. The producer runs
selected decoders concurrently and awaits them before importing exposed code.
Optional `dispose(value)` may also return a promise; release or cancellation
cleans up reconstructed server values. A decoder that finishes after
cancellation cannot enter the closed lease. If `dispose` is supplied, that late
value is disposed.

Optional `validate(value, readContext, signal?)` runs after every selected value
has been reconstructed and before trusted initialization or expose import. It
may return a promise. `readContext(Context)` looks up the physical native
Context function among this request's selected values and returns either
`{ present: true, value }` or `{ present: false }`. It supplies no default value
or unrelated provider. A selected `undefined` value is still present. Register
and select every context a validator requires, and use the reader only during
validation.

These projections reconstruct publisher server providers. Browser hydration
reads the live host scope instead. Host and browser remote therefore share the
actual native Context function identity, normally through Module Federation's
singleton configuration. A wire key does not replace that browser identity.

## Native data limits

The request's props and selected context values form one native encoded forest.
Logical roots have depth zero; the maximum depth is 64, with at most 100,000
logical values across the whole forest. Empty objects and arrays count as
values, and repeated references count each occurrence.

Value strings, sorted object keys and selected context keys share an 8 MiB
UTF-8 budget. Each value string or object key is limited to 1 MiB. Encoded tuple
tags and envelope overhead do not consume that authored-data budget. Decoders
reject getters, cycles and malformed tuples, with separate raw wire bounds checked
before JSON parsing.

Responses admit the echoed request before copying its encoded tree. HTML, head
and CSS share a separate 32 MiB UTF-8 budget; individual body strings may exceed
1 MiB within it. A response may contain at most 4,096 styles. Style IDs and
nonces share another 8 MiB budget, with a 1 MiB limit per nonce. These native
limits do not set the transport's HTTP payload limit; enforce the transport's
own byte limit before loading a response.

## Local publishers

Wrap a locally executed native component with the same public factory on the
server and browser:

```ts
import { publisherBoundary } from 'octane';
import Widget from './Widget.tsrx';

export const PublisherWidget = publisherBoundary(Widget, {
  publisherKey: 'catalog',
});
```

The server export is also available from `octane/server`. The component keeps
its live parent contexts and scheduler while receiving private signal
ownership and IDs. Octane derives its document and stream identity from the
real parent bootstrap; callers pass only the component and `publisherKey`.

Local server output can hydrate without a document stream. Publisher HMR
requires the genuine native document bootstrap for that exact `Document` and
admission of the compiled component through Octane's compiler. A publisher
sidecar or a caller-supplied identity does not grant that authority. The server
stream build and the publisher's compiler generation are separate identities:
a compiler update cannot authorize frames from a new server document stream.

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
