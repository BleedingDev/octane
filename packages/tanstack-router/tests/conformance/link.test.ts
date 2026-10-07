import { describe, it, expect, vi } from 'vitest';
import { mount, nextPaint } from '../_helpers';
import { RouterProvider } from '@octanejs/tanstack-router';
import { ExternalLinkSurface, makeLinkRouter } from '../_fixtures/link.tsrx';

async function flush() {
	for (let i = 0; i < 6; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextPaint();
	}
}

// Link parity — per react-router's link.tsx: fuzzy/exact active matching with
// trailing-slash normalization, deepEqual partial search matching, external-URL
// pass-through, dangerous-protocol blocking, disabled semantics, render-prop
// children, route masking, intent preloading, and createLink.
describe('@octanejs/tanstack-router — Link', () => {
	it('fuzzy active matching does NOT light up /about for /about-us (segment-aware prefix)', async () => {
		const router = makeLinkRouter('/about-us');
		await router.load();
		const r = mount(RouterProvider as any, { router });
		await flush();

		expect(r.find('.l-about-us').getAttribute('data-status')).toBe('active');
		// Old bug: bare startsWith marked /about active on /about-us.
		expect(r.find('.l-about').getAttribute('data-status')).toBe(null);
		r.unmount();
	});

	it('fuzzy matching lights up an ancestor path segment', async () => {
		const router = makeLinkRouter('/about');
		await router.load();
		const r = mount(RouterProvider as any, { router });
		await flush();

		expect(r.find('.l-about').getAttribute('data-status')).toBe('active');
		expect(r.find('.l-about-exact').getAttribute('data-status')).toBe('active');
		expect(r.find('.l-home').getAttribute('data-status')).toBe(null); // '/' fuzzy… root special
		r.unmount();
	});

	it('search params match as a PARTIAL deep subset (not raw string equality)', async () => {
		const router = makeLinkRouter('/list?extra=x&page=2');
		await router.load();
		const r = mount(RouterProvider as any, { router });
		await flush();

		// { page: 2 } is a subset of { page: 2, extra: 'x' } → active even though
		// the serialized search strings differ.
		expect(r.find('.l-list-p2').getAttribute('data-status')).toBe('active');
		expect(r.find('.l-list-p2x').getAttribute('data-status')).toBe('active');
		r.unmount();
	});

	it('external URLs render as plain anchors; dangerous protocols are blocked', async () => {
		const router = makeLinkRouter('/');
		await router.load();
		const r = mount(RouterProvider as any, { router });
		await flush();

		expect(r.find('.l-ext').getAttribute('href')).toBe('https://example.com/docs');
		// A javascript: `to` is neutralized: either blocked (no href) or
		// internalized to a harmless path ('/javascript:…' — upstream's output for
		// a non-external dangerous `to`); it must never survive as a live
		// javascript: protocol href.
		const dangerHref = r.find('.l-danger').getAttribute('href');
		expect(dangerHref === null || !dangerHref.startsWith('javascript:')).toBe(true);
		r.unmount();
	});

	it('preserves an authored protocol-relative href, target, and browser click behavior', async () => {
		const router = makeLinkRouter('/about');
		router.update({ origin: 'https://app.example' });
		await router.load();
		const navigate = vi.spyOn(router, 'navigate');
		const preload = vi.spyOn(router, 'preloadRoute');
		const href = '//catalog.example/products?sort=price#featured';
		const r = mount(ExternalLinkSurface, { router, to: href, target: '_blank' });
		try {
			await flush();
			const link = r.find('.l-current');
			expect(link.getAttribute('href')).toBe(href);
			expect(link.getAttribute('target')).toBe('_blank');
			expect(link.getAttribute('aria-current')).toBeNull();
			const click = new MouseEvent('click', { bubbles: true, cancelable: true });
			link.dispatchEvent(click);
			await flush();
			expect(click.defaultPrevented).toBe(false);
			expect(navigate).not.toHaveBeenCalled();
			expect(preload).not.toHaveBeenCalled();
			expect(router.state.location.pathname).toBe('/about');
		} finally {
			r.unmount();
			navigate.mockRestore();
			preload.mockRestore();
			router.history.destroy();
		}
	});

	it('updates an external link to its current href and disabled state', async () => {
		const router = makeLinkRouter('/');
		router.update({ origin: 'https://app.example' });
		await router.load();
		const r = mount(ExternalLinkSurface, {
			router,
			to: '//catalog.example/first',
			target: '_blank',
		});
		try {
			expect(r.find('.l-current').getAttribute('href')).toBe('//catalog.example/first');
			r.update(ExternalLinkSurface, {
				router,
				to: '//checkout.example/next?sku=tractor#paid',
				target: '_self',
			});
			expect(r.find('.l-current').getAttribute('href')).toBe(
				'//checkout.example/next?sku=tractor#paid',
			);
			expect(r.find('.l-current').getAttribute('target')).toBe('_self');
			r.update(ExternalLinkSurface, { router, to: '//checkout.example/next', disabled: true });
			expect(r.find('.l-current').getAttribute('href')).toBeNull();
			expect(r.find('.l-current').getAttribute('aria-disabled')).toBe('true');
			expect(r.find('.l-current').getAttribute('role')).toBe('link');
			r.update(ExternalLinkSurface, { router, to: 'https://catalog.example/enabled' });
			expect(r.find('.l-current').getAttribute('href')).toBe('https://catalog.example/enabled');
			expect(r.find('.l-current').getAttribute('aria-disabled')).toBeNull();
			expect(r.find('.l-current').getAttribute('role')).toBeNull();
			expect(r.find('.l-current').getAttribute('target')).toBeNull();
		} finally {
			r.unmount();
			router.history.destroy();
		}
	});

	it('constant-disabled external links have no live href and expose their disabled state', async () => {
		const router = makeLinkRouter('/');
		await router.load();
		const r = mount(ExternalLinkSurface, { router, to: '/about' });
		try {
			for (const selector of ['.l-disabled-relative', '.l-disabled-absolute']) {
				const link = r.find(selector);
				expect(link.getAttribute('href')).toBeNull();
				expect(link.getAttribute('aria-disabled')).toBe('true');
				expect(link.getAttribute('role')).toBe('link');
			}
		} finally {
			r.unmount();
			router.history.destroy();
		}
	});

	it.each([
		'javascript:alert(1)',
		'JaVaScRiPt:alert(1)',
		'java\nscript:alert(1)',
		'\tjavascript:alert(1)',
		'data:text/html,unsafe',
	])('never exposes an unsafe authored protocol: %s', async (to) => {
		const router = makeLinkRouter('/');
		await router.load();
		const r = mount(ExternalLinkSurface, { router, to });
		try {
			const href = r.find('.l-current').getAttribute('href');
			expect(href === null || new URL(href, router.origin).protocol === 'http:').toBe(true);
		} finally {
			r.unmount();
			router.history.destroy();
		}
	});

	it('does not expose an unsafe origin-changing rewrite as a live href', async () => {
		const router = makeLinkRouter('/');
		await router.load();
		router.update({ rewrite: { output: () => new URL('data:text/html,unsafe') } });
		const r = mount(ExternalLinkSurface, { router, to: '/about' });
		try {
			expect(r.find('.l-current').getAttribute('href')).toBeNull();
		} finally {
			r.unmount();
			router.history.destroy();
		}
	});

	it('disabled links drop the href and expose role="link" + aria-disabled', async () => {
		const router = makeLinkRouter('/');
		await router.load();
		const r = mount(RouterProvider as any, { router });
		await flush();

		const el = r.find('.l-disabled');
		expect(el.getAttribute('href')).toBe(null);
		expect(el.getAttribute('role')).toBe('link');
		expect(el.getAttribute('aria-disabled')).toBe('true');
		r.unmount();
	});

	it('children-as-function receives { isActive }', async () => {
		const router = makeLinkRouter('/about');
		await router.load();
		const r = mount(RouterProvider as any, { router });
		await flush();

		expect(r.find('.l-render').textContent).toBe('active:true');

		await router.navigate({ to: '/' });
		await flush();
		expect(r.find('.l-render').textContent).toBe('active:false');
		r.unmount();
	});

	it('mask: the href shows the masked location, navigation goes to the real one', async () => {
		const router = makeLinkRouter('/');
		await router.load();
		const r = mount(RouterProvider as any, { router });
		await flush();

		expect(r.find('.l-masked').getAttribute('href')).toBe('/fake');

		(r.find('.l-masked') as HTMLElement).click();
		await flush();
		expect(router.state.location.pathname).toBe('/secret');
		r.unmount();
	});

	it('preload="intent": hovering the link preloads the route', async () => {
		const router = makeLinkRouter('/');
		await router.load();
		const preloadSpy = vi.spyOn(router, 'preloadRoute');
		const r = mount(RouterProvider as any, { router });
		await flush();

		const link = r.find('.l-intent') as HTMLElement;
		link.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
		link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		await flush();

		expect(preloadSpy).toHaveBeenCalled();
		const arg = preloadSpy.mock.calls[0][0] as any;
		expect(arg.to).toBe('/about');
		r.unmount();
	});

	it('navigate receives replace/viewTransition/state forwarded from Link props', async () => {
		const router = makeLinkRouter('/');
		await router.load();
		const navSpy = vi.spyOn(router, 'navigate');
		const r = mount(RouterProvider as any, { router });
		await flush();

		(r.find('.l-about') as HTMLElement).click();
		await flush();

		expect(navSpy).toHaveBeenCalled();
		const call = navSpy.mock.calls[0][0] as any;
		expect(call.to).toBe('/about');
		expect(router.state.location.pathname).toBe('/about');
		r.unmount();
	});

	it('createLink renders the custom component with router-built props', async () => {
		const router = makeLinkRouter('/cl');
		await router.load();
		const r = mount(RouterProvider as any, { router });
		await flush();

		const fancy = r.find('.l-fancy');
		expect(fancy.getAttribute('data-fancy')).toBe('true');
		expect(fancy.getAttribute('href')).toBe('/about');

		(fancy as HTMLElement).click();
		await flush();
		expect(router.state.location.pathname).toBe('/about');
		r.unmount();
	});
});
