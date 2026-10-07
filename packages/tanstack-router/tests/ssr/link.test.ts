import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'octane/server';
import { ExternalLinkSurface, makeLinkRouter } from '../_fixtures/link.tsrx';

describe('native Link server markup', () => {
	it('preserves the authored protocol-relative href and target', async () => {
		const router = makeLinkRouter('/about');
		router.update({ origin: 'https://app.example', isServer: true });
		await router.load();
		try {
			const { html } = renderToStaticMarkup(ExternalLinkSurface, {
				router,
				to: '//catalog.example/products?sort=price#featured',
				target: '_blank',
			});
			const anchor = html.match(/<a\b(?=[^>]*\bclass="l-current")[^>]*>/)?.[0];
			expect(anchor).toContain('href="//catalog.example/products?sort=price#featured"');
			expect(anchor).toContain('target="_blank"');
			expect(html).not.toContain('aria-current=');
		} finally {
			router.history.destroy();
		}
	});

	it('omits hrefs from constant-disabled external links and publishes accessible disabled state', async () => {
		const router = makeLinkRouter('/');
		router.update({ isServer: true });
		await router.load();
		try {
			const { html } = renderToStaticMarkup(ExternalLinkSurface, { router, to: '/about' });
			for (const klass of ['l-disabled-relative', 'l-disabled-absolute']) {
				const anchor = html.match(new RegExp(`<a\\b[^>]*class="${klass}"[^>]*>`))?.[0];
				expect(anchor).toBeDefined();
				expect(anchor).not.toContain('href=');
				expect(anchor).toContain('role="link"');
				expect(anchor).toContain('aria-disabled="true"');
			}
		} finally {
			router.history.destroy();
		}
	});

	it.each([
		'JaVaScRiPt:alert(1)',
		'java\nscript:alert(1)',
		'\tjavascript:alert(1)',
		'data:text/html,unsafe',
	])('does not serialize a live unsafe protocol: %s', async (to) => {
		const router = makeLinkRouter('/');
		router.update({ isServer: true });
		await router.load();
		try {
			const { html } = renderToStaticMarkup(ExternalLinkSurface, { router, to });
			const anchor = html.match(/<a\b(?=[^>]*\bclass="l-current")[^>]*>/)?.[0];
			expect(anchor).toBeDefined();
			const href = anchor?.match(/\bhref="([^"]*)"/)?.[1];
			expect(href === undefined || new URL(href, router.origin).protocol === 'http:').toBe(true);
		} finally {
			router.history.destroy();
		}
	});

	it('omits an unsafe href produced by an origin-changing rewrite', async () => {
		const router = makeLinkRouter('/');
		router.update({ isServer: true });
		await router.load();
		router.update({ rewrite: { output: () => new URL('data:text/html,unsafe') } });
		try {
			const { html } = renderToStaticMarkup(ExternalLinkSurface, { router, to: '/about' });
			const anchor = html.match(/<a\b[^>]*class="l-current"[^>]*>/)?.[0];
			expect(anchor).toBeDefined();
			expect(anchor).not.toContain('href=');
		} finally {
			router.history.destroy();
		}
	});
});
