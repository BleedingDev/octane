// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { compile } from 'octane/compiler';

describe('hot component initialization order', () => {
	it.each([
		'export function Counter() @{ BODY }',
		'export default function Counter() @{ BODY }',
		'export function Counter() { return <p>{count$.get() as string}</p>; }',
	])('fences an early alias of a directly exported component: %s', (declaration) => {
		const source = `import { signal$ } from 'octane/signals';
const count$ = signal$(0);
const Initial = Counter;
${declaration.replace('BODY', '<p>{count$.get() as string}</p>')}`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeUndefined();
	});

	it('fences a component passed to authored code before initialization', () => {
		const source = `import { useSignal$ } from 'octane/signals/client';
import { capture } from './capture';
capture(Counter);
export function Counter() @{ const count$ = useSignal$(0); <p>{count$.get() as string}</p> }`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeUndefined();
	});

	it.each([
		'const Initial = (() => Counter)();',
		'const Initial = read(); function read() { return Counter; }',
	])('fences a component captured by module evaluation: %s', (capture) => {
		const source = `import { signal$ } from 'octane/signals';
const count$ = signal$(0);
${capture}
export function Counter() @{ <p>{count$.get() as string}</p> }`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeUndefined();
	});

	it.each([
		'[Symbol.toPrimitive]() { capture(Counter); return "x"; }',
		'toString() { return {}; }, valueOf() { capture(Counter); return "x"; }',
		'toString() { capture(Counter); return "x"; }',
	])('fences component capture during computed member key coercion: %s', (coercion) => {
		const source = `import { useSignal$ } from 'octane/signals/client';
import { capture } from './capture';
const key = { ${coercion} };
({})[key];
export function Counter() @{ const count$ = useSignal$(0); <p>{count$.get() as string}</p> }`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeUndefined();
	});

	it.each([
		'+key',
		'-key',
		'~key',
		'key + 0',
		'0 + key',
		'key - 0',
		'key * 1',
		'key / 1',
		'key % 2',
		'key ** 1',
		'key << 1',
		'key >> 1',
		'key >>> 1',
		'key & 1',
		'key | 1',
		'key ^ 1',
		'key < 1',
		'key <= 1',
		'key > 1',
		'key >= 1',
		'key == 0',
		'key != 0',
		'`${key}`',
		'key in {}',
		'key++',
		'--key',
		'key += 1',
		'key -= 1',
		'key *= 1',
		'key /= 1',
		'key %= 2',
		'key **= 1',
		'key <<= 1',
		'key >>= 1',
		'key >>>= 1',
		'key &= 1',
		'key |= 1',
		'key ^= 1',
	])('fences component capture during implicit coercion: %s', (expression) => {
		const source = `import { useSignal$ } from 'octane/signals/client';
import { capture } from './capture';
let key = { [Symbol.toPrimitive]() { capture(Counter); return 0; } };
${expression};
export function Counter() @{ const count$ = useSignal$(0); <p>{count$.get() as string}</p> }`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeUndefined();
	});

	it.each([
		'typeof key',
		'void key',
		'!key',
		'key === 0',
		'key !== 0',
		'key && 0',
		'key || 0',
		'key ?? 0',
		'key ? 0 : 1',
		'key &&= 0',
		'key ||= 0',
		'key ??= 0',
	])('admits object values used without implicit coercion: %s', (expression) => {
		const source = `import { useSignal$ } from 'octane/signals/client';
import { capture } from './capture';
let key = { [Symbol.toPrimitive]() { capture(Counter); return 0; } };
${expression};
export function Counter() @{ const count$ = useSignal$(0); <p>{count$.get() as string}</p> }`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeDefined();
	});

	it.each([
		"'x' in (() => { capture(Counter); return {}; })()",
		'(() => { capture(Counter); return {}; })() instanceof Object',
	])('fences captures while evaluating a noncoerced operator operand: %s', (expression) => {
		const source = `import { useSignal$ } from 'octane/signals/client';
import { capture } from './capture';
${expression};
export function Counter() @{ const count$ = useSignal$(0); <p>{count$.get() as string}</p> }`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeUndefined();
	});

	it('fences component capture by an instanceof predicate', () => {
		const source = `import { useSignal$ } from 'octane/signals/client';
import { capture } from './capture';
const predicate = { [Symbol.hasInstance]() { capture(Counter); return true; } };
({}) instanceof predicate;
export function Counter() @{ const count$ = useSignal$(0); <p>{count$.get() as string}</p> }`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeUndefined();
	});

	it.each([
		'[Symbol.toPrimitive]() { capture(Counter); return "node:path"; }',
		'toString() { capture(Counter); return "node:path"; }',
		'toString() { return {}; }, valueOf() { capture(Counter); return "node:path"; }',
	])('fences component capture during dynamic-import specifier coercion: %s', (coercion) => {
		const source = `import { useSignal$ } from 'octane/signals/client';
import { capture } from './capture';
const key = { ${coercion} };
import(key);
export function Counter() @{ const count$ = useSignal$(0); <p>{count$.get() as string}</p> }`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeUndefined();
	});

	it('fences component capture while evaluating dynamic-import options', () => {
		const source = `import { useSignal$ } from 'octane/signals/client';
import { capture } from './capture';
import("node:path", (() => { capture(Counter); return {}; })());
export function Counter() @{ const count$ = useSignal$(0); <p>{count$.get() as string}</p> }`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeUndefined();
	});

	it.each([
		'{ get with() { capture(Counter); throw new Error("stop"); } }',
		'{ with: { get type() { capture(Counter); throw new Error("stop"); } } }',
	])('fences component capture by dynamic-import option getters: %s', (options) => {
		const source = `import { useSignal$ } from 'octane/signals/client';
import { capture } from './capture';
import("node:path", ${options});
export function Counter() @{ const count$ = useSignal$(0); <p>{count$.get() as string}</p> }`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeUndefined();
	});

	it('admits dynamic-import specifier coercion deferred in an uncalled helper', () => {
		const source = `import { useSignal$ } from 'octane/signals/client';
import { capture } from './capture';
const key = { [Symbol.toPrimitive]() { capture(Counter); return "node:path"; } };
function load() { return import(key); }
export function Counter() @{ const count$ = useSignal$(0); <p>{count$.get() as string}</p> }`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeDefined();
	});

	it('admits later component references evaluated only when a component renders', () => {
		const source = `import { useSignal$ } from 'octane/signals/client';
export function App() @{ <Slot component={Counter} /> }
function Slot(props) @{ const Child = props.component; <Child /> }
export function Counter() @{ const count$ = useSignal$(0); <p>{count$.get() as string}</p> }`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeDefined();
	});

	it('admits an alias created after component initialization', () => {
		const source = `import { useSignal$ } from 'octane/signals/client';
export function Counter() @{ const count$ = useSignal$(0); <p>{count$.get() as string}</p> }
const Initial = Counter;
export function Host() @{ <Initial /> }`;
		expect(
			compile(source, '/src/Counter.tsrx', { hmr: 'webpack', dev: true }).hotSignalModule,
		).toBeDefined();
	});
});
