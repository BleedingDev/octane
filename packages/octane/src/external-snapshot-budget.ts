import { formatClientError } from './error-codes.client.generated.js';

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_STRINGS = 8 * 1024 * 1024;
const MAX_STRING = 1024 * 1024;

// Object entries add two arrays between native values. Tags and envelope fields
// have separate bounds so the wire representation preserves the authored limits.
const MAX_RAW_DEPTH = MAX_DEPTH * 3 + 8;
const MAX_RAW_NODES = MAX_NODES * 8 + 64;
const MAX_RAW_STRINGS = MAX_STRINGS + MAX_STRING + MAX_NODES * 32 + 64 * 1024;
const MAX_WIRE_LENGTH = (MAX_STRINGS + MAX_STRING) * 6 + MAX_NODES * 128 + 64 * 1024;

// Renderer output has its own budget; the authored request limits still apply
// independently to the echoed request inside this response.
const MAX_RESPONSE_BODY_STRINGS = 32 * 1024 * 1024;
const MAX_RESPONSE_METADATA_STRINGS = 8 * 1024 * 1024;
const MAX_RESPONSE_STYLES = 4096;

interface JSONBudget {
	readonly depth: number;
	readonly nodes: number;
	readonly strings: number;
	readonly string: number;
	readonly wire: number;
}

const REQUEST_JSON_BUDGET: JSONBudget = {
	depth: MAX_RAW_DEPTH,
	nodes: MAX_RAW_NODES,
	strings: MAX_RAW_STRINGS,
	string: MAX_STRING,
	wire: MAX_WIRE_LENGTH,
};

const RESPONSE_JSON_BUDGET: JSONBudget = {
	depth: MAX_RAW_DEPTH + 1,
	nodes: MAX_RAW_NODES + MAX_RESPONSE_STYLES * 7 + 16,
	strings:
		MAX_RAW_STRINGS +
		MAX_RESPONSE_BODY_STRINGS +
		MAX_RESPONSE_METADATA_STRINGS +
		MAX_RESPONSE_STYLES * 11 +
		64,
	string: MAX_RESPONSE_BODY_STRINGS,
	wire:
		MAX_WIRE_LENGTH +
		6 * (MAX_RESPONSE_BODY_STRINGS + MAX_RESPONSE_METADATA_STRINGS) +
		MAX_RESPONSE_STYLES * 128 +
		1024,
};

function invalid(): never {
	throw new TypeError(formatClientError(337));
}

function utf8Bytes(value: string, maximum = MAX_STRING): number {
	let bytes = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x80) bytes++;
		else if (code < 0x800) bytes += 2;
		else if (
			code >= 0xd800 &&
			code <= 0xdbff &&
			i + 1 < value.length &&
			value.charCodeAt(i + 1) >= 0xdc00 &&
			value.charCodeAt(i + 1) <= 0xdfff
		) {
			bytes += 4;
			i++;
		} else bytes += 3;
		if (bytes > maximum) invalid();
	}
	return bytes;
}

function delimiter(code: number): boolean {
	return (
		code === 0x20 ||
		code === 0x09 ||
		code === 0x0a ||
		code === 0x0d ||
		code === 0x2c ||
		code === 0x7d ||
		code === 0x5d
	);
}

/** Bound allocation and nesting before asking the native JSON parser for a tree. */
function admitJSON(wire: string, budget = REQUEST_JSON_BUDGET): unknown {
	if (wire.length > budget.wire) invalid();
	let depth = 0,
		nodes = 0,
		strings = 0;
	for (let i = 0; i < wire.length; i++) {
		const code = wire.charCodeAt(i);
		if (code === 0x7b || code === 0x5b) {
			if (++depth > budget.depth || ++nodes > budget.nodes) invalid();
		} else if (code === 0x7d || code === 0x5d) {
			if (--depth < 0) invalid();
		} else if (code === 0x22) {
			if (++nodes > budget.nodes) invalid();
			let bytes = 0,
				high = false,
				ended = false;
			while (++i < wire.length) {
				let character = wire.charCodeAt(i);
				if (character === 0x22) {
					ended = true;
					break;
				}
				if (character === 0x5c) {
					character = wire.charCodeAt(++i);
					if (character === 0x75) {
						const hex = wire.slice(i + 1, i + 5);
						if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid();
						character = Number.parseInt(hex, 16);
						i += 4;
					} else if (
						character !== 0x22 &&
						character !== 0x5c &&
						character !== 0x2f &&
						character !== 0x62 &&
						character !== 0x66 &&
						character !== 0x6e &&
						character !== 0x72 &&
						character !== 0x74
					)
						invalid();
				} else if (character < 0x20) invalid();
				if (high) {
					if (character >= 0xdc00 && character <= 0xdfff) {
						bytes += 4;
						high = false;
						if (bytes > budget.string) invalid();
						continue;
					}
					bytes += 3;
					high = false;
				}
				if (character >= 0xd800 && character <= 0xdbff) high = true;
				else bytes += character < 0x80 ? 1 : character < 0x800 ? 2 : 3;
				if (bytes > budget.string) invalid();
			}
			if (high) bytes += 3;
			if (!ended || bytes > budget.string || (strings += bytes) > budget.strings) invalid();
		} else if (code !== 0x3a && code !== 0x2c && !delimiter(code)) {
			if (++nodes > budget.nodes) invalid();
			while (i + 1 < wire.length && !delimiter(wire.charCodeAt(i + 1))) i++;
		}
	}
	if (depth !== 0) invalid();
	return JSON.parse(wire);
}

