import { useEffect, useState } from 'octane';
import type { OctaneNode } from 'octane';
import {
	Body,
	Head,
	HeadContent,
	Html,
	Outlet,
	Scripts,
	createRootRoute,
} from '@octanejs/tanstack-router';

export const Route = createRootRoute({
	loader: () => 'root-' + Math.random().toString(36).slice(2),
	staleTime: Infinity,
	component: RootLayout,
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children?: OctaneNode }) @{
	<Html lang="en">
		<Head>
			<link rel="icon" href="data:," />
			<HeadContent />
		</Head>
		<Body>
			{children}
			<Scripts />
		</Body>
	</Html>
}

function RootLayout() @{
	const data = Route.useLoaderData();
	const [count, setCount] = useState(0);
	const [ready, setReady] = useState(false);
	useEffect(() => setReady(true), []);
	<main id="retained-root" data-ready={ready ? 'true' : 'false'}>
		<output id="root-data">{data as string}</output>
		<input id="draft" aria-label="Draft" defaultValue="server draft" />
		<button id="counter" onClick={() => setCount((value) => value + 1)}>
			{'Count: ' + count}
		</button>
		<Outlet />
	</main>
}
