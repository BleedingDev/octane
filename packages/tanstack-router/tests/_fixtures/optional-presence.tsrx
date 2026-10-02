import {
	Body,
	Head,
	HeadContent,
	Html,
	Outlet,
	Scripts,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	routerContext as RouterContext,
	useTags,
} from '@octanejs/tanstack-router';
import type { AnyRouter, RouterManagedTag } from '@tanstack/router-core';

function CaptureTags(props: { capture: (tags: RouterManagedTag[]) => void }) @{
	props.capture(useTags());
	<></>
}

export function OptionalAssets(props: {
	router: AnyRouter;
	capture: (tags: RouterManagedTag[]) => void;
}) @{
	<RouterContext value={props.router}>
		<Html>
			<Head>
				<CaptureTags capture={props.capture} />
				<HeadContent />
			</Head>
			<Body>
				<Scripts />
			</Body>
		</Html>
	</RouterContext>
}

export function makeOptionalAssetsRouter() {
	const rootRoute = createRootRoute({
		head: () => ({
			styles: [
				{ media: 'screen' },
				{ media: 'print', children: '' },
				{ media: 'all', children: ':root { --optional-style: 1; }' },
			],
			scripts: [
				{ src: '/head-missing.js' },
				{ id: 'head-empty', children: '' },
				{ id: 'head-filled', children: 'globalThis.optionalHead=true' },
			],
		}),
		scripts: () => [{ src: '/body-missing.js' }, { id: 'body-empty', children: '' }],
	});
	const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/' });
	const router = createRouter({
		routeTree: rootRoute.addChildren([indexRoute]),
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	router.isServer = true;
	return router;
}

function OptionalNavigationRoot() @{
	<Outlet />
}

function OptionalLoaderPending() @{
	<p class="loader-pending">loader pending</p>
}

function OptionalLoaderReady() @{
	<p class="loader-done">loader done</p>
}

function OptionalPlainRoute() @{
	<p>plain route</p>
}

export function makeOptionalNavigationRouter(loaderPromise: Promise<string>) {
	const rootRoute = createRootRoute({ component: OptionalNavigationRoot });
	const loaderRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: 'slow-loader',
		loader: () => loaderPromise,
		pendingMs: 0,
		pendingMinMs: 0,
		pendingComponent: OptionalLoaderPending,
		component: OptionalLoaderReady,
	});
	const plainRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: 'plain',
		component: OptionalPlainRoute,
	});
	return createRouter({
		routeTree: rootRoute.addChildren([loaderRoute, plainRoute]),
		history: createMemoryHistory({ initialEntries: ['/slow-loader'] }),
	});
}