interface Captured {
	readonly array: boolean;
	readonly keys: readonly string[];
	readonly values: readonly unknown[];
}

/** Admit one complete encoded forest before copying or reconstructing values. */
export function snapshotExternalSnapshotRequest(value: unknown): unknown {
	const input = typeof value === 'string' ? admitJSON(value) : value;
	const captured = new Map<object, Captured>();
	const captureArray = (current: unknown, maximum: number): readonly unknown[] => {
		if (!Array.isArray(current)) invalid();
		const previous = captured.get(current);
		if (previous !== undefined) {
			if (previous.values.length > maximum) invalid();
			return previous.values;
		}
		const length = Object.getOwnPropertyDescriptor(current, 'length')?.value;
		if (!Number.isInteger(length) || length < 0 || length > maximum) invalid();
		if (Reflect.ownKeys(current).length !== length + 1) invalid();
		const values: unknown[] = [];
		for (let i = 0; i < length; i++) {
			const descriptor = Object.getOwnPropertyDescriptor(current, String(i));
			if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
			values.push(descriptor.value);
		}
		captured.set(current, { array: true, keys: [], values });
		return values;
	};
	const captureRecord = (current: unknown, allowed: readonly string[]): Captured => {
		if (current === null || typeof current !== 'object' || Array.isArray(current)) invalid();
		const previous = captured.get(current);
		if (previous !== undefined) {
			if (previous.keys.some((key) => !allowed.includes(key))) invalid();
			return previous;
		}
		const prototype = Object.getPrototypeOf(current);
		if (prototype !== Object.prototype && prototype !== null) invalid();
		const own = Reflect.ownKeys(current);
		if (
			own.length > allowed.length ||
			own.some((key) => typeof key !== 'string' || !allowed.includes(key))
		)
			invalid();
		const keys = (own as string[]).sort();
		const values = keys.map((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
			return descriptor.value;
		});
		const result = { array: false, keys, values };
		captured.set(current, result);
		return result;
	};
	const field = (record: Captured, key: string): unknown => record.values[record.keys.indexOf(key)];
	const key = (current: unknown): string => {
		if (typeof current !== 'string' || current.length === 0 || current.length > 1024) invalid();
		return current;
	};
	const request = captureRecord(input, [
		'version',
		'authority',
		'documentId',
		'boundaryId',
		'ownerKey',
		'identifierPrefix',
		'props',
		'contexts',
		'nonce',
	]);
	if (field(request, 'version') !== 1) invalid();
	const authority = captureRecord(field(request, 'authority'), ['publisherBuildId', 'runtimeABI']);
	key(field(authority, 'publisherBuildId'));
	if (field(authority, 'runtimeABI') !== 1) invalid();
	for (const name of ['documentId', 'boundaryId', 'ownerKey', 'identifierPrefix'])
		key(field(request, name));
	const nonce = field(request, 'nonce');
	if (nonce !== undefined) {
		if (typeof nonce !== 'string') invalid();
		utf8Bytes(nonce);
	}

	let nodes = 0,
		strings = 0;
	const string = (text: string) => {
		if ((strings += utf8Bytes(text)) > MAX_STRINGS) invalid();
	};
	type Work = { value: unknown; depth: number; exit?: boolean };
	const stack: Work[] = [];
	const schedule = (current: unknown, depth: number) => {
		if (depth > MAX_DEPTH || ++nodes > MAX_NODES) invalid();
		stack.push({ value: current, depth });
	};
	schedule(field(request, 'props'), 0);
	const contexts = captureArray(field(request, 'contexts'), MAX_NODES - nodes);
	for (const context of contexts) {
		const entry = captureRecord(context, ['key', 'value']);
		string(key(field(entry, 'key')));
		schedule(field(entry, 'value'), 0);
	}
	const ancestors = new Set<object>();
	while (stack.length > 0) {
		const work = stack.pop()!;
		if (work.exit) {
			ancestors.delete(work.value as object);
			continue;
		}
		const tuple = captureArray(work.value, 2);
		if (ancestors.has(work.value as object)) invalid();
		ancestors.add(work.value as object);
		stack.push({ ...work, exit: true });
		const tag = tuple[0];
		if (tag === 'undefined' || tag === 'null') {
			if (tuple.length !== 1) invalid();
			continue;
		}
		if (tuple.length !== 2) invalid();
		const item = tuple[1];
		switch (tag) {
			case 'boolean':
				if (typeof item !== 'boolean') invalid();
				break;
			case 'number':
				if (
					item !== '-0' &&
					(typeof item !== 'number' || !Number.isFinite(item) || Object.is(item, -0))
				)
					invalid();
				break;
			case 'string':
				if (typeof item !== 'string') invalid();
				string(item);
				break;
			case 'array': {
				const children = captureArray(item, MAX_NODES - nodes);
				for (let i = children.length - 1; i >= 0; i--) schedule(children[i], work.depth + 1);
				break;
			}
			case 'object': {
				const entries = captureArray(item, MAX_NODES - nodes);
				let previous: string | undefined;
				for (const entry of entries) {
					const pair = captureArray(entry, 2);
					const name = pair[0];
					if (
						pair.length !== 2 ||
						typeof name !== 'string' ||
						(previous !== undefined && name <= previous)
					)
						invalid();
					string(name);
					previous = name;
					schedule(pair[1], work.depth + 1);
				}
				break;
			}
			default:
				invalid();
		}
	}

	// Only captured descriptors participate in the copy. Caller getters,
	// iterators, toJSON methods and repeated property reads cannot change it.
	let rawNodes = 0;
	const copy = (current: unknown, depth: number): unknown => {
		if (depth > MAX_RAW_DEPTH || ++rawNodes > MAX_RAW_NODES) invalid();
		if (current === null || typeof current !== 'object') return current;
		const data = captured.get(current);
		if (data === undefined) invalid();
		if (data.array) return Object.freeze(data.values.map((item) => copy(item, depth + 1)));
		const object: Record<string, unknown> = {};
		for (let i = 0; i < data.keys.length; i++)
			Object.defineProperty(object, data.keys[i]!, {
				value: copy(data.values[i], depth + 1),
				enumerable: true,
			});
		return Object.freeze(object);
	};
	return copy(input, 1);
}

