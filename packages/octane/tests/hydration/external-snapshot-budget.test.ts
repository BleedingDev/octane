import { describe, expect, it, vi } from 'vitest';
import {
	createExternalSnapshotRequest,
	decodeExternalSnapshot,
	decodeExternalSnapshotRequest,
} from '../../src/external-snapshot-protocol.js';

const MiB = 1024 * 1024;
const request = createExternalSnapshotRequest(
	{ publisherBuildId: 'budget-publisher', runtimeABI: 1 },
	'budget-document',
	'boundary',
	null,
	[],
);
const response = { version: 1, request, html: '', styles: [], head: '' };

function nested(depth: number, tag: 'array' | 'object'): unknown {
	let value: unknown = ['null'];
	for (let i = 0; i < depth; i++)
		value = tag === 'array' ? ['array', [value]] : ['object', [['key', value]]];
	return value;
}

describe.each(['object', 'JSON'] as const)('external request limits through %s', (mode) => {
	const admit = (props: unknown, contexts: unknown[] = []) => {
		const input = { ...request, props, contexts };
		return decodeExternalSnapshotRequest(mode === 'JSON' ? JSON.stringify(input) : input);
	};

	it.each(['array', 'object'] as const)(
		'accepts depth 64 and rejects depth 65 for %s values',
		(tag) => {
			expect(admit(nested(64, tag)).props).toEqual(nested(64, tag));
			expect(() => admit(nested(65, tag))).toThrow(TypeError);
			expect(
				admit(['null'], [{ key: 'selected', value: nested(64, tag) }]).contexts[0]!.value,
			).toEqual(nested(64, tag));
			expect(() => admit(['null'], [{ key: 'selected', value: nested(65, tag) }])).toThrow(
				TypeError,
			);
		},
	);

	it('accepts exactly 100000 native values and rejects one more', () => {
		const values = Array.from({ length: 99999 }, () => ['null']);
		expect(admit(['array', values]).props).toEqual(['array', values]);
		expect(() => admit(['array', [...values, ['null']]])).toThrow(TypeError);
		expect(() => admit(['array', values], [{ key: 'selected', value: ['null'] }])).toThrow(
			TypeError,
		);
	});

	it('accepts eight MiB of authored strings without charging encoded tags', () => {
		const value = ['string', 'x'.repeat(MiB)];
		expect(admit(['array', Array(8).fill(value)]).props).toEqual(['array', Array(8).fill(value)]);
		expect(() => admit(['array', Array(9).fill(value)])).toThrow(TypeError);
	});

	it('shares the string budget across props, context values and object keys', () => {
		const value = ['string', 'x'.repeat(MiB)];
		const contexts = [
			{ key: 'selected', value: ['array', [value, value, value, ['string', 'x'.repeat(MiB - 8)]]] },
		];
		expect(admit(['array', Array(4).fill(value)], contexts).contexts).toEqual(contexts);
		expect(() => admit(['array', Array(5).fill(value)], contexts)).toThrow(TypeError);
		expect(() => admit(['object', [['x'.repeat(MiB), ['array', Array(8).fill(value)]]]])).toThrow(
			TypeError,
		);
	});

	it('counts UTF-8 bytes for individual strings and object keys', () => {
		const text = '\u00e9'.repeat(MiB / 2);
		expect(admit(['string', text]).props).toEqual(['string', text]);
		expect(() => admit(['string', text + '\u00e9'])).toThrow(TypeError);
		expect(() => admit(['object', [[text + '\u00e9', ['null']]]])).toThrow(TypeError);
	});

	it('counts surrogate pairs and lone surrogates by their UTF-8 encoding', () => {
		for (const [text, extra] of [
			['\ud83d\ude00'.repeat(MiB / 4), '\ud83d\ude00'],
			['\ud800'.repeat(Math.floor(MiB / 3)), '\ud800'],
		]) {
			expect(admit(['string', text]).props).toEqual(['string', text]);
			expect(() => admit(['string', text + extra])).toThrow(TypeError);
		}
	});

	it('validates tuple arity, finite numbers and sorted unique object keys', () => {
		for (const props of [
			['null', 1],
			['number', '-1'],
			[
				'object',
				[
					['b', ['null']],
					['a', ['null']],
				],
			],
			[
				'object',
				[
					['a', ['null']],
					['a', ['null']],
				],
			],
		])
			expect(() => admit(props)).toThrow();
		expect(admit(['number', '-0']).props).toEqual(['number', '-0']);
	});
});

it('rejects envelope and tuple getters without running them', () => {
	const getter = vi.fn(() => ['null']);
	const input = { ...request };
	Object.defineProperty(input, 'props', { enumerable: true, get: getter });
	expect(() => decodeExternalSnapshotRequest(input)).toThrow(TypeError);
	const tuple = ['string', 'safe'];
	Object.defineProperty(tuple, '1', { enumerable: true, get: getter });
	expect(() => decodeExternalSnapshotRequest({ ...request, props: tuple })).toThrow(TypeError);
	expect(getter).not.toHaveBeenCalled();
});

