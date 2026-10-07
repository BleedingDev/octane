import { describe, expect, it } from 'vitest';
import { act, createElement, hydrateRoot } from '../../src/index.js';
import * as Server from 'octane/server';
import { loadCompiledFixtureSource } from '../_server-fixture.js';

const leafSource = `
export function Leaf(props) @{
  <><section data-label={props.label}>{props.value as string}</section><hr /></>
}
`;
const appSource = `
import { Leaf } from './leaf';
export function App(props) @{
  <>@if(props.first) {<Leaf label="first" value="first" />}
    <Leaf label="second" value={props.value} />
    <Leaf label="third" value="third" /></>
}
`;
const expressionAppSource = `
import { createElement } from 'octane';
import { Leaf } from './leaf';
export function App(props) @{
  <>@if(props.first) {<Leaf label="first" value="first" />}
    {createElement(Leaf, { label: 'second', value: props.value })}
    {createElement(Leaf, { label: 'third', value: 'third' })}</>
}
`;
const singleLeafSource = `export function Leaf(props) @{ <section>{props.value as string}</section> }`;
const returnedSource = `import { Leaf } from './leaf';
export function App(props) { return <Leaf value={props.value} />; }`;
const nestedReturnSource = `import { Leaf } from './leaf';
function Inner(props) { return <Leaf value={props.value} />; }
function Middle(props) { return <Inner value={props.value} />; }
export function App(props) { return <Middle value={props.value} />; }`;

function fixture(
	mode: 'client' | 'server',
	dev: boolean,
	source = appSource,
	leafBody = leafSource,
) {
	const leaf = loadCompiledFixtureSource(leafBody, {
		id: '/all-component-root/Leaf.tsrx',
		mode,
		compileOptions: { dev },
	});
	return loadCompiledFixtureSource(source, {
		id: '/all-component-root/App.tsrx',
		mode,
		compileOptions: { dev },
		runtimeModules: { './leaf': leaf },
	}).App;
}

function expectServerNodes(container: Element, serverNodes: Element[]) {
	const actual = [...container.querySelectorAll('section, hr')];
	expect(actual).toHaveLength(serverNodes.length);
	actual.forEach((node, index) => expect(node).toBe(serverNodes[index]));
}

describe.each([appSource, expressionAppSource])('all-component fragment root', (source) => {
	describe.each([false, true])('dev=%s', (dev) => {
		const serverApp = fixture('server', dev, source);
		const clientApp = fixture('client', dev, source);

		it.each([false, true])('adopts every sibling after the first @if (first=%s)', async (first) => {
			const container = document.createElement('div');
			document.body.append(container);
			const props = { first, value: 'second' };
			container.innerHTML = Server.renderToString(serverApp, props).html;
			const serverNodes = [...container.querySelectorAll('section, hr')];
			const errors: unknown[] = [];
			const root = hydrateRoot(container, clientApp, props, {
				onRecoverableError: (error) => errors.push(error),
			});
			try {
				await act(() => {});
				expect(errors).toEqual([]);
				expectServerNodes(container, serverNodes);
				expect(container.textContent).toBe(first ? 'firstsecondthird' : 'secondthird');
				await act(() => root.render(clientApp, { first: false, value: 'updated' }));
				expect(container.querySelector('[data-label="first"]')).toBeNull();
				expect(container.querySelector('[data-label="second"]')).toBe(
					serverNodes.find((node) => node.getAttribute('data-label') === 'second'),
				);
				expect(container.querySelector('[data-label="third"]')).toBe(
					serverNodes.find((node) => node.getAttribute('data-label') === 'third'),
				);
				expect(container.textContent).toBe('updatedthird');
				expect(errors).toEqual([]);
			} finally {
				root.unmount();
				container.remove();
			}
		});

		it('still reports and removes a stale sibling after the complete root', async () => {
			const container = document.createElement('div');
			document.body.append(container);
			const props = { first: true, value: 'second' };
			container.innerHTML = `${Server.renderToString(serverApp, props).html}<aside>stale</aside>`;
			const serverNodes = [...container.querySelectorAll('section, hr')];
			const errors: unknown[] = [];
			const root = hydrateRoot(container, clientApp, props, {
				onRecoverableError: (error) => errors.push(error),
			});
			try {
				await act(() => {});
				expect(errors).toHaveLength(1);
				expect(container.querySelector('aside')).toBeNull();
				expectServerNodes(container, serverNodes);
			} finally {
				root.unmount();
				container.remove();
			}
		});
	});
});

