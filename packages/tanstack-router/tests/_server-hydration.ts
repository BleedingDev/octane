import type { AnyRouter } from '@tanstack/router-core';
import { attachRouterServerSsrUtils } from '@tanstack/router-core/ssr/server';

/** Run the server producer's actual bootstrap in the test browser. */
export async function installServerHydration(router: AnyRouter): Promise<void> {
	router.update({ isServer: true });
	attachRouterServerSsrUtils({ router, manifest: undefined });
	try {
		await router.load();
		await router.serverSsr!.dehydrate();
		const tags = router.serverSsr!.takeInitialHydrationScriptTags();
		if (!tags) throw new Error('Server dehydration did not emit its initial bootstrap.');
		for (const tag of tags.before) {
			const script = document.createElement('script');
			for (const [name, value] of Object.entries(tag.attrs ?? {})) {
				if (value !== undefined) script.setAttribute(name, String(value));
			}
			script.textContent = tag.children ?? '';
			try {
				document.head.append(script);
			} finally {
				script.remove();
			}
		}
		// Vitest aliases window to its worker global. Inline scripts run in the
		// documented jsdom.window realm, whose new globals are not auto-forwarded.
		const browser = Reflect.get(globalThis, 'jsdom')?.window;
		if (!browser) throw new Error('Server hydration tests require the jsdom environment.');
		const bootstrap = Reflect.get(browser, '$_TSR');
		if (!bootstrap?.router) {
			throw new Error('The emitted server bootstrap did not install its router payload.');
		}
		Reflect.set(window, '$_TSR', bootstrap);
	} finally {
		router.serverSsr!.cleanup();
	}
}
