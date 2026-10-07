import { describe, expect, it } from 'vitest';
import { formatClientError } from '../../src/error-codes.client.generated.js';
import {
	getNativeStreamedAuthority,
	registerNativeStreamedAuthority,
	type NativeStreamedAuthority,
} from '../../src/hydration/native-streamed-authority.js';
import type { SignalOwnerIdentity } from '../../src/signals/types.js';

describe('native streamed authority', () => {
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
