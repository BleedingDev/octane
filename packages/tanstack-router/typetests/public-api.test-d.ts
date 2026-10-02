import { expectTypeOf } from 'vitest';
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	getLocationChangeInfo,
	getRouteApi,
	linkOptions,
	Router,
	useRouter,
} from '@octanejs/tanstack-router';
import type { AnyRouter, CreateRouterFn } from '@tanstack/router-core';

const rootRoute = createRootRoute();
const postRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'posts/$postId',
	loader: () => ({ title: 'Post' }),
});
const routeTree = rootRoute.addChildren([postRoute]);
const router = createRouter({
	routeTree,
	history: createMemoryHistory({ initialEntries: ['/'] }),
});

declare module '@octanejs/tanstack-router' {
	interface Register {
		router: typeof router;
	}
}

expectTypeOf(postRoute.fullPath).toEqualTypeOf<'/posts/$postId'>();
expectTypeOf(postRoute.useParams()).toEqualTypeOf<{ postId: string }>();
expectTypeOf(postRoute.useLoaderData()).toEqualTypeOf<{ title: string }>();

const postApi = getRouteApi('/posts/$postId');
expectTypeOf(postApi.id).toEqualTypeOf<'/posts/$postId'>();
expectTypeOf(postApi.useParams()).toEqualTypeOf<{ postId: string }>();
expectTypeOf(postApi.useLoaderData()).toEqualTypeOf<{ title: string }>();

const postLink = linkOptions({
	to: '/posts/$postId',
	params: { postId: '42' },
});
expectTypeOf(postLink.to).toEqualTypeOf<'/posts/$postId'>();
expectTypeOf(postLink.params).toEqualTypeOf<{ readonly postId: '42' }>();

const registeredRouter = useRouter();
expectTypeOf(registeredRouter.routeTree).toEqualTypeOf<typeof router.routeTree>();
expectTypeOf(registeredRouter.options).toEqualTypeOf<typeof router.options>();
expectTypeOf(registeredRouter.history).toEqualTypeOf<typeof router.history>();
expectTypeOf(createRouter).toEqualTypeOf<CreateRouterFn>();

const explicitRouter = useRouter<typeof router>({ router, warn: false });
expectTypeOf(explicitRouter.routeTree).toEqualTypeOf<typeof router.routeTree>();
expectTypeOf(explicitRouter.options).toEqualTypeOf<typeof router.options>();
expectTypeOf(explicitRouter.history).toEqualTypeOf<typeof router.history>();

function preserveGenericRouter<TRouter extends AnyRouter>(value: TRouter): TRouter {
	return useRouter<TRouter>({ router: value });
}
expectTypeOf(preserveGenericRouter(router).routeTree).toEqualTypeOf<typeof router.routeTree>();

const locationChangeInfo = getLocationChangeInfo(router.state.location);
registeredRouter.emit({ type: 'onLoad', ...locationChangeInfo });
registeredRouter.emit({ type: 'onBeforeRouteMount', ...locationChangeInfo });
registeredRouter.emit({ type: 'onResolved', ...locationChangeInfo });
registeredRouter.emit({ type: 'onRendered', ...locationChangeInfo });
const originalEmitter: typeof router.emit = registeredRouter.emit;
originalEmitter({
	type: 'onBeforeNavigate',
	toLocation: router.state.location,
	pathChanged: false,
	hrefChanged: false,
	hashChanged: false,
});

const nativeRouter = new Router({ routeTree });
nativeRouter.emit({ type: 'onLoad', ...locationChangeInfo });

// @ts-expect-error unknown route ids stay rejected by the registered route tree
getRouteApi('/missing');
// @ts-expect-error links must target a route from the registered route tree
linkOptions({ to: '/missing' });
