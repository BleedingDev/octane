import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, flushSync, hydrateRoot } from '../../src/index.js';
import * as ServerRT from 'octane/server';
import { loadCompiledFixtureSource, loadServerFixture } from '../_server-fixture';

// A hookless component whose template has several roots, called where the
// server rendered another @if arm without a range for it, renders against the
// server nodes at the cursor in place. Nothing marks where its server content
// would end, so it adopts them only when every static root matches. Otherwise
// it is rebuilt on the client, and the mismatch is reported once. Both compiles
// render these calls through the lite component slot. The production runtime
// also checks the roots off the templates' source.

const FIXTURE = join(
	process.cwd(),
	'packages/octane/tests/hydration/_fixtures/in-place-fragment-component.tsrx',
);
const FILE = 'in-place-fragment-component.tsrx';
const SOURCE = readFileSync(FIXTURE, 'utf8');
const LINES = SOURCE.split('\n');

/** `FILE:line:column` of the first line reading exactly `text` in export `name`. */
function site(name: string, text: string): string {
	const from = LINES.findIndex((line) => line.startsWith(`export function ${name}(`));
	const index = LINES.findIndex((line, at) => at > from && line.trim() === text);
	if (from < 0 || index < 0) throw new Error(`fixture export ${name} has no line ${text}`);
	return `${FILE}:${index + 1}:${LINES[index].indexOf(text)}`;
}

/** Element and text markup, ignoring hydration comments. */
function markup(node: Element): string {
	const copy = node.cloneNode(true) as Element;
	const walker = document.createTreeWalker(copy, NodeFilter.SHOW_COMMENT);
	const comments: Node[] = [];
	while (walker.nextNode()) comments.push(walker.currentNode);
	for (const comment of comments) comment.parentNode!.removeChild(comment);
	return copy.innerHTML;
}

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
	vi.unstubAllEnvs();
	container.remove();
	errSpy.mockRestore();
});

const warnings = () =>
	errSpy.mock.calls
		.map((call: unknown[]) => String(call[0]))
		.filter((message: string) => message.includes('hydration mismatch'));

/** The server render's elements in the fixture's host, and the hydration's recoverable errors. */
async function hydrate(
	client: Record<string, any>,
	name: string,
	serverProps: Record<string, unknown>,
	clientProps: Record<string, unknown>,
): Promise<{ host: Element; serverNodes: Element[]; recoverable: string[] }> {
	container.innerHTML = ServerRT.renderToString(server[name], serverProps).html;
	const host = container.firstElementChild!;
	const serverNodes = [...host.children];
	const recoverable: string[] = [];
	root = hydrateRoot(container, client[name], clientProps, {
		onRecoverableError: (error: unknown) => recoverable.push((error as Error).message),
	});
	flushSync(() => {});
	// Recoverable reports are delivered after the hydration burst.
	await act(async () => {});
	return { host, serverNodes, recoverable };
}

describe.each([
	{ name: 'development compile', dev: true, runtime: 'development' },
	{ name: 'production compile', dev: false, runtime: 'development' },
	{ name: 'production compile and runtime', dev: false, runtime: 'production' },
])('hydrateRoot — a fragment component in place of another arm ($name)', ({ dev, runtime }) => {
	const client = dev ? clients.development : clients.production;
	// A production runtime reports the error code instead of the message.
	const STRUCTURAL =
		runtime === 'production'
			? /^Minified Octane error #51;/
			: /the mismatched subtree was rebuilt on the client/;

	beforeEach(() => {
		if (runtime === 'production') vi.stubEnv('NODE_ENV', 'production');
	});

	it.each([
		{
			server: 'ends before its second root',
			name: 'Short',
			props: {},
			call: '<Pair />',
			expected: '<i>',
			actual: 'the end of the parent block (fewer nodes than expected)',
			html: '<p>p</p><i>i</i><em>e</em>',
			off: '<p>p</p>',
		},
		{
			server: 'differs at its second root',
			name: 'Differs',
			props: {},
			call: '<Pair />',
			expected: '<i>',
			actual: '<b>',
			html: '<p>p</p><i>i</i><em>e</em>',
			off: '<p>p</p><b>b</b><em>e</em>',
		},
		{
			server: 'ends where its trailing hole starts',
			name: 'HoleShort',
			props: { x: 'h' },
			call: '<Holed x={props.x} />',
			expected: 'a comment',
			actual: 'the end of the parent block (fewer nodes than expected)',
			html: '<p>p</p>h',
			off: '<p>p</p>',
		},
	])(
		'rebuilds the fragment when the server arm $server',
		async ({ name, props, call, expected, actual, html, off }) => {
			const { host, recoverable } = await hydrate(
				client,
				name,
				{ ...props, on: false },
				{ ...props, on: true },
			);

			expect(markup(host)).toBe(html);
			expect(recoverable).toEqual([expect.stringMatching(STRUCTURAL)]);
			// The diagnostic names the call and the first root the server's arm does
			// not match. The call after it, at the end of the arm, does not report again.
			expect(warnings()).toEqual(
				dev
					? [
							`Octane hydration mismatch at ${site(name, call)}: the client expected a ` +
								`fragment with ${expected} after <p> but the server rendered ${actual}. ` +
								'The mismatched subtree was rebuilt on the client.',
						]
					: [],
			);

			// The rebuilt arm stays live in both directions.
			flushSync(() => root!.render(client[name], { ...props, on: false }));
			expect(markup(host)).toBe(off);
			flushSync(() => root!.render(client[name], { ...props, on: true }));
			expect(markup(host)).toBe(html);
		},
	);

	it('discards the server arm after the roots it adopts', async () => {
		const { host, serverNodes, recoverable } = await hydrate(
			client,
			'Longer',
			{ on: false },
			{ on: true },
		);

		expect(markup(host)).toBe('<p>p</p><i>i</i>');
		expect([...host.children]).toEqual(serverNodes.slice(0, 2));
		expect(recoverable).toEqual([expect.stringMatching(STRUCTURAL)]);
		expect(warnings()).toEqual(
			dev
				? [
						`Octane hydration mismatch at ${site('Longer', '@if (props.on) {')}: the client ` +
							'expected the end of the branch but the server rendered <b>. The mismatched ' +
							'subtree was rebuilt on the client.',
					]
				: [],
		);

		flushSync(() => root!.render(client.Longer, { on: false }));
		expect(markup(host)).toBe('<p>p</p><i>i</i><b>b</b>');
		flushSync(() => root!.render(client.Longer, { on: true }));
		expect(markup(host)).toBe('<p>p</p><i>i</i>');
	});

	it.each([
		{ name: 'Same', props: {}, html: '<p>p</p><i>i</i><em>e</em>' },
		{ name: 'HoleSame', props: { x: 'h' }, html: '<p>p</p>h' },
	])('adopts the server arm when every root matches ($name)', async ({ name, props, html }) => {
		// Each server arm renders the same markup as the client arm.
		const { host, serverNodes, recoverable } = await hydrate(
			client,
			name,
			{ ...props, on: false },
			{ ...props, on: true },
		);

		expect(markup(host)).toBe(html);
		expect([...host.children]).toEqual(serverNodes);
		expect(recoverable).toEqual([]);
		expect(warnings()).toEqual([]);

		flushSync(() => root!.render(client[name], { ...props, on: false }));
		expect(markup(host)).toBe(html);
		flushSync(() => root!.render(client[name], { ...props, on: true }));
		expect(markup(host)).toBe(html);
	});
});
