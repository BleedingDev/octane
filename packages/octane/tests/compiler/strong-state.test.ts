import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/compile.js';
import { slotHooks } from '../../src/compiler/slot-hooks.js';
import { compileToVolarMappings } from '../../src/compiler/volar.js';

const SNAPSHOT_MUTATION = 'OCTANE_STRONG_SNAPSHOT_MUTATION';
const RENDER_SNAPSHOT_MUTATION = 'OCTANE_STRONG_RENDER_SNAPSHOT_MUTATION';

const IMPORTS =
	"import { useState, useReducer, useLinkedState, useEffect, useRef, useSyncExternalStore, useOptimistic, useEffectEvent } from 'octane';";

function tsx(body: string, imports = IMPORTS, strong = false): string {
	return `/** @jsxImportSource octane */\n${strong ? '"use strong";\n' : ''}${imports}\n${body}`;
}

function strongCode(source: string, filename = '/src/App.tsx'): string | null {
	try {
		if (filename.endsWith('.ts') || filename.endsWith('.js')) {
			slotHooks(source, filename, { strong: true });
		} else {
			compile(source, filename, { strong: true });
		}
	} catch (error: any) {
		return error.code ?? String(error);
	}
	return null;
}

/** The first Strong error for `body`, after proving compatibility mode accepts it. */
function rejected(body: string, imports = IMPORTS): string | null {
	expect(() => compile(tsx(body, imports), '/src/App.tsx')).not.toThrow();
	const code = strongCode(tsx(body, imports));
	expect(strongCode(tsx(body, imports, true))).toBe(code);
	return code;
}

function volarDiagnostic(source: string, filename: string, code: string) {
	const result = compileToVolarMappings(source, filename);
	const diagnostic = result.diagnostics.find((item: any) => item.code === code);
	expect(diagnostic).toMatchObject({ code, severity: 'error', filename });
	expect(result.errors).toContainEqual(
		expect.objectContaining({ code, type: 'usage', fileName: filename }),
	);
	if (diagnostic === undefined) throw new Error(`missing ${code}`);
	return diagnostic;
}

function expectUnchangedOutput(source: string, filename: string): void {
	for (const mode of ['client', 'server'] as const) {
		const standard = compile(source, filename, { mode });
		const strong = compile(source, filename, { mode, strong: true });
		expect(strong.diagnostics).toEqual(standard.diagnostics);
		expect(strong.code).toBe(standard.code);
	}
}

it('does not mistake receivers named after Object.prototype members for known globals', () => {
	expect(
		strongCode(
			tsx(`export function A({ value }) {
  const [items, setItems] = useState([]);
  return (
    <b onClick={() => { toString.call(items); hasOwnProperty.call(items, 'length'); setItems([...items]); }}>
      {items.length}
      {String(value)}
    </b>
  );
}`),
		),
	).toBeNull();
});

