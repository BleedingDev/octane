import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'octane';
import { RouterProvider } from '@octanejs/tanstack-router';
import { createControlledPromise } from '@tanstack/router-core';
import type { RouterEvent } from '@tanstack/router-core';
import { makeOptionalNavigationRouter } from '../_fixtures/optional-presence.tsrx';

type NavigationEvent = Extract<
	RouterEvent,
	{ type: 'onLoad' | 'onBeforeRouteMount' | 'onResolved' | 'onRendered' }
>;

describe('native router optional event values', () => {
	it('preserves an own unavailable previous location and retains known locations after navigation', async () => {
		const deferred = createControlledPromise<string>();
		const router = makeOptionalNavigationRouter(deferred);
		const events: NavigationEvent[] = [];
		const eventTypes: NavigationEvent['type'][] = [
			'onLoad',
			'onBeforeRouteMount',
			'onResolved',
			'onRendered',
		];
		const unsubscribe = eventTypes.map((type) =>
			router.subscribe(type, (event) => events.push(event)),
		);
		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			root.render(RouterProvider, { router });
			await vi.waitFor(() =>
				expect(container.querySelector('.loader-pending')?.textContent).toBe('loader pending'),
			);
			deferred.resolve('Initial ready');
			await vi.waitFor(() => {
				expect(router.state.status).toBe('idle');
				expect(container.querySelector('.loader-done')?.textContent).toBe('loader done');
				expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(eventTypes));
			});
			for (const event of events) {
				expect(Object.hasOwn(event, 'fromLocation')).toBe(true);
				expect(event.toLocation.pathname).toBe('/slow-loader');
				if (event.type === 'onRendered') {
					expect(event.fromLocation?.pathname).toBe('/slow-loader');
				} else {
					expect(event.fromLocation).toBeUndefined();
				}
			}

			events.length = 0;
			await router.navigate({ to: '/plain' });
			await vi.waitFor(() =>
				expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(eventTypes)),
			);
			for (const event of events) {
				expect(Object.hasOwn(event, 'fromLocation')).toBe(true);
				expect(event.fromLocation?.pathname).toBe('/slow-loader');
				expect(event.toLocation.pathname).toBe('/plain');
				expect(event.pathChanged).toBe(true);
				expect(event.hrefChanged).toBe(true);
				expect(event.hashChanged).toBe(false);
			}
		} finally {
			deferred.resolve('Cleanup');
			unsubscribe.forEach((stop) => stop());
			root.unmount();
			container.remove();
		}
	});
});
