import { describe, expect, it, vi } from 'vitest';
import {
	installStreamedRendererGlobal,
	type StreamedRendererGlobal,
} from '../../src/hydration/stream-delivery.js';
import { bootstrapStreamedSignalResults } from '../../src/hydration/streamed-signals.js';
import { earlySignalBootstrapScript } from '../../src/server/early-signals.js';
import {
	createStreamedSignalInjection,
	streamedRendererFrameScript,
} from '../../src/server/streamed-signals.js';
import type {
	StreamFrameIdentity,
	StreamedRendererFrame,
} from '../../src/streamed-signals-protocol.js';

function identity(ownerKey: string, buildId = 'publisher'): StreamFrameIdentity {
	return {
		protocol: 1,
		buildId,
		documentId: 'host-document',
		ownerKey,
		instanceKey: 'view',
		nodeKey: 'data',
		selectionKey: 'selected',
		selectionGeneration: 0,
		attempt: 0,
	};
}
function frame(owner: StreamFrameIdentity): StreamedRendererFrame {
	return { identity: owner, channel: 'result', kind: 'complete', sequence: 0 };
}
function receiver() {
	return { receive: vi.fn(async () => 'accepted' as const), failSelection: vi.fn(() => true) };
}
function ingress(realm: Record<string, unknown>) {
	return realm.__octaneStreamedRenderer as StreamedRendererGlobal;
}