describe('Strong state mutation outside render', () => {
	it.each([
		[
			'a pushed array passed back to its setter',
			`export function A() { const [items, setItems] = useState([]); return <button onClick={() => { items.push(1); setItems(items); }}>{items.length}</button>; }`,
		],
		[
			'a nested array before a spread copy',
			`export function A() { const [s, setS] = useState({ list: [] }); return <button onClick={() => { s.list.push(1); setS({ ...s }); }}>{s.list.length}</button>; }`,
		],
		[
			'a nested array in an effect',
			`export function A() { const [s] = useState({ list: [] }); useEffect(() => { s.list.push(1); }); return <p>{s.list.length}</p>; }`,
		],
		[
			'a property assignment',
			`export function A() { const [s, setS] = useState({ count: 0 }); return <b onClick={() => { s.count = 1; setS({ ...s }); }}>{s.count}</b>; }`,
		],
		[
			'an update expression',
			`export function A() { const [s, setS] = useState({ count: 0 }); return <b onClick={() => { s.count++; setS({ ...s }); }}>{s.count}</b>; }`,
		],
		[
			'a deletion',
			`export function A() { const [s, setS] = useState({ count: 0 }); return <b onClick={() => { delete s.count; setS({ ...s }); }}>{s.count}</b>; }`,
		],
		[
			'a destructuring assignment target',
			`export function A() { const [s, setS] = useState({ count: 0 }); return <b onClick={() => { [s.count] = [1]; setS({ ...s }); }}>{s.count}</b>; }`,
		],
		[
			'Object.assign',
			`export function A() { const [s, setS] = useState({ count: 0 }); return <b onClick={() => { Object.assign(s, { count: 1 }); setS({ ...s }); }}>{s.count}</b>; }`,
		],
		[
			'a Map set',
			`export function A() { const [m, setM] = useState(new Map()); return <b onClick={() => { m.set(1, 2); setM(new Map(m)); }}>{m.size}</b>; }`,
		],
		[
			'a lazily created Set',
			`export function A() { const [m, setM] = useState(() => new Set()); return <b onClick={() => { m.add(1); setM(new Set(m)); }}>{m.size}</b>; }`,
		],
		[
			'an array length reset in effect cleanup',
			`export function A() { const [items, setItems] = useState([]); useEffect(() => () => { items.length = 0; }); return <b onClick={() => setItems([1])}>{items.length}</b>; }`,
		],
		[
			'a timer callback',
			`export function A() { const [items] = useState([]); useEffect(() => { const id = setTimeout(() => items.push(1)); return () => clearTimeout(id); }); return <b>{items.length}</b>; }`,
		],
		[
			'reducer state initialized as an array',
			`export function A() { const [s, d] = useReducer((s, a) => [...s, a], []); return <b onClick={() => { s.push(1); d(2); }}>{s.length}</b>; }`,
		],
		[
			'a tuple index',
			`export function A() { const tuple = useState([]); return <b onClick={() => { tuple[0].push(1); tuple[1]([...tuple[0]]); }}>{tuple[0].length}</b>; }`,
		],
		[
			'a tuple passed to a helper',
			`function add(pair) { pair[0].push(1); } export function A() { const tuple = useState([]); return <b onClick={() => { add(tuple); tuple[1]([...tuple[0]]); }}>{tuple[0].length}</b>; }`,
		],
		[
			'an Effect Event called with the state',
			`export function A() { const [items, setItems] = useState([]); const add = useEffectEvent((list) => { list.push(1); }); return <b onClick={() => { add(items); setItems([...items]); }}>{items.length}</b>; }`,
		],
		[
			'a helper parameter with a default',
			`function add(list = []) { list.push(1); return list; } export function A() { const [items, setItems] = useState([]); return <b onClick={() => setItems([...add(items)])}>{items.length}</b>; }`,
		],
		[
			'a destructured helper parameter with a default',
			`function add({ list } = { list: [] }) { list.push(1); } export function A() { const [s, setS] = useState({ list: [] }); return <b onClick={() => { add(s); setS({ ...s }); }}>{s.list.length}</b>; }`,
		],
		[
			'a linked-state array',
			`export function A(props) { const [items, setItems] = useLinkedState(props.id, () => []); return <b onClick={() => { items.push(1); setItems([...items]); }}>{items.length}</b>; }`,
		],
	])('rejects %s', (_label, body) => {
		expect(rejected(body)).toBe(SNAPSHOT_MUTATION);
	});

	// The likely rewrites after `items.push` is rejected keep the same object.
	it.each([
		[
			'a local alias',
			`export function A() { const [items, setItems] = useState([]); return <b onClick={() => { const list = items; list.push(1); setItems([...list]); }}>{items.length}</b>; }`,
		],
		[
			'a destructured property',
			`export function A() { const [s, setS] = useState({ list: [] }); return <b onClick={() => { const { list } = s; list.push(1); setS({ ...s, list }); }}>{s.list.length}</b>; }`,
		],
		[
			'a member alias',
			`export function A() { const [s, setS] = useState({ list: [] }); return <b onClick={() => { const list = s.list; list.push(1); setS({ ...s, list }); }}>{s.list.length}</b>; }`,
		],
		[
			'a helper that returns the mutated argument',
			`function add(list, item) { list.push(item); return list; } export function A() { const [items, setItems] = useState([]); return <b onClick={() => setItems([...add(items, 1)])}>{items.length}</b>; }`,
		],
		[
			'an optional call',
			`export function A() { const [items, setItems] = useState([]); return <b onClick={() => { items?.push(1); setItems([...items]); }}>{items.length}</b>; }`,
		],
		[
			'an optional member chain',
			`export function A() { const [s, setS] = useState({ list: [] }); return <b onClick={() => { s?.list.push(1); setS({ ...s }); }}>{s.list.length}</b>; }`,
		],
		[
			'Object.assign before a spread',
			`export function A() { const [s, setS] = useState({ list: [] }); return <b onClick={() => { Object.assign(s, { list: [...s.list, 1] }); setS({ ...s }); }}>{s.list.length}</b>; }`,
		],
	])('rejects the rewrite through %s', (_label, body) => {
		expect(rejected(body)).toBe(SNAPSHOT_MUTATION);
	});

	it.each([
		["import { useState as useCell, useEffect } from 'octane';", 'useCell'],
		["import * as Octane from 'octane'; const { useEffect } = Octane;", 'Octane.useState'],
	])('recognizes %s', (imports, hook) => {
		const body = `export function A() { const [items, setItems] = ${hook}([]); return <b onClick={() => { items.push(1); setItems(items); }}>{items.length}</b>; }`;
		expect(rejected(body, imports)).toBe(SNAPSHOT_MUTATION);
	});

	it('keeps render-time mutations on the render diagnostic, including nested arrays and collections', () => {
		expect(
			rejected(
				`export function A() { const [s] = useState({ list: [] }); s.list.push(1); return <b>{s.list.length}</b>; }`,
			),
		).toBe(RENDER_SNAPSHOT_MUTATION);
		expect(
			rejected(
				`export function A() { const [m] = useState(new Map()); m.clear(); return <b>{m.size}</b>; }`,
			),
		).toBe(RENDER_SNAPSHOT_MUTATION);
		expect(
			rejected(
				`export function A() { const [s] = useState({ n: 0 }); Object.assign(s, { n: 1 }); return <b>{s.n}</b>; }`,
			),
		).toBe(RENDER_SNAPSHOT_MUTATION);
	});

	it('keeps copies, refs, props, object methods, and shadowed globals legal', () => {
		expect(
			strongCode(
				tsx(`export function A(props) {
  const [items, setItems] = useState([]);
  const [m, setM] = useState(new Map());
  const [s, setS] = useState({ list: [], sort() { return 1; }, set() { return 2; } });
  const ref = useRef([]);
  return (
    <b
      onClick={() => {
        const copy = [...items];
        copy.push(1);
        setItems(copy);
        setItems(items.slice().sort());
        setM(new Map(m).set(1, 2));
        setS(Object.assign({}, s, { list: [...s.list, 1] }));
        s.sort();
        s.set();
        ref.current.push(1);
        props.list.push(1);
        { const Object = { assign() {} }; Object.assign(items, {}); }
        { const useState = (value) => [value, () => {}]; const [local] = useState([]); local.push(1); }
      }}
    >
      {items.length}
      {m.size}
      {s.list.length}
    </b>
  );
}`),
			),
		).toBeNull();
	});

	it('checks .tsrx components and plain .ts custom hooks', () => {
		const tsrx = `"use strong";
import { useState } from 'octane';
export function A() @{
  const [items, setItems] = useState([]);
  <button onClick={() => { items.push(1); setItems(items); }}>{items.length as string}</button>
}`;
		const hook = `"use strong";
import { useState } from 'octane';
export function useList() {
  const [items, setItems] = useState([]);
  return [items, (item) => { items.push(item); setItems([...items]); }];
}`;
		expect(strongCode(tsrx, '/src/A.tsrx')).toBe(SNAPSHOT_MUTATION);
		expect(() => slotHooks(hook, '/src/useList.ts')).toThrow(SNAPSHOT_MUTATION);
		expect(() => slotHooks(hook.replace('"use strong";\n', ''), '/src/useList.ts')).not.toThrow();
	});

	it('locates the mutation and names the replacement', () => {
		const source = tsx(
			`export function A() { const [items, setItems] = useState([]); return <button onClick={() => { items.push(1); setItems(items); }}>{items.length}</button>; }`,
			IMPORTS,
			true,
		);
		const diagnostic = volarDiagnostic(source, '/src/App.tsx', SNAPSHOT_MUTATION);
		expect(diagnostic.start.offset).toBe(source.indexOf('items.push'));
		expect(diagnostic.end.offset).toBe(source.indexOf('items.push') + 'items.push'.length);
		expect(diagnostic.message).toContain('setItems((current) => [...current, item])');
		expect(diagnostic.message).toContain('useRef');
	});

	it('preserves emitted client and server code for immutable updates', () => {
		expectUnchangedOutput(
			tsx(`export function A() {
  const [items, setItems] = useState([]);
  return <b onClick={() => { setItems([...items, 1]); setItems((current) => current.concat(2)); }}>{items.length}</b>;
}`),
			'/src/App.tsx',
		);
	});
});