describe.each([false, true])('root ownership guards (dev=%s)', (dev) => {
	it.each([returnedSource, nestedReturnSource])(
		'keeps an ordinary returned single-root component',
		async (source) => {
			const serverApp = fixture('server', dev, source, singleLeafSource);
			const clientApp = fixture('client', dev, source, singleLeafSource);
			const container = document.createElement('div');
			document.body.append(container);
			const props = { value: 'server' };
			container.innerHTML = `${Server.renderToString(serverApp, props).html}<aside>stale</aside>`;
			const serverNode = container.querySelector('section');
			const errors: unknown[] = [];
			const root = hydrateRoot(container, clientApp, props, {
				onRecoverableError: (error) => errors.push(error),
			});
			try {
				await act(() => {});
				expect(errors).toHaveLength(1);
				expect(container.querySelector('aside')).toBeNull();
				expect(container.querySelector('section')).toBe(serverNode);
				await act(() => root.render(clientApp, { value: 'updated' }));
				expect(container.querySelector('section')).toBe(serverNode);
				expect(container.textContent).toBe('updated');
			} finally {
				root.unmount();
				container.remove();
			}
		},
	);

	it('recovers a first bounded fragment without discarding later root siblings', async () => {
		const serverApp = fixture('server', dev);
		const clientApp = fixture('client', dev);
		const container = document.createElement('div');
		document.body.append(container);
		const props = { first: true, value: 'second' };
		container.innerHTML = Server.renderToString(serverApp, props).html;
		const stale = container.querySelector('[data-label="first"]')!;
		const wrong = document.createElement('article');
		wrong.textContent = 'stale first';
		stale.replaceWith(wrong);
		const siblings = [...container.querySelectorAll('section')];
		const errors: unknown[] = [];
		const root = hydrateRoot(container, clientApp, props, {
			onRecoverableError: (error) => errors.push(error),
		});
		try {
			await act(() => {});
			expect(errors).toHaveLength(1);
			expect(container.querySelector('article')).toBeNull();
			expect(container.querySelector('[data-label="second"]')).toBe(siblings[0]);
			expect(container.querySelector('[data-label="third"]')).toBe(siblings[1]);
			expect(container.textContent).toBe('firstsecondthird');
		} finally {
			root.unmount();
			container.remove();
		}
	});
});

it.each([false, true])('adopts a plain host descriptor root (stale tail=%s)', async (staleTail) => {
	const serverApp = (props: { value: string }) =>
		Server.createElement('section', { children: props.value });
	const clientApp = (props: { value: string }) =>
		createElement('section', { children: props.value });
	const container = document.createElement('div');
	document.body.append(container);
	const props = { value: 'server' };
	container.innerHTML = `${Server.renderToString(serverApp, props).html}${staleTail ? '<aside>stale</aside>' : ''}`;
	const serverNode = container.querySelector('section');
	const errors: unknown[] = [];
	const root = hydrateRoot(container, clientApp, props, {
		onRecoverableError: (error) => errors.push(error),
	});
	try {
		await act(() => {});
		expect(errors).toHaveLength(staleTail ? 1 : 0);
		expect(container.querySelector('aside')).toBeNull();
		expect(container.querySelector('section')).toBe(serverNode);
		await act(() => root.render(clientApp, { value: 'updated' }));
		expect(container.querySelector('section')).toBe(serverNode);
		expect(container.textContent).toBe('updated');
	} finally {
		root.unmount();
		container.remove();
	}
});