it('rejects cycles, sparse tuples and extra array properties', () => {
	const cyclic: unknown[] = ['array', []];
	(cyclic[1] as unknown[]).push(cyclic);
	const sparse = ['string', ,];
	const extra = Object.assign(['null'], { extra: true });
	for (const props of [cyclic, sparse, extra])
		expect(() => decodeExternalSnapshotRequest({ ...request, props })).toThrow(TypeError);
});

it('returns an immutable admitted copy rather than retaining caller data', () => {
	const input = { ...request, props: ['object', [['key', ['string', 'before']]]] };
	const admitted = decodeExternalSnapshotRequest(input);
	(input.props[1] as unknown[][])[0]![1] = ['string', 'after'];
	expect(admitted.props).toEqual(['object', [['key', ['string', 'before']]]]);
	expect(Object.isFrozen(admitted)).toBe(true);
	expect(Object.isFrozen(admitted.props)).toBe(true);
});

it('rejects oversized shallow JSON arrays before reconstructing the wire tree', () => {
	const wire = JSON.stringify(request).replace(
		'"props":["null"]',
		'"props":["array",[' + '["null"],'.repeat(400100) + '["null"]]]',
	);
	const parse = vi.spyOn(JSON, 'parse');
	try {
		expect(() => decodeExternalSnapshotRequest(wire)).toThrow(TypeError);
		expect(parse).not.toHaveBeenCalled();
	} finally {
		parse.mockRestore();
	}
});

it('allows escaped JSON strings and ignores structural characters inside them', () => {
	const text = 'x'.repeat(MiB);
	const wire = JSON.stringify({ ...request, props: ['string', text] });
	expect(decodeExternalSnapshotRequest(wire.replace(text, '\\u0078'.repeat(MiB))).props).toEqual([
		'string',
		text,
	]);
	const punctuation = '[{\\"}]'.repeat(1000);
	expect(
		decodeExternalSnapshotRequest(JSON.stringify({ ...request, props: ['string', punctuation] }))
			.props,
	).toEqual(['string', punctuation]);
});

it('rejects deeply nested echoed requests before recursive copying', () => {
	expect(() =>
		decodeExternalSnapshot({
			version: 1,
			request: { ...request, props: nested(6000, 'array') },
			html: '',
			styles: [],
			head: '',
		}),
	).toThrow(TypeError);
});

describe.each(['object', 'JSON'] as const)('external response limits through %s', (mode) => {
	const admit = (input: unknown) =>
		decodeExternalSnapshot(mode === 'JSON' ? JSON.stringify(input) : input);

	it('preserves the exact echoed request depth, value and string budgets', () => {
		for (const tag of ['array', 'object'] as const) {
			expect(
				admit({ ...response, request: { ...request, props: nested(64, tag) } }).request.props,
			).toEqual(nested(64, tag));
			expect(() => admit({ ...response, request: { ...request, props: nested(65, tag) } })).toThrow(
				TypeError,
			);
		}
		const values = Array.from({ length: 99999 }, () => ['null']);
		expect(
			admit({ ...response, request: { ...request, props: ['array', values] } }).request.props,
		).toEqual(['array', values]);
		expect(() =>
			admit({ ...response, request: { ...request, props: ['array', [...values, ['null']]] } }),
		).toThrow(TypeError);
		const text = ['string', 'x'.repeat(MiB)];
		expect(
			admit({ ...response, request: { ...request, props: ['array', Array(8).fill(text)] } }).request
				.props,
		).toEqual(['array', Array(8).fill(text)]);
		expect(() =>
			admit({ ...response, request: { ...request, props: ['array', Array(9).fill(text)] } }),
		).toThrow(TypeError);
		expect(() =>
			admit({ ...response, request: { ...request, props: ['string', 'x'.repeat(MiB + 1)] } }),
		).toThrow(TypeError);
	});

	it('allows individual bodies above one MiB and shares a separate 32 MiB content budget', () => {
		const text = 'x'.repeat(8 * MiB);
		const input = {
			...response,
			request: { ...request, props: ['array', Array(8).fill(['string', 'x'.repeat(MiB)])] },
			html: text + text,
			head: text,
			styles: [{ id: 'style', css: text }],
		};
		const admitted = admit(input);
		expect(admitted.html.length + admitted.head.length + admitted.styles[0]!.css.length).toBe(
			32 * MiB,
		);
		expect(() => admit({ ...input, head: text + 'x' })).toThrow(TypeError);
	});

	it('counts UTF-8 content bytes across HTML, head and CSS', () => {
		const html = '\u00e9'.repeat(8 * MiB);
		const css = '\ud83d\ude00'.repeat(4 * MiB);
		expect(admit({ ...response, html, styles: [{ id: 'unicode', css }] }).html).toBe(html);
		expect(() => admit({ ...response, html, head: 'x', styles: [{ id: 'unicode', css }] })).toThrow(
			TypeError,
		);
	});

	it('bounds style count and shares eight MiB of style IDs and nonces', () => {
		const styles = Array.from({ length: 4096 }, (_, i) => ({ id: `style-${i}`, css: '' }));
		expect(admit({ ...response, styles }).styles).toHaveLength(4096);
		expect(() => admit({ ...response, styles: [...styles, { id: 'excess', css: '' }] })).toThrow(
			TypeError,
		);
		const metadata = Array.from({ length: 8 }, (_, i) => ({
			id: `s${i}`,
			css: '',
			nonce: 'x'.repeat(i === 7 ? MiB - 16 : MiB),
		}));
		expect(admit({ ...response, styles: metadata }).styles).toHaveLength(8);
		expect(() =>
			admit({
				...response,
				styles: metadata.map((style, i) =>
					i === 7 ? { ...style, nonce: style.nonce + 'x' } : style,
				),
			}),
		).toThrow(TypeError);
		expect(() =>
			admit({ ...response, styles: [{ id: 'nonce', css: '', nonce: 'x'.repeat(MiB + 1) }] }),
		).toThrow(TypeError);
	});
});