/** Admit the echoed request before copying any of its encoded tree. */
export function snapshotExternalSnapshotResponse(
	value: unknown,
	admitRequest: (request: unknown) => unknown,
): unknown {
	const input = typeof value === 'string' ? admitJSON(value, RESPONSE_JSON_BUDGET) : value;
	const captured = new Map<object, Captured>();
	const record = (current: unknown, allowed: readonly string[]): Captured => {
		if (current === null || typeof current !== 'object' || Array.isArray(current)) invalid();
		const previous = captured.get(current);
		if (previous !== undefined) {
			if (previous.keys.some((key) => !allowed.includes(key))) invalid();
			return previous;
		}
		const prototype = Object.getPrototypeOf(current);
		if (prototype !== Object.prototype && prototype !== null) invalid();
		const own = Reflect.ownKeys(current);
		if (
			own.length > allowed.length ||
			own.some((key) => typeof key !== 'string' || !allowed.includes(key))
		)
			invalid();
		const keys = own as string[];
		const values = keys.map((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
			return descriptor.value;
		});
		const result = { array: false, keys, values };
		captured.set(current, result);
		return result;
	};
	const field = (entry: Captured, name: string): unknown => entry.values[entry.keys.indexOf(name)];
	const envelope = record(input, ['version', 'request', 'html', 'styles', 'head']);
	if (field(envelope, 'version') !== 1) invalid();
	const request = admitRequest(field(envelope, 'request'));
	let bodyBytes = 0,
		metadataBytes = 0;
	const body = (current: unknown): string => {
		if (
			typeof current !== 'string' ||
			(bodyBytes += utf8Bytes(current, MAX_RESPONSE_BODY_STRINGS)) > MAX_RESPONSE_BODY_STRINGS
		)
			invalid();
		return current;
	};
	const metadata = (current: unknown): string => {
		if (
			typeof current !== 'string' ||
			(metadataBytes += utf8Bytes(current)) > MAX_RESPONSE_METADATA_STRINGS
		)
			invalid();
		return current;
	};
	const html = body(field(envelope, 'html'));
	const head = body(field(envelope, 'head'));
	const sourceStyles = field(envelope, 'styles');
	if (!Array.isArray(sourceStyles)) invalid();
	const length = Object.getOwnPropertyDescriptor(sourceStyles, 'length')?.value;
	if (!Number.isInteger(length) || length < 0 || length > MAX_RESPONSE_STYLES) invalid();
	if (Reflect.ownKeys(sourceStyles).length !== length + 1) invalid();
	const ids = new Set<string>();
	const styles: { readonly id: string; readonly css: string; readonly nonce?: string }[] = [];
	for (let i = 0; i < length; i++) {
		const descriptor = Object.getOwnPropertyDescriptor(sourceStyles, String(i));
		if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
		const style = record(descriptor.value, ['id', 'css', 'nonce']);
		const id = metadata(field(style, 'id'));
		if (id.length === 0 || id.length > 1024 || ids.has(id)) invalid();
		ids.add(id);
		const css = body(field(style, 'css'));
		const nonce = field(style, 'nonce');
		styles.push(
			Object.freeze({
				id,
				css,
				...(nonce === undefined ? {} : { nonce: metadata(nonce) }),
			}),
		);
	}
	return Object.freeze({ version: 1, request, html, styles: Object.freeze(styles), head });
}
