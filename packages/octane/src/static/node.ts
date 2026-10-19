import { prerender, type RenderOptions, type ServerRenderNode } from '../runtime.server.js';
import { formatServerError } from '../error-codes.server.generated.js';

declare const process: { env: { NODE_ENV?: string } };

/**
 * Stream variant of {@link prerender}, mirroring React's `prerenderToNodeStream`
 * semantics: the promise resolves only after the await-everything render fully
 * completes, and `prelude` is the transport for the COMPLETE document bytes —
 * the deduped scoped-style tags first, then the folded html (the order a
 * streamed shell serves). There is no `postponed` field: Octane has no
 * postpone/resume protocol (a documented non-goal). `node:stream` loads
 * lazily on call, so edge bundles that never invoke this pay nothing.
 * `headChannel: 'separate'` has no channel to land in here and is ignored
 * (the head folds), with a development diagnostic.
 */
export async function prerenderToNodeStream(
	entryComponent: ServerRenderNode,
	props?: any,
	options?: RenderOptions,
): Promise<{ prelude: import('node:stream').Readable }> {
	if (typeof entryComponent !== 'function' && options === undefined) {
		options = props;
		props = undefined;
	}
	let resolved = options;
	if (options?.headChannel === 'separate') {
		if (process.env.NODE_ENV !== 'production') {
			console.error(
				"prerenderToNodeStream() streams one document and has no separate head channel; headChannel: 'separate' was ignored. Use prerender() for a split head.",
			);
		}
		resolved = { ...options, headChannel: undefined };
	}
	const result = await prerender(entryComponent, props, resolved);
	// The server runtime must bundle for platform-neutral (edge) targets — see
	// ssr-production-bundle.test.ts — so the node-only dependency resolves at
	// RUNTIME through process.getBuiltinModule (a plain call no bundler follows,
	// evaluated only when this node-only API is actually invoked).
	const getBuiltin = (globalThis as any).process?.getBuiltinModule as
		((id: string) => any) | undefined;
	if (getBuiltin === undefined) throw new Error(formatServerError(57));
	const { Readable } = getBuiltin('node:stream');
	const chunks: Uint8Array[] = [];
	const encoder = new TextEncoder();
	if (result.css !== '') chunks.push(encoder.encode(result.css));
	chunks.push(encoder.encode(result.html));
	return { prelude: Readable.from(chunks, { objectMode: false }) };
}
