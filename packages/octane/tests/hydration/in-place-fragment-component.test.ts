import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, flushSync, hydrateRoot } from '../../src/index.js';
import * as ServerRT from 'octane/server';
import { loadCompiledFixtureSource, loadServerFixture } from '../_server-fixture';

// A hookless component call that finds no server range of its own, because the
// server rendered another @if arm there, renders its template against the
// server nodes at the cursor. When its body returns a fragment of several
// roots, it adopts as many server siblings in place, and hydration must
// continue after the last of them: the next component adopts its own server
// content instead of comparing against the fragment's first root, discarding
// it, and rebuilding. A call inside such a body that renders nothing leaves the
// server node to the body's later slots. Both compiles render these calls
// through the lite slot.

const FIXTURE = join(
	process.cwd(),
	'packages/octane/tests/hydration/_fixtures/in-place-fragment-component.tsrx',
);
const FILE = 'in-place-fragment-component.tsrx';
const SOURCE = readFileSync(FIXTURE, 'utf8');

/** Element and text markup, ignoring hydration comments. */
function markup(node: Element): string {
	const copy = node.cloneNode(true) as Element;
	const walker = document.createTreeWalker(copy, NodeFilter.SHOW_COMMENT);
	const comments: Node[] = [];
	while (walker.nextNode()) comments.push(walker.currentNode);
	for (const comment of comments) comment.parentNode!.removeChild(comment);
	return copy.innerHTML;
}

const STRUCTURAL = /the mismatched subtree was rebuilt on the client/;

const server = loadServerFixture(FIXTURE, { id: FILE });
const clients = {
	development: loadCompiledFixtureSource(SOURCE, {
		id: FILE,
		mode: 'client',
		compileOptions: { dev: true },
	}),
	production: loadCompiledFixtureSource(SOURCE, {
		id: FILE,
		mode: 'client',
		compileOptions: { dev: false },
	}),
};

let container: HTMLElement;
let root: ReturnType<typeof hydrateRoot> | null;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = null;
	errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	root?.unmount();
	container.remove();
	errSpy.mockRestore();
});

const warnings = () =>
	errSpy.mock.calls
		.map((call: unknown[]) => String(call[0]))
		.filter((message: string) => message.includes('hydration mismatch'));

/** The server render's nodes in the fixture's host, and the hydration's recoverable errors. */
async function hydrate(
	client: Record<string, any>,
	name: string,
): Promise<{ host: Element; serverNodes: Node[]; recoverable: string[] }> {
	container.innerHTML = ServerRT.renderToString(server[name], { on: false }).html;
	const host = container.firstElementChild!;
	const serverNodes = [...host.querySelectorAll('*')].flatMap((element) => [
		element,
		...element.childNodes,
	]);
	const recoverable: string[] = [];
	root = hydrateRoot(
		container,
		client[name],
		{ on: true },
		{
			onRecoverableError: (error: unknown) => recoverable.push((error as Error).message),
		},
	);
	flushSync(() => {});
	// Recoverable reports are delivered after the hydration burst.
	await act(async () => {});
	return { host, serverNodes, recoverable };
}

describe.each([
	{ name: 'development compile', dev: true },
	{ name: 'production compile', dev: false },
])('hydrateRoot — a component after a fragment adopted without a range ($name)', ({ dev }) => {
	const client = dev ? clients.development : clients.production;

	it.each([
		{ fragment: 'two element roots', name: 'PairArms', html: '<p>p</p><i>i</i><em>e</em>' },
		{ fragment: 'a text root', name: 'SpacedArms', html: '<p>p</p>p<i>i</i><em>e</em>' },
		{
			fragment: 'component calls of its own',
			name: 'WrapperArms',
			html: '<p>p</p><i>i</i><em>e</em><em>e</em>',
		},
		{
			fragment: 'an empty call and an arm',
			name: 'ShellArms',
			html: '<em>p</em><em>e</em>',
		},
	])('adopts every server node after a fragment of $fragment', async ({ name, html }) => {
		const { host, serverNodes, recoverable } = await hydrate(client, name);

		expect(markup(host)).toBe(html);
		expect(serverNodes.filter((node) => !node.isConnected)).toEqual([]);
		expect(recoverable).toEqual([]);
		expect(warnings()).toEqual([]);

		// The arm unmounts every root it adopted, and mounts them again.
		flushSync(() => root!.render(client[name], { on: false }));
		expect(markup(host)).toBe(html);
		flushSync(() => root!.render(client[name], { on: true }));
		expect(markup(host)).toBe(html);
	});

	it('rebuilds a fragment whose first root the server did not render', async () => {
		const { host, serverNodes, recoverable } = await hydrate(client, 'OtherArms');

		expect(markup(host)).toBe('<p>p</p><i>i</i><em>e</em>');
		expect(serverNodes[0].isConnected).toBe(false);
		expect(recoverable).toEqual([expect.stringMatching(STRUCTURAL)]);

		flushSync(() => root!.render(client.OtherArms, { on: false }));
		expect(markup(host)).toBe('<s>p</s><i>i</i><em>e</em>');
	});
});
