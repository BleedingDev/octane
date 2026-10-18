import { bootstrapStreamedSignalHydration } from '../../src/hydration/streamed-signals.js';
import { createSignalOwnerLifecycle } from '../../src/signals/facade.js';
import { describe, expect, it } from 'vitest';
import { formatClientError } from '../../src/error-codes.client.generated.js';
import {
	getNativeStreamedAuthority,
	registerNativeStreamedAuthority,
	type NativeStreamedAuthority,
} from '../../src/hydration/native-streamed-authority.js';
import type { SignalOwnerIdentity } from '../../src/signals/types.js';

import { earlySignalBootstrapScript } from '../../src/server/early-signals.js';
import { __signalAt, runWithSignalOwner } from '../../src/signals/index.js';
import { SIGNAL_CONTROL_ATTR } from '../../src/hydration-markers.js';
import {
	publishHydrationControlSignalValues,
	readEarlySignalValue,
} from '../../src/signals/early-values.js';

describe('native streamed authority', () => {
	it('claims iframe inline input history and captures later edits without consuming parent controls', () => {
		const parentFrame = document.createElement('iframe');
		document.body.append(parentFrame);
		const parentDocument = parentFrame.contentDocument!;
		const iframe = parentDocument.createElement('iframe');
		parentDocument.body.append(iframe);
		const foreignDocument = iframe.contentDocument!;
		const view = foreignDocument.defaultView!;
		const target = view as unknown as Record<string, unknown>;
		const parentTarget = parentDocument.defaultView as unknown as Record<string, unknown>;
		const owner = { scopeKey: 'foreign-inline-controls' };
		const parentOwner = { scopeKey: owner.scopeKey };
		const makeInput = (ownerDocument: Document, nodeKey: string) => {
			const input = ownerDocument.createElement('input');
			input.setAttribute(
				SIGNAL_CONTROL_ATTR,
				JSON.stringify([1, owner.scopeKey, [['', nodeKey, 'value']]]),
			);
			input.value = 'server';
			ownerDocument.body.append(input);
			return input;
		};
		const queued = makeInput(foreignDocument, 'queued');
		const later = makeInput(foreignDocument, 'later');
		const parentInput = makeInput(parentDocument, 'queued');
		const script = earlySignalBootstrapScript().match(/<script[^>]*>([\s\S]*)<\/script>/)![1];
		new Function('globalThis', 'document', script)(target, foreignDocument);
		new Function('globalThis', 'document', script)(parentTarget, parentDocument);
		const edit = (input: HTMLInputElement, value: string) => {
			input.value = value;
			input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input', { bubbles: true }));
		};
		edit(queued, 'typed before activation');
		edit(parentInput, 'parent edit');
		const foreignQueue = (target.__octaneEarlySignalControls as { q: unknown[] }).q;
		const parentQueue = (parentTarget.__octaneEarlySignalControls as { q: unknown[] }).q;
		expect(foreignQueue).toHaveLength(1);
		expect(parentQueue).toHaveLength(1);
		const bridge = bootstrapStreamedSignalHydration({
			buildId: 'foreign-inline',
			documentId: 'foreign-inline',
			document: foreignDocument,
			signalOwner: owner,
		});
		let parentBridge: ReturnType<typeof bootstrapStreamedSignalHydration> | undefined;
		try {
			expect(foreignQueue).toHaveLength(0);
			expect(parentQueue).toHaveLength(1);
			expect(parentTarget.__octanePublishSignalControl).toBeUndefined();
			const queued$ = __signalAt('g:queued', 'server', { key: 'queued' });
			expect(runWithSignalOwner(owner, () => queued$.get())).toBe('typed before activation');
			edit(later, 'typed after bootstrap before hydrate');
			const later$ = __signalAt('g:later', 'server', { key: 'later' });
			expect(runWithSignalOwner(owner, () => later$.get())).toBe(
				'typed after bootstrap before hydrate',
			);
			parentBridge = bootstrapStreamedSignalHydration({
				buildId: 'parent-inline',
				documentId: 'parent-inline',
				document: parentDocument,
				signalOwner: parentOwner,
			});
			expect(parentQueue).toHaveLength(0);
			expect(runWithSignalOwner(parentOwner, () => queued$.get())).toBe('parent edit');
			expect(runWithSignalOwner(owner, () => queued$.get())).toBe('typed before activation');
		} finally {
			parentBridge?.dispose();
			bridge.dispose();
			parentFrame.remove();
		}
	});

	it('derives iframe signal ownership from the public target-only call', () => {
		const iframe = document.createElement('iframe');
		document.body.append(iframe);
		const ownerDocument = iframe.contentDocument!;
		const target = ownerDocument.defaultView as unknown as Record<string, unknown>;
		const script = earlySignalBootstrapScript().match(/<script[^>]*>([\s\S]*)<\/script>/)![1];
		new Function('globalThis', 'document', script)(target, ownerDocument);
		const bridge = bootstrapStreamedSignalHydration({
			buildId: 'target-only',
			documentId: 'target-only',
			target,
		});
		try {
			expect(getNativeStreamedAuthority(bridge.signalOwner, ownerDocument)?.document).toBe(
				ownerDocument,
			);
			expect(getNativeStreamedAuthority(bridge.signalOwner, document)).toBeUndefined();
		} finally {
			bridge.dispose();
			iframe.remove();
		}
	});

	it('rejects a document paired with another window before installing signal ingress', () => {
		const iframe = document.createElement('iframe');
		document.body.append(iframe);
		const foreignDocument = iframe.contentDocument!;
		const target = foreignDocument.defaultView as unknown as Record<string, unknown>;
		const script = earlySignalBootstrapScript().match(/<script[^>]*>([\s\S]*)<\/script>/)![1];
		new Function('globalThis', 'document', script)(target, foreignDocument);
		let bridge: ReturnType<typeof bootstrapStreamedSignalHydration> | undefined;
		try {
			expect(() => {
				bridge = bootstrapStreamedSignalHydration({
					buildId: 'mismatch',
					documentId: 'mismatch',
					target,
					document,
				});
			}).toThrow(TypeError);
		} finally {
			bridge?.dispose();
			iframe.remove();
		}
	});

	it('refuses an explicit viewless document without a transport target', () => {
		const foreignDocument = document.implementation.createHTMLDocument('No window');
		expect(() =>
			bootstrapStreamedSignalHydration({
				buildId: 'foreign',
				documentId: 'viewless',
				document: foreignDocument,
			}),
		).toThrow(TypeError);
	});

	it('associates default signal ownership and early edits with the explicit foreign document', () => {
		const foreignDocument = document.implementation.createHTMLDocument('Foreign signals');
		const target = {
			__octaneStreamedSignalSelections: { version: 1, identities: [], register() {} },
		};
		const foreign = bootstrapStreamedSignalHydration({
			buildId: 'foreign',
			documentId: 'foreign-input',
			document: foreignDocument,
			target,
		});
		const ambient = bootstrapStreamedSignalHydration({
			buildId: 'ambient',
			documentId: 'ambient-input',
			target: { __octaneStreamedSignalSelections: { version: 1, identities: [], register() {} } },
		});
		try {
			expect(foreign.signalOwner).not.toBe(ambient.signalOwner);
			for (const [ownerDocument, value] of [
				[document, 'ambient'],
				[foreignDocument, 'foreign'],
			] as const) {
				const input = ownerDocument.createElement('input');
				input.setAttribute(
					SIGNAL_CONTROL_ATTR,
					JSON.stringify([1, foreign.signalOwner.scopeKey, [['', 'draft', 'value']]]),
				);
				input.value = value;
				publishHydrationControlSignalValues(input, 1);
			}
			expect(
				readEarlySignalValue(foreign.signalOwner, { scope: 'document', nodeKey: 'draft' })?.value,
			).toBe('foreign');
			expect(getNativeStreamedAuthority(foreign.signalOwner, foreignDocument)?.document).toBe(
				foreignDocument,
			);
			expect(getNativeStreamedAuthority(foreign.signalOwner, document)).toBeUndefined();
		} finally {
			foreign.dispose();
			ambient.dispose();
		}
		expect(getNativeStreamedAuthority(foreign.signalOwner, foreignDocument)).toBeUndefined();
	});

	it('retains host identity when ingress freezes, and refuses it after owner retirement', () => {
		const owner = { scopeKey: 'native-authority-lifecycle' };
		const target = {
			__octaneStreamedSignalSelections: { version: 1, identities: [], register() {} },
			__octaneStreamedRenderer: { version: 1, frames: [], receive() {} },
		};
		const bridge = bootstrapStreamedSignalHydration({
			buildId: 'build',
			documentId: 'document',
			signalOwner: owner,
			target,
		});
		const lifecycle = createSignalOwnerLifecycle(owner);
		try {
			const authority = getNativeStreamedAuthority(owner, document);
			expect(authority).toEqual({
				buildId: 'build',
				documentId: 'document',
				ownerKey: owner.scopeKey,
				document,
			});
			lifecycle.freeze();
			bridge.suspend();
			expect(getNativeStreamedAuthority(owner, document)).toBe(authority);
			lifecycle.resume();
			expect(getNativeStreamedAuthority(owner, document)).toBe(authority);
			lifecycle.retire();
			expect(getNativeStreamedAuthority(owner, document)).toBeUndefined();
		} finally {
			bridge.dispose();
			lifecycle.retire();
		}
		expect(getNativeStreamedAuthority(owner, document)).toBeUndefined();
	});
	it('only exposes authority to its captured document', () => {
		const owner: SignalOwnerIdentity = { scopeKey: 'owner' };
		const authority = { buildId: 'build', documentId: 'document', ownerKey: 'owner' };
		const documentA = document.implementation.createHTMLDocument('Authority');
		const documentB = document.implementation.createHTMLDocument('Authority');
		const release = registerNativeStreamedAuthority(owner, authority, documentA);

		const captured = getNativeStreamedAuthority(owner, documentA);
		expect(captured).toEqual({ ...authority, document: documentA });
		expect(captured?.document).toBe(documentA);
		expect(Object.isFrozen(captured)).toBe(true);
		expect(getNativeStreamedAuthority(owner, documentB)).toBeUndefined();
		expect(getNativeStreamedAuthority(owner, document)).toBeUndefined();
		release();
		expect(getNativeStreamedAuthority(owner, documentA)).toBeUndefined();
	});

	it('rejects a conflicting document and keeps the original leases intact', () => {
		const owner: SignalOwnerIdentity = { scopeKey: 'owner' };
		const authority = { buildId: 'build', documentId: 'document', ownerKey: 'owner' };
		const documentA = document.implementation.createHTMLDocument('Authority');
		const documentB = document.implementation.createHTMLDocument('Authority');
		const releaseFirst = registerNativeStreamedAuthority(owner, authority, documentA);
		const releaseSecond = registerNativeStreamedAuthority(owner, { ...authority }, documentA);

		expect(() => registerNativeStreamedAuthority(owner, authority, documentB)).toThrow(Error);
		expect(() => registerNativeStreamedAuthority(owner, authority, documentB)).toThrow(
			formatClientError(124),
		);
		expect(getNativeStreamedAuthority(owner, documentA)).toEqual({
			...authority,
			document: documentA,
		});
		expect(getNativeStreamedAuthority(owner, documentA)?.document).toBe(documentA);
		expect(getNativeStreamedAuthority(owner, documentB)).toBeUndefined();
		releaseFirst();
		expect(getNativeStreamedAuthority(owner, documentA)).toEqual({
			...authority,
			document: documentA,
		});
		releaseSecond();
		expect(getNativeStreamedAuthority(owner, documentA)).toBeUndefined();
		expect(getNativeStreamedAuthority(owner, documentB)).toBeUndefined();

		const releaseFresh = registerNativeStreamedAuthority(owner, authority, documentB);
		releaseFirst();
		releaseSecond();
		expect(getNativeStreamedAuthority(owner, documentA)).toBeUndefined();
		expect(getNativeStreamedAuthority(owner, documentB)).toEqual({
			...authority,
			document: documentB,
		});
		expect(getNativeStreamedAuthority(owner, documentB)?.document).toBe(documentB);
		releaseFresh();
		expect(getNativeStreamedAuthority(owner, documentB)).toBeUndefined();
	});

	it('keeps authority separate for different owners at the same site', () => {
		const firstOwner: SignalOwnerIdentity = { scopeKey: 'owner' };
		const secondOwner: SignalOwnerIdentity = { scopeKey: 'owner' };
		const firstAuthority = { buildId: 'build-a', documentId: 'document-a', ownerKey: 'owner' };
		const secondAuthority = { buildId: 'build-b', documentId: 'document-b', ownerKey: 'owner' };

		expect(getNativeStreamedAuthority(firstOwner, document)).toBeUndefined();
		const releaseFirst = registerNativeStreamedAuthority(firstOwner, firstAuthority, document);
		expect(getNativeStreamedAuthority(secondOwner, document)).toBeUndefined();
		const releaseSecond = registerNativeStreamedAuthority(secondOwner, secondAuthority, document);

		expect(getNativeStreamedAuthority(firstOwner, document)).toEqual({
			...firstAuthority,
			document,
		});
		expect(getNativeStreamedAuthority(secondOwner, document)).toEqual({
			...secondAuthority,
			document,
		});
		releaseFirst();
		expect(getNativeStreamedAuthority(firstOwner, document)).toBeUndefined();
		expect(getNativeStreamedAuthority(secondOwner, document)).toEqual({
			...secondAuthority,
			document,
		});
		releaseSecond();
		expect(getNativeStreamedAuthority(secondOwner, document)).toBeUndefined();
	});

	it('captures immutable authority before the caller changes its input', () => {
		const owner: SignalOwnerIdentity = { scopeKey: 'owner' };
		const authority = { buildId: 'build', documentId: 'document', ownerKey: 'owner' };
		const release = registerNativeStreamedAuthority(owner, authority, document);
		const captured = getNativeStreamedAuthority(owner, document);

		expect(captured).not.toBe(authority);
		expect(captured?.document).toBe(document);
		expect(Object.isFrozen(captured)).toBe(true);
		authority.buildId = 'changed-build';
		authority.documentId = 'changed-document';
		authority.ownerKey = 'changed-owner';
		expect(getNativeStreamedAuthority(owner, document)).toEqual({
			buildId: 'build',
			documentId: 'document',
			ownerKey: 'owner',
			document,
		});
		release();
	});

	it('accepts build and document identifiers at the UTF-16 length limit', () => {
		const owner: SignalOwnerIdentity = { scopeKey: 'owner' };
		const authority = {
			buildId: '😀'.repeat(512),
			documentId: 'd'.repeat(1024),
			ownerKey: 'owner',
		};
		const release = registerNativeStreamedAuthority(owner, authority, document);

		expect(getNativeStreamedAuthority(owner, document)).toEqual({ ...authority, document });
		release();
	});

	describe.each(['buildId', 'documentId'] as const)('%s validation', (field) => {
		it.each([
			['empty', ''],
			['over the UTF-16 length limit', 'x'.repeat(1025)],
			['supplementary characters over the UTF-16 length limit', '😀'.repeat(513)],
			['undefined', undefined],
			['null', null],
			['a number', 1],
			['a boolean', true],
			['an object', {}],
		])('rejects %s without disturbing an existing lease', (_description, value) => {
			const owner: SignalOwnerIdentity = { scopeKey: 'owner' };
			const authority = { buildId: 'build', documentId: 'document', ownerKey: 'owner' };
			const release = registerNativeStreamedAuthority(owner, authority, document);
			const invalid = { ...authority, [field]: value } as Omit<NativeStreamedAuthority, 'document'>;

			expect(() => registerNativeStreamedAuthority(owner, invalid, document)).toThrow(TypeError);
			expect(() => registerNativeStreamedAuthority(owner, invalid, document)).toThrow(
				formatClientError(266),
			);
			expect(getNativeStreamedAuthority(owner, document)).toEqual({ ...authority, document });
			release();
			expect(getNativeStreamedAuthority(owner, document)).toBeUndefined();
		});
	});

	it.each([
		['empty', ''],
		['different from the owner scope', 'other-owner'],
		['undefined', undefined],
		['null', null],
		['a number', 1],
	])('rejects an owner key that is %s', (_description, value) => {
		const owner: SignalOwnerIdentity = { scopeKey: 'owner' };
		const invalid = {
			buildId: 'build',
			documentId: 'document',
			ownerKey: value,
		} as Omit<NativeStreamedAuthority, 'document'>;

		expect(() => registerNativeStreamedAuthority(owner, invalid, document)).toThrow(TypeError);
		expect(() => registerNativeStreamedAuthority(owner, invalid, document)).toThrow(
			formatClientError(266),
		);
		expect(getNativeStreamedAuthority(owner, document)).toBeUndefined();
	});

	it('rejects matching empty owner and authority keys', () => {
		const owner: SignalOwnerIdentity = { scopeKey: '' };
		const authority = { buildId: 'build', documentId: 'document', ownerKey: '' };

		expect(() => registerNativeStreamedAuthority(owner, authority, document)).toThrow(TypeError);
		expect(() => registerNativeStreamedAuthority(owner, authority, document)).toThrow(
			formatClientError(266),
		);
		expect(getNativeStreamedAuthority(owner, document)).toBeUndefined();
	});

	it.each(['first', 'second'])(
		'keeps matching authority until the last lease releases, %s first',
		(order) => {
			const owner: SignalOwnerIdentity = { scopeKey: 'owner' };
			const authority = { buildId: 'build', documentId: 'document', ownerKey: 'owner' };
			const releaseFirst = registerNativeStreamedAuthority(owner, authority, document);
			const releaseSecond = registerNativeStreamedAuthority(owner, { ...authority }, document);
			const releaseEarlier = order === 'first' ? releaseFirst : releaseSecond;
			const releaseLater = order === 'first' ? releaseSecond : releaseFirst;

			releaseEarlier();
			expect(getNativeStreamedAuthority(owner, document)).toEqual({ ...authority, document });
			releaseEarlier();
			expect(getNativeStreamedAuthority(owner, document)).toEqual({ ...authority, document });
			releaseLater();
			expect(getNativeStreamedAuthority(owner, document)).toBeUndefined();
			releaseLater();
			expect(getNativeStreamedAuthority(owner, document)).toBeUndefined();
		},
	);

	it.each(['matching', 'different'])(
		'ignores stale releases after a fresh %s registration',
		(kind) => {
			const owner: SignalOwnerIdentity = { scopeKey: 'owner' };
			const authority = { buildId: 'build', documentId: 'document', ownerKey: 'owner' };
			const releaseFirst = registerNativeStreamedAuthority(owner, authority, document);
			const releaseSecond = registerNativeStreamedAuthority(owner, { ...authority }, document);
			releaseFirst();
			releaseSecond();
			expect(getNativeStreamedAuthority(owner, document)).toBeUndefined();

			const fresh = {
				...authority,
				buildId: kind === 'matching' ? authority.buildId : 'fresh-build',
			};
			const releaseFresh = registerNativeStreamedAuthority(owner, fresh, document);
			releaseFirst();
			releaseSecond();
			expect(getNativeStreamedAuthority(owner, document)).toEqual({ ...fresh, document });
			releaseFresh();
			expect(getNativeStreamedAuthority(owner, document)).toBeUndefined();
		},
	);

	it.each(['buildId', 'documentId'] as const)(
		'rejects conflicting %s while preserving the original lease',
		(field) => {
			const owner: SignalOwnerIdentity = { scopeKey: 'owner' };
			const authority = { buildId: 'build', documentId: 'document', ownerKey: 'owner' };
			const release = registerNativeStreamedAuthority(owner, authority, document);
			const conflicting = { ...authority, [field]: 'conflicting' };

			expect(() => registerNativeStreamedAuthority(owner, conflicting, document)).toThrow(Error);
			expect(() => registerNativeStreamedAuthority(owner, conflicting, document)).toThrow(
				formatClientError(124),
			);
			expect(getNativeStreamedAuthority(owner, document)).toEqual({ ...authority, document });
			release();
			expect(getNativeStreamedAuthority(owner, document)).toBeUndefined();
			const releaseFresh = registerNativeStreamedAuthority(owner, conflicting, document);
			expect(getNativeStreamedAuthority(owner, document)).toEqual({ ...conflicting, document });
			releaseFresh();
		},
	);
});
