import { expect, it } from 'vitest';
import { createContext } from '../src/universal-native.js';
import { mount } from './_helpers';
import { loadCompiledFixtureSource } from './_server-fixture';

it.each([false, true])(
	'provides a renderer-local context created after its DOM root, dev=%s',
	(dev) => {
		const { App } = loadCompiledFixtureSource(
			`import { useContext, useState } from 'octane';
function Reader(props) @{
	const value = useContext(props.context);
	const [count, setCount] = useState(0);
	<button onClick={() => setCount(count + 1)}>{value + ':' + count as string}</button>
}
export function App(props) @{
	const Provider = props.context;
	<main>@if (Provider) { <Provider value={props.value}><Reader context={Provider} /></Provider> } @else { <p>waiting</p> }</main>
}`,
			{
				id: '/host/LateRendererContext.tsrx',
				mode: 'client',
				compileOptions: { dev },
			},
		);
		const root = mount(App, { context: null, value: 'initial' });
		try {
			expect(root.find('p').textContent).toBe('waiting');
			const Theme = createContext('default');
			root.update(App, { context: Theme, value: 'provided' });
			const button = root.find('button');
			expect(button.textContent).toBe('provided:0');
			root.click('button');
			expect(button.textContent).toBe('provided:1');
			root.update(App, { context: Theme, value: 'updated' });
			expect(root.find('button')).toBe(button);
			expect(button.textContent).toBe('updated:1');
			root.click('button');
			expect(button.textContent).toBe('updated:2');
		} finally {
			root.unmount();
		}
	},
);
