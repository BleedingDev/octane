import { expect, it } from 'vitest';
import * as Client from 'octane';
import { prerender } from '../../src/runtime.server.js';
import { createContext } from '../../src/universal-native.js';
import { loadCompiledFixtureSource } from '../_server-fixture.js';

const Theme = createContext({ title: 'default' });

// Keep the two compiler paths in separate files: descriptor construction in an
// earlier test can initialize the renderer bridge and hide first-use failures.
it.each([false, true])(
	'adopts a compiled renderer-local provider on its first DOM render, dev=%s',
	async (dev) => {
		const source = `import { useContext } from 'octane';
import { Theme } from './contexts';
function Reader() {
	const theme = useContext(Theme);
	return <section><input defaultValue="draft" /><span>{theme.title}</span></section>;
}
export function App() {
	return <Theme value={{ title: 'provided' }}><Reader /></Theme>;
}`;
		const options = {
			id: '/host/FirstProvider.tsx',
			compileOptions: { dev },
			runtimeModules: { './contexts': { Theme } },
		};
		const server = loadCompiledFixtureSource(source, { ...options, mode: 'server' });
		const client = loadCompiledFixtureSource(source, { ...options, mode: 'client' });
		const container = document.createElement('div');
		container.innerHTML = (await prerender(server['App'])).html;
		document.body.append(container);
		const section = container.querySelector('section')!;
		const input = container.querySelector('input')!;
		input.value = 'typed before hydration';
		const errors: unknown[] = [];
		let root: ReturnType<typeof Client.hydrateRoot> | undefined;
		try {
			await Client.act(() => {
				root = Client.hydrateRoot(
					container,
					client['App'],
					{},
					{
						onRecoverableError: (error) => errors.push(error),
						onUncaughtError: (error) => errors.push(error),
					},
				);
			});
			expect.soft(errors).toEqual([]);
			expect.soft(container.querySelector('section')).toBe(section);
			expect.soft(container.querySelector('input')).toBe(input);
			expect.soft(container.querySelector('input')?.value).toBe('typed before hydration');
			expect.soft(container.querySelector('span')?.textContent).toBe('provided');
		} finally {
			root?.unmount();
			container.remove();
		}
	},
);
