import { describe, expect, it, vi } from 'vitest';
import {
	createPublisherBoundaryDescriptor,
	decodePublisherBoundaryDescriptor,
	serializePublisherBoundaryDescriptor,
} from '../../src/publisher-boundary-protocol.js';

const descriptor = {
	version: 1,
	publisherKey: 'publisher',
	documentId: 'document',
	boundaryId: 'boundary',
	ownerKey: '["octane:publisher","document","publisher","boundary"]',
	identifierPrefix: 'boundary-publisher-',
	streamBuildId: 'build',
};

it('creates a frozen descriptor with the native publisher identity', () => {
	const created = createPublisherBoundaryDescriptor('publisher', 'document', 'boundary', 'build');
	expect(created).toEqual(descriptor);
	expect(Object.isFrozen(created)).toBe(true);
});

it('accepts exactly 1024 owner characters and rejects one more before creation', () => {
	const boundary = 'b'.repeat(992);
	const created = createPublisherBoundaryDescriptor('p', null, boundary, null);
	expect(created.ownerKey.length).toBe(1024);
	expect(() => createPublisherBoundaryDescriptor('p', null, boundary + 'b', null)).toThrow(
		TypeError,
	);
});

it('charges document and publisher keys together against the derived owner bound', () => {
	const created = createPublisherBoundaryDescriptor('p'.repeat(497), 'd'.repeat(497), 'b', null);
	expect(created.ownerKey.length).toBe(1024);
	expect(() =>
		createPublisherBoundaryDescriptor('p'.repeat(498), 'd'.repeat(497), 'b', null),
	).toThrow(TypeError);
});

it('counts JSON escaping when bounding owner and native root identities', () => {
	const created = createPublisherBoundaryDescriptor('p', null, '"'.repeat(496), null);
	expect(created.ownerKey.length).toBe(1024);
	expect(() => createPublisherBoundaryDescriptor('p', null, '"'.repeat(497), null)).toThrow(
		TypeError,
	);
	for (const boundary of ['b'.repeat(1003), 'b'.repeat(1014), '"'.repeat(502)])
		expect(() => createPublisherBoundaryDescriptor('p', null, boundary, null)).toThrow(TypeError);
});

describe.each(['object', 'JSON'] as const)('publisher descriptor admission through %s', (mode) => {
	const admit = (input: unknown) =>
		decodePublisherBoundaryDescriptor(mode === 'JSON' ? JSON.stringify(input) : input);

	it('accepts the exact owner bound and rejects over-bound derived fields', () => {
		const exact = createPublisherBoundaryDescriptor('p', null, 'b'.repeat(992), null);
		expect(admit(exact).ownerKey.length).toBe(1024);
		const boundary = 'b'.repeat(993);
		expect(() =>
			admit({
				...exact,
				boundaryId: boundary,
				ownerKey: '["octane:publisher",null,"p","' + boundary + '"]',
				identifierPrefix: boundary + '-publisher-',
			}),
		).toThrow(TypeError);
	});

	it('requires exact primitive fields and canonical identity', () => {
		for (const input of [
			{ ...descriptor, extra: true },
			{ ...descriptor, documentId: undefined },
			{ ...descriptor, streamBuildId: undefined },
			{ ...descriptor, publisherKey: '' },
			{ ...descriptor, streamBuildId: 'x'.repeat(1025) },
			{ ...descriptor, ownerKey: 'different' },
			{ ...descriptor, identifierPrefix: 'different' },
		])
			expect(() => admit(input)).toThrow(TypeError);
		expect(admit({ ...descriptor, streamBuildId: 'x'.repeat(1024) }).streamBuildId).toHaveLength(
			1024,
		);
	});
});

it('rejects getters, nonenumerable fields and symbols without invoking getters', () => {
	const getter = vi.fn(() => 'publisher');
	const input = { ...descriptor };
	Object.defineProperty(input, 'publisherKey', { enumerable: true, get: getter });
	expect(() => decodePublisherBoundaryDescriptor(input)).toThrow(TypeError);
	expect(getter).not.toHaveBeenCalled();
	const nonenumerable = { ...descriptor };
	Object.defineProperty(nonenumerable, 'streamBuildId', { value: 'build', enumerable: false });
	expect(() => decodePublisherBoundaryDescriptor(nonenumerable)).toThrow(TypeError);
	expect(() =>
		decodePublisherBoundaryDescriptor({ ...descriptor, [Symbol('extra')]: true }),
	).toThrow(TypeError);
});

it('returns an independent frozen copy and safely serializes an inline JSON sidecar', () => {
	const input = { ...descriptor };
	const admitted = decodePublisherBoundaryDescriptor(input);
	input.publisherKey = 'after';
	expect(admitted.publisherKey).toBe('publisher');
	expect(Object.isFrozen(admitted)).toBe(true);
	const unsafe = createPublisherBoundaryDescriptor('</script>', 'document', 'boundary', 'build');
	const wire = serializePublisherBoundaryDescriptor(unsafe);
	expect(wire).not.toContain('<');
	expect(decodePublisherBoundaryDescriptor(wire)).toEqual(unsafe);
});

it('rejects oversized JSON before native parsing', () => {
	const parse = vi.spyOn(JSON, 'parse');
	try {
		expect(() => decodePublisherBoundaryDescriptor(' '.repeat(64 * 1024 + 1))).toThrow(TypeError);
		expect(parse).not.toHaveBeenCalled();
	} finally {
		parse.mockRestore();
	}
});

it('rejects malformed JSON through the native protocol error', () => {
	expect(() => decodePublisherBoundaryDescriptor('{"version":1,}')).toThrow(TypeError);
});
