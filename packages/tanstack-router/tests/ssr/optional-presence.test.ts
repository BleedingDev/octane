import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'octane/server';
import type { RouterManagedTag } from '@tanstack/router-core';
import { OptionalAssets, makeOptionalAssetsRouter } from '../_fixtures/optional-presence.tsrx';

describe('native router optional asset values', () => {
	it('omits missing head content, preserves empty content, and renders scripts without a nonce', async () => {
		const router = makeOptionalAssetsRouter();
		await router.load();
		let tags: RouterManagedTag[] = [];
		const { html } = renderToStaticMarkup(OptionalAssets, {
			router,
			capture: (value: RouterManagedTag[]) => {
				tags = value;
			},
		});
		const missingStyle = tags.find(
			(tag) => tag.tag === 'style' && tag.attrs?.['media'] === 'screen',
		);
		const emptyStyle = tags.find((tag) => tag.tag === 'style' && tag.attrs?.['media'] === 'print');
		const missingScript = tags.find(
			(tag) => tag.tag === 'script' && tag.attrs?.['src'] === '/head-missing.js',
		);
		const emptyScript = tags.find(
			(tag) => tag.tag === 'script' && tag.attrs?.['id'] === 'head-empty',
		);
		if (!missingStyle || !missingScript || !emptyStyle || !emptyScript) {
			throw new Error('Expected the route head styles and scripts');
		}
		expect(Object.hasOwn(missingStyle, 'children')).toBe(false);
		expect(Object.hasOwn(missingScript, 'children')).toBe(false);
		expect(Object.hasOwn(emptyStyle, 'children')).toBe(true);
		expect(Object.hasOwn(emptyScript, 'children')).toBe(true);
		expect(emptyStyle?.children).toBe('');
		expect(emptyScript?.children).toBe('');
		expect(html).toContain('src="/head-missing.js"');
		expect(html).toContain('src="/body-missing.js"');
		expect(html).toContain('globalThis.optionalHead=true');
		expect(html).toContain(':root { --optional-style: 1; }');
		expect(html).not.toContain('nonce=');
	});
});