it('rejects response, style and style-array getters without invoking them', () => {
	const getter = vi.fn(() => 'unsafe');
	const envelope = { ...response };
	Object.defineProperty(envelope, 'html', { enumerable: true, get: getter });
	expect(() => decodeExternalSnapshot(envelope)).toThrow(TypeError);
	const style = { id: 'style', css: '' };
	Object.defineProperty(style, 'css', { enumerable: true, get: getter });
	expect(() => decodeExternalSnapshot({ ...response, styles: [style] })).toThrow(TypeError);
	const styles = [{ id: 'style', css: '' }];
	Object.defineProperty(styles, '0', { enumerable: true, get: getter });
	expect(() => decodeExternalSnapshot({ ...response, styles })).toThrow(TypeError);
	expect(getter).not.toHaveBeenCalled();
});

it('rejects malformed response fields, duplicate style IDs and cyclic echoed requests', () => {
	const cyclic: unknown[] = ['array', []];
	(cyclic[1] as unknown[]).push(cyclic);
	for (const input of [
		{ ...response, request: { ...request, props: cyclic } },
		{ ...response, extra: true },
		{ ...response, styles: [{ id: 'style', css: '', extra: true }] },
		{ ...response, styles: [{ id: 'style' }] },
		{
			...response,
			styles: [
				{ id: 'style', css: '' },
				{ id: 'style', css: '' },
			],
		},
		{ ...response, styles: [,] },
		{ ...response, styles: Object.assign([], { extra: true }) },
	])
		expect(() => decodeExternalSnapshot(input)).toThrow(TypeError);
	const nonenumerable = { ...response };
	Object.defineProperty(nonenumerable, 'head', { value: '', enumerable: false });
	expect(() => decodeExternalSnapshot(nonenumerable)).toThrow(TypeError);
	expect(() => decodeExternalSnapshot({ ...response, [Symbol('extra')]: true })).toThrow(TypeError);
});

it('freezes admitted response styles and the echoed request without retaining caller records', () => {
	const input = {
		...response,
		request: { ...request, props: ['string', 'before'] },
		styles: [{ id: 'style', css: 'before' }],
	};
	const admitted = decodeExternalSnapshot(input);
	input.styles[0]!.css = 'after';
	input.request.props[1] = 'after';
	expect(admitted.styles[0]!.css).toBe('before');
	expect(admitted.request.props).toEqual(['string', 'before']);
	for (const value of [admitted, admitted.styles, admitted.styles[0], admitted.request])
		expect(Object.isFrozen(value)).toBe(true);
});

it('bounds response nesting and raw values before native JSON parsing', () => {
	const base = JSON.stringify(response);
	const wires = [
		base.replace(
			'"props":["null"]',
			'"props":' + '["array",['.repeat(6000) + '["null"]' + ']]'.repeat(6000),
		),
		base.replace(
			'"props":["null"]',
			'"props":["array",[' + '["null"],'.repeat(450000) + '["null"]]]',
		),
	];
	const parse = vi.spyOn(JSON, 'parse');
	try {
		for (const wire of wires) expect(() => decodeExternalSnapshot(wire)).toThrow(TypeError);
		expect(parse).not.toHaveBeenCalled();
	} finally {
		parse.mockRestore();
	}
});

it('admits escaped body strings above one MiB without treating their contents as structure', () => {
	const html = 'x'.repeat(2 * MiB);
	const wire = JSON.stringify({ ...response, html }).replace(html, '\\u0078'.repeat(2 * MiB));
	expect(decodeExternalSnapshot(wire).html).toBe(html);
	const punctuation = '[{\\"}]'.repeat(1000);
	expect(decodeExternalSnapshot(JSON.stringify({ ...response, html: punctuation })).html).toBe(
		punctuation,
	);
});
