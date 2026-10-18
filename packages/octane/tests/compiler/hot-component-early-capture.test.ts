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