describe('streamed renderer authority leases', () => {
	it('reports the renderer mailbox diagnostic for malformed pre-client authority history', () => {
		const first = receiver();
		const realm = {
			__octaneStreamedRenderer: {
				version: 1,
				frames: [],
				authorities: ['not an authority tuple'],
				receive() {},
			},
		};
		expect(() =>
			installStreamedRendererGlobal(first, realm, { authority: identity('host') }),
		).toThrow(/pre-module streamed renderer mailbox overflowed|Minified Octane error #228/);
		expect(first.receive).not.toHaveBeenCalled();
	});

	it('reports the signal mailbox diagnostic for malformed pre-client authority history', () => {
		const realm = {
			__octaneStreamedSignalSelections: {
				version: 1,
				identities: [],
				authorities: ['not an authority tuple'],
				register() {},
			},
		};
		expect(() =>
			bootstrapStreamedSignalResults({
				buildId: 'publisher',
				documentId: 'host-document',
				signalOwner: { scopeKey: 'host' },
				target: realm,
			}),
		).toThrow(/pre-module streamed signal selection mailbox overflowed|Minified Octane error #268/);
	});

	it('routes publisher/document/owner frames to independent receivers in one realm', async () => {
		const realm = {};
		const first = receiver(),
			second = receiver();
		const firstIdentity = identity('one'),
			secondIdentity = identity('two', 'another-publisher');
		const removeFirst = installStreamedRendererGlobal(first, realm, { authority: firstIdentity });
		const removeSecond = installStreamedRendererGlobal(second, realm, {
			authority: secondIdentity,
		});
		try {
			ingress(realm).receive(frame(firstIdentity));
			ingress(realm).receive(frame(secondIdentity));
			await vi.waitFor(() => expect(second.receive).toHaveBeenCalledWith(frame(secondIdentity)));
			expect(first.receive).toHaveBeenCalledExactlyOnceWith(frame(firstIdentity));
			expect(second.receive).toHaveBeenCalledTimes(1);
		} finally {
			removeFirst();
			removeSecond();
		}
		expect(realm).not.toHaveProperty('__octaneStreamedRenderer');
	});

	it('rejects duplicate authority and exclusive ownership in either installation order', () => {
		const realm = {};
		const owner = identity('one');
		const remove = installStreamedRendererGlobal(receiver(), realm, { authority: owner });
		try {
			expect(() => installStreamedRendererGlobal(receiver(), realm, { authority: owner })).toThrow(
				/already installed/,
			);
			expect(() => installStreamedRendererGlobal(receiver(), realm)).toThrow(/already installed/);
		} finally {
			remove();
		}
		const exclusive = installStreamedRendererGlobal(receiver(), realm);
		try {
			expect(() => installStreamedRendererGlobal(receiver(), realm, { authority: owner })).toThrow(
				/already installed/,
			);
		} finally {
			exclusive();
		}
	});

	it('retains early frames for their unclaimed authority and drains only the matching lease', async () => {
		const firstIdentity = identity('one'),
			secondIdentity = identity('two');
		const realm = {
			__octaneStreamedRenderer: {
				version: 1,
				frames: [frame(firstIdentity), frame(secondIdentity)],
				receive() {},
			},
		};
		const first = receiver(),
			second = receiver();
		const removeFirst = installStreamedRendererGlobal(first, realm, { authority: firstIdentity });
		try {
			await vi.waitFor(() => expect(first.receive).toHaveBeenCalledTimes(1));
			expect(second.receive).not.toHaveBeenCalled();
			const removeSecond = installStreamedRendererGlobal(second, realm, {
				authority: secondIdentity,
			});
			try {
				await vi.waitFor(() =>
					expect(second.receive).toHaveBeenCalledExactlyOnceWith(frame(secondIdentity)),
				);
			} finally {
				removeSecond();
			}
		} finally {
			removeFirst();
		}
	});

	it('retires one lease without fencing its sibling and discards stale late frames', async () => {
		const realm = {};
		const firstIdentity = identity('one'),
			secondIdentity = identity('two');
		const first = receiver(),
			second = receiver();
		const removeFirst = installStreamedRendererGlobal(first, realm, { authority: firstIdentity });
		const removeSecond = installStreamedRendererGlobal(second, realm, {
			authority: secondIdentity,
		});
		try {
			removeFirst();
			removeFirst();
			ingress(realm).receive(frame(firstIdentity));
			ingress(realm).receive(frame(secondIdentity));
			await vi.waitFor(() => expect(second.receive).toHaveBeenCalledTimes(1));
			expect(first.receive).not.toHaveBeenCalled();
			expect(() =>
				installStreamedRendererGlobal(first, realm, { authority: firstIdentity }),
			).toThrow(/already installed/);
			expect(() => installStreamedRendererGlobal(receiver(), realm)).toThrow(/already installed/);
			ingress(realm).receive(frame(firstIdentity));
			await Promise.resolve();
			expect(first.receive).not.toHaveBeenCalled();
		} finally {
			removeSecond();
		}
	});

	it('retains bounded unclaimed publisher frames when the first lease is disposed before the next mounts', async () => {
		const realm = {};
		const remove = installStreamedRendererGlobal(receiver(), realm, { authority: identity('one') });
		const saved = ingress(realm);
		saved.receive(frame(identity('future')));
		remove();
		expect(ingress(realm)).toBe(saved);
		expect(() => installStreamedRendererGlobal(receiver(), realm)).toThrow(/already installed/);
		const next = receiver();
		const removeNext = installStreamedRendererGlobal(next, realm, {
			authority: identity('future'),
		});
		try {
			await vi.waitFor(() =>
				expect(next.receive).toHaveBeenCalledExactlyOnceWith(frame(identity('future'))),
			);
		} finally {
			removeNext();
		}
		expect(realm).not.toHaveProperty('__octaneStreamedRenderer');
		saved.receive(frame(identity('future')));
		expect(next.receive).toHaveBeenCalledTimes(1);
	});
	it('keeps queue overflow and disposal local to one authority', async () => {
		const realm = {};
		const firstIdentity = identity('one'),
			secondIdentity = identity('two');
		let finish!: () => void;
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const first = {
			receive: vi.fn(async () => {
				await blocked;
				return 'accepted' as const;
			}),
			failSelection: vi.fn(() => true),
		};
		const second = receiver();
		const removeFirst = installStreamedRendererGlobal(first, realm, {
			authority: firstIdentity,
			maxPendingFrames: 1,
		});
		const removeSecond = installStreamedRendererGlobal(second, realm, {
			authority: secondIdentity,
			maxPendingFrames: 1,
		});
		try {
			ingress(realm).receive(frame(firstIdentity));
			ingress(realm).receive(frame(firstIdentity));
			ingress(realm).receive(frame(secondIdentity));
			await vi.waitFor(() => expect(second.receive).toHaveBeenCalledTimes(1));
			expect(first.failSelection).toHaveBeenCalledWith(
				firstIdentity,
				expect.objectContaining({ code: 'overflow' }),
			);
			removeFirst();
			expect(second.failSelection).not.toHaveBeenCalled();
			finish();
		} finally {
			finish();
			removeFirst();
			removeSecond();
		}
	});

	it('fails closed when unclaimed valid frames exceed the bounded early mailbox', () => {
		const realm = {};
		const remove = installStreamedRendererGlobal(receiver(), realm, { authority: identity('one') });
		try {
			for (let count = 0; count < 513; count++) ingress(realm).receive(frame(identity('future')));
			expect(() =>
				installStreamedRendererGlobal(receiver(), realm, { authority: identity('future') }),
			).toThrow(/mailbox overflowed/);
		} finally {
			remove();
		}
	});

	it('refuses only the overflowing unclaimed renderer authority and preserves later joins', async () => {
		const realm = {};
		const first = receiver(),
			third = receiver();
		const removeFirst = installStreamedRendererGlobal(first, realm, { authority: identity('one') });
		let removeThird: (() => void) | undefined;
		try {
			for (let count = 0; count < 513; count++) ingress(realm).receive(frame(identity('overflow')));
			expect(() =>
				installStreamedRendererGlobal(receiver(), realm, { authority: identity('overflow') }),
			).toThrow(/mailbox overflowed/);
			removeThird = installStreamedRendererGlobal(third, realm, { authority: identity('three') });
			ingress(realm).receive(frame(identity('one')));
			ingress(realm).receive(frame(identity('three')));
			await vi.waitFor(() =>
				expect(third.receive).toHaveBeenCalledExactlyOnceWith(frame(identity('three'))),
			);
			expect(first.receive).toHaveBeenCalledExactlyOnceWith(frame(identity('one')));
			expect(() =>
				installStreamedRendererGlobal(receiver(), realm, { authority: identity('overflow') }),
			).toThrow(/mailbox overflowed/);
		} finally {
			removeThird?.();
			removeFirst();
		}
		// The failed authority stays refused even after every live lease is gone.
		expect(() =>
			installStreamedRendererGlobal(receiver(), realm, { authority: identity('overflow') }),
		).toThrow(/mailbox overflowed/);
	});

	it('keeps installed renderer delivery live when the bounded authority namespace is exhausted', async () => {
		const realm = {};
		const first = receiver();
		const remove = installStreamedRendererGlobal(first, realm, { authority: identity('one') });
		try {
			for (let count = 0; count < 513; count++)
				ingress(realm).receive(frame(identity(`unclaimed-${count}`)));
			expect(() =>
				installStreamedRendererGlobal(receiver(), realm, { authority: identity('unclaimed-512') }),
			).toThrow(/mailbox overflowed/);
			ingress(realm).receive(frame(identity('one')));
			await vi.waitFor(() =>
				expect(first.receive).toHaveBeenCalledExactlyOnceWith(frame(identity('one'))),
			);
		} finally {
			remove();
		}
	});

	it('refuses only the overflowing signal authority and preserves later result bootstraps', async () => {
		const early = { version: 1, identities: [] as unknown[], register(_candidate: unknown) {} };
		const realm = { __octaneStreamedSignalSelections: early };
		const bootstrap = (ownerKey: string) =>
			bootstrapStreamedSignalResults({
				buildId: 'publisher',
				documentId: 'host-document',
				signalOwner: { scopeKey: ownerKey },
				target: realm,
			});
		const first = bootstrap('one');
		let third: ReturnType<typeof bootstrap> | undefined;
		try {
			for (let count = 0; count < 256; count++) early.register(identity('overflow'));
			expect(() => early.register(identity('overflow'))).toThrow(/mailbox overflowed/);
			expect(() => bootstrap('overflow')).toThrow(/mailbox overflowed/);
			third = bootstrap('three');
			early.register(identity('one'));
			early.register(identity('three'));
			expect(
				await first.receiver.receive({
					identity: identity('one'),
					channel: 'result',
					kind: 'open',
					resource: 'stream',
					sequence: 0,
				}),
			).toBe('accepted');
			expect(
				await third.receiver.receive({
					identity: identity('three'),
					channel: 'result',
					kind: 'open',
					resource: 'stream',
					sequence: 0,
				}),
			).toBe('accepted');
			expect(() => bootstrap('overflow')).toThrow(/mailbox overflowed/);
		} finally {
			third?.dispose();
			first.dispose();
		}
		expect(() => bootstrap('overflow')).toThrow(/mailbox overflowed/);
	});

	it('keeps installed signal delivery live when the bounded authority namespace is exhausted', async () => {
		const early = { version: 1, identities: [] as unknown[], register(_candidate: unknown) {} };
		const realm = { __octaneStreamedSignalSelections: early };
		const bootstrap = (ownerKey: string) =>
			bootstrapStreamedSignalResults({
				buildId: 'publisher',
				documentId: 'host-document',
				signalOwner: { scopeKey: ownerKey },
				target: realm,
			});
		const first = bootstrap('one');
		try {
			for (let count = 0; count < 256; count++) early.register(identity(`unclaimed-${count}`));
			expect(() => early.register(identity('unclaimed-256'))).toThrow(/mailbox overflowed/);
			expect(() => bootstrap('unclaimed-256')).toThrow(/mailbox overflowed/);
			early.register(identity('one'));
			expect(
				await first.receiver.receive({
					identity: identity('one'),
					channel: 'result',
					kind: 'open',
					resource: 'stream',
					sequence: 0,
				}),
			).toBe('accepted');
		} finally {
			first.dispose();
		}
	});

	it('bounds retired renderer authorities and never renews an old tuple behind a live peer', async () => {
		const realm = {};
		const first = receiver();
		const removeFirst = installStreamedRendererGlobal(first, realm, {
			authority: identity('keeper'),
		});
		const old = receiver();
		try {
			for (let count = 0; count < 513; count++) {
				const remove = installStreamedRendererGlobal(old, realm, {
					authority: identity(`retired-${count}`),
				});
				remove();
			}
			expect(() =>
				installStreamedRendererGlobal(old, realm, { authority: identity('retired-0') }),
			).toThrow();
			expect(() =>
				installStreamedRendererGlobal(receiver(), realm, {
					authority: identity('after-exhaustion'),
				}),
			).toThrow(/mailbox overflowed/);
			ingress(realm).receive(frame(identity('retired-0')));
			ingress(realm).receive(frame(identity('retired-512')));
			ingress(realm).receive(frame(identity('keeper')));
			await vi.waitFor(() =>
				expect(first.receive).toHaveBeenCalledExactlyOnceWith(frame(identity('keeper'))),
			);
			expect(old.receive).not.toHaveBeenCalled();
		} finally {
			removeFirst();
		}
	});

	it('bounds retired signal authorities and refuses identical tuple renewal behind a live peer', async () => {
		const early = { version: 1, identities: [] as unknown[], register(_candidate: unknown) {} };
		const realm = { __octaneStreamedSignalSelections: early };
		const bootstrap = (ownerKey: string) =>
			bootstrapStreamedSignalResults({
				buildId: 'publisher',
				documentId: 'host-document',
				signalOwner: { scopeKey: ownerKey },
				target: realm,
			});
		const first = bootstrap('keeper');
		try {
			for (let count = 0; count < 257; count++) bootstrap(`retired-${count}`).dispose();
			expect(() => bootstrap('retired-0')).toThrow();
			expect(() => bootstrap('after-exhaustion')).toThrow(/mailbox overflowed/);
			early.register(identity('retired-0'));
			expect(() => early.register(identity('retired-256'))).toThrow(/mailbox overflowed/);
			expect(early.identities).toHaveLength(0);
			early.register(identity('keeper'));
			expect(
				await first.receiver.receive({
					identity: identity('keeper'),
					channel: 'result',
					kind: 'open',
					resource: 'stream',
					sequence: 0,
				}),
			).toBe('accepted');
		} finally {
			first.dispose();
		}
	});

	it('fences a saved signal ingress after final disposal before a new realm lease begins', () => {
		const early = { version: 1, identities: [] as unknown[], register(_candidate: unknown) {} };
		const realm = { __octaneStreamedSignalSelections: early };
		const bootstrap = () =>
			bootstrapStreamedSignalResults({
				buildId: 'publisher',
				documentId: 'host-document',
				signalOwner: { scopeKey: 'one' },
				target: realm,
			});
		const first = bootstrap();
		const saved = early.register;
		first.dispose();
		const next = bootstrap();
		try {
			saved(identity('late-old-mailbox'));
			expect(early.identities).toHaveLength(0);
		} finally {
			next.dispose();
		}
	});

	it('removes the default exclusive ingress and fences saved entrypoints on disposal', async () => {
		const realm = {};
		const selected = receiver();
		const remove = installStreamedRendererGlobal(selected, realm);
		const saved = ingress(realm);
		remove();
		remove();
		saved.receive(frame(identity('one')));
		await Promise.resolve();
		expect(selected.receive).not.toHaveBeenCalled();
		expect(realm).not.toHaveProperty('__octaneStreamedRenderer');
	});
});

describe('emitted pre-client authority mailboxes', () => {
	function runScript(html: string, realm: Record<string, unknown>, ownerDocument: Document) {
		const script = html.match(/<script[^>]*>([\s\S]*)<\/script>/)?.[1];
		expect(script).toBeDefined();
		new Function('globalThis', 'document', script!)(realm, ownerDocument);
	}
	function announce(owner: StreamFrameIdentity) {
		const injection = createStreamedSignalInjection(owner, Promise.resolve('complete'), {
			announceSelection: true,
		});
		void injection.done.catch(() => {});
		const script = injection.take();
		injection.cancel(new Error('announcement captured'));
		return script;
	}
	function authority(ownerKey: string): StreamFrameIdentity {
		return { ...identity('shared-owner', ownerKey), documentId: `${ownerKey}-document` };
	}

	it.each([
		['bootstrap', 'host-first'],
		['bootstrap', 'offender-first'],
		['announcement', 'host-first'],
		['announcement', 'offender-first'],
	])(
		'isolates renderer overflow before any lease using %s with %s arrival',
		async (initializer, order) => {
			const realm = {};
			const ownerDocument = document.implementation.createHTMLDocument('Pre-client renderer');
			const host = authority('host'),
				offender = authority('offender'),
				sibling = authority('sibling');
			runScript(
				initializer === 'bootstrap' ? earlySignalBootstrapScript() : announce(offender),
				realm,
				ownerDocument,
			);
			const emit = (owner: StreamFrameIdentity) =>
				runScript(streamedRendererFrameScript(frame(owner)), realm, ownerDocument);
			if (order === 'host-first') emit(host);
			for (let count = 0; count < 513; count++) emit(offender);
			if (order === 'offender-first') emit(host);
			emit(sibling);
			const first = receiver(),
				second = receiver();
			const removeFirst = installStreamedRendererGlobal(first, realm, { authority: host });
			let removeSecond: (() => void) | undefined;
			try {
				removeSecond = installStreamedRendererGlobal(second, realm, { authority: sibling });
				expect(() =>
					installStreamedRendererGlobal(receiver(), realm, { authority: offender }),
				).toThrow(/mailbox overflowed/);
				await vi.waitFor(() =>
					expect(second.receive).toHaveBeenCalledExactlyOnceWith(frame(sibling)),
				);
				expect(first.receive).toHaveBeenCalledExactlyOnceWith(frame(host));
			} finally {
				removeSecond?.();
				removeFirst();
			}
		},
	);

	it.each(['host-first', 'offender-first'])(
		'isolates emitted signal announcements before bootstrap with %s arrival',
		async (order) => {
			const realm = {};
			const ownerDocument = document.implementation.createHTMLDocument('Pre-client selections');
			const host = authority('host'),
				offender = authority('offender'),
				sibling = authority('sibling');
			if (order === 'host-first') runScript(announce(host), realm, ownerDocument);
			for (let count = 0; count < 257; count++) runScript(announce(offender), realm, ownerDocument);
			if (order === 'offender-first') runScript(announce(host), realm, ownerDocument);
			runScript(announce(sibling), realm, ownerDocument);
			for (const owner of [host, sibling])
				runScript(
					streamedRendererFrameScript({
						identity: owner,
						channel: 'result',
						kind: 'open',
						resource: 'stream',
						sequence: 0,
					}),
					realm,
					ownerDocument,
				);
			const bootstrap = (owner: StreamFrameIdentity) =>
				bootstrapStreamedSignalResults({
					buildId: owner.buildId,
					documentId: owner.documentId,
					signalOwner: { scopeKey: owner.ownerKey },
					target: realm,
				});
			const first = bootstrap(host);
			let second: ReturnType<typeof bootstrap> | undefined;
			try {
				second = bootstrap(sibling);
				expect(() => bootstrap(offender)).toThrow(/mailbox overflowed/);
				expect(await first.receiver.receive({ ...frame(host), sequence: 1 })).toBe('accepted');
				expect(await second.receiver.receive({ ...frame(sibling), sequence: 1 })).toBe('accepted');
			} finally {
				second?.dispose();
				first.dispose();
			}
		},
	);

	it('preserves previously admitted publishers through bounded pre-client cardinality exhaustion', async () => {
		const realm: Record<string, unknown> = {};
		const ownerDocument = document.implementation.createHTMLDocument('Pre-client exhaustion');
		const host = authority('host'),
			sibling = authority('sibling');
		for (const owner of [host, sibling]) {
			runScript(announce(owner), realm, ownerDocument);
			runScript(
				streamedRendererFrameScript({
					identity: owner,
					channel: 'result',
					kind: 'open',
					resource: 'stream',
					sequence: 0,
				}),
				realm,
				ownerDocument,
			);
		}
		for (let count = 0; count < 513; count++) {
			const owner = authority(`unclaimed-${count}`);
			if (count < 257) runScript(announce(owner), realm, ownerDocument);
			runScript(streamedRendererFrameScript(frame(owner)), realm, ownerDocument);
		}
		const selections = realm.__octaneStreamedSignalSelections as {
			identities: unknown[];
			authorities: string[];
			refused: string[];
			exhausted: boolean;
		};
		const frames = realm.__octaneStreamedRenderer as {
			frames: unknown[];
			authorities: string[];
			refused: string[];
			exhausted: boolean;
		};
		expect(selections.exhausted).toBe(true);
		expect(frames.exhausted).toBe(true);
		expect(selections.authorities.length).toBeLessThanOrEqual(256);
		expect(frames.authorities.length).toBeLessThanOrEqual(512);
		expect(selections.identities.length + selections.refused.length).toBeLessThanOrEqual(256);
		expect(frames.frames.length + frames.refused.length).toBeLessThanOrEqual(512);
		const bootstrap = (owner: StreamFrameIdentity) =>
			bootstrapStreamedSignalResults({
				buildId: owner.buildId,
				documentId: owner.documentId,
				signalOwner: { scopeKey: owner.ownerKey },
				target: realm,
			});
		const first = bootstrap(host);
		let second: ReturnType<typeof bootstrap> | undefined;
		try {
			second = bootstrap(sibling);
			expect(() => bootstrap(authority('unclaimed-512'))).toThrow(/mailbox overflowed/);
			expect(await first.receiver.receive({ ...frame(host), sequence: 1 })).toBe('accepted');
			expect(await second.receiver.receive({ ...frame(sibling), sequence: 1 })).toBe('accepted');
		} finally {
			second?.dispose();
			first.dispose();
		}
	});
});
