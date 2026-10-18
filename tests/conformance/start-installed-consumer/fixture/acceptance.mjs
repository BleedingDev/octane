import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Dynamic child text is either unframed or enclosed by the native child-slot
// markers (runtime.server ssrChild/ssrBindingChild). Do not accept arbitrary HTML.
function outputPattern(id, prefix) {
	const text = `${prefix}-[a-z0-9]+`;
	const open = String.raw`<!--(?:\[|\[b;[^;<>]+;[^;<>]+;[ts])-->`;
	return new RegExp(
		String.raw`<output(?=\s|>)[^>]*\sid="${id}"[^>]*>(?:${text}|${open}${text}<!--\]-->)</output>`,
	);
}

const rootOutput = outputPattern('root-data', 'root');
const pageOutput = outputPattern('ssr-page', 'page');

const directory = fileURLToPath(new URL('.', import.meta.url));
const input = JSON.parse(readFileSync(new URL('./archive-inputs.json', import.meta.url), 'utf8'));
const consumerManifest = new URL('./package.json', import.meta.url);
const require = createRequire(consumerManifest);

function packageInfo(from, name) {
	const filename = realpathSync(from.resolve(`${name}/package.json`));
	const manifest = JSON.parse(readFileSync(filename, 'utf8'));
	assert.equal(manifest.name, name);
	return {
		filename,
		manifest,
		require: createRequire(filename),
	};
}

function verifyLockfile() {
	const lock = readFileSync(new URL('./pnpm-lock.yaml', import.meta.url), 'utf8');
	assert.match(lock, /^lockfileVersion: '?9\.0'?\r?$/m, 'Expected a normal pnpm v9 lockfile');
	// Read only the controlled root-importer scalar specifiers. Unsupported YAML
	// forms fail the exact comparison; this never rewrites the installer's lock.
	const dependencySections = lock
		.split(/^importers:\r?$/m)
		.slice(1)
		.flatMap((section) => {
			const root = section.match(/^  \.:\r?\n((?: {4}[^\r\n]*(?:\r?\n|$)|\r?\n)*)/m)?.[1];
			const dependencies = root?.match(
				/^ {4}dependencies:\r?\n((?: {6}[^\r\n]*(?:\r?\n|$)|\r?\n)*)/m,
			)?.[1];
			return dependencies ? [dependencies] : [];
		});
	assert.equal(dependencySections.length, 1, 'Expected one root dependency importer');
	const scalar = (value) => {
		if (value.startsWith('"')) return JSON.parse(value);
		if (value.startsWith("'")) {
			assert(value.endsWith("'"));
			return value.slice(1, -1).replaceAll("''", "'");
		}
		return value;
	};
	const requests = [
		...dependencySections[0].matchAll(/^ {6}([^\r\n]+):\r?\n {8}specifier: ([^\r\n]+)\r?$/gm),
	].map(([, name, request]) => [scalar(name), scalar(request)]);
	assert.equal(requests.length, Object.keys(input.dependencies).length);
	assert.deepEqual(
		Object.fromEntries(requests),
		input.dependencies,
		'Installed lockfile requests differ from the supplied archives/tools',
	);
}

function verifyDependencyClosure() {
	const manifest = JSON.parse(readFileSync(consumerManifest, 'utf8'));
	assert.deepEqual(manifest.dependencies, input.dependencies);
	assert.equal(manifest.packageManager, input.packageManager);
	assert.equal(
		execFileSync('pnpm', ['--version'], { cwd: directory, encoding: 'utf8' }).trim(),
		input.packageManager.slice('pnpm@'.length),
		'Run with the exact supplied pnpm installer',
	);
	assert.equal(manifest.pnpm, undefined);
	assert.equal(manifest.overrides, undefined);
	assert.equal(manifest.resolutions, undefined);
	assert.deepEqual(manifest.scripts, { build: 'rsbuild build', acceptance: 'node acceptance.mjs' });
	assert.equal(input.dependencies['@tanstack/router-core'], input.expectedCoreRequest);
	assert.equal(
		readFileSync(new URL('./pnpm-workspace.yaml', import.meta.url), 'utf8'),
		'packages: []\npackageImportMethod: clone-or-copy\nautoInstallPeers: false\nblockExoticSubdeps: true\nminimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\nminimumReleaseAgeExclude: []\n',
	);
	verifyLockfile();
	const core = packageInfo(require, '@tanstack/router-core');
	assert.equal(core.manifest.version, '1.171.38');
	const packages = new Map(
		[
			'octane',
			'@octanejs/rspack-plugin',
			'@octanejs/tanstack-router',
			'@octanejs/tanstack-start',
			'@tanstack/router-core',
			'@tanstack/start-client-core',
			'@tanstack/start-server-core',
			'@tanstack/start-storage-context',
		].map((name) => [name, packageInfo(require, name)]),
	);
	for (const [name, version] of Object.entries({
		'@tanstack/start-client-core': '1.170.38',
		'@tanstack/start-server-core': '1.169.44',
		'@tanstack/start-storage-context': '1.167.40',
	})) {
		assert.equal(packages.get(name).manifest.version, version, `${name} has the wrong version`);
	}
	const sharedPeers = {
		'@octanejs/tanstack-router': ['@tanstack/router-core'],
		'@octanejs/tanstack-start': [
			'@octanejs/tanstack-router',
			'@octanejs/rspack-plugin',
			'@tanstack/router-core',
			'@tanstack/start-client-core',
			'@tanstack/start-server-core',
			'@tanstack/start-storage-context',
		],
		'@tanstack/start-client-core': ['@tanstack/router-core', '@tanstack/start-storage-context'],
		'@tanstack/start-server-core': [
			'@tanstack/router-core',
			'@tanstack/start-client-core',
			'@tanstack/start-storage-context',
		],
		'@tanstack/start-storage-context': ['@tanstack/router-core'],
	};
	for (const [name, dependencies] of Object.entries(sharedPeers)) {
		const owner = packages.get(name);
		for (const dependency of dependencies) {
			assert.equal(
				owner.manifest.peerDependencies?.[dependency],
				packages.get(dependency).manifest.version,
				`${name} must require the exact ${dependency} peer`,
			);
			if (name === '@octanejs/tanstack-start' && dependency === '@octanejs/rspack-plugin') {
				assert.equal(
					owner.manifest.peerDependenciesMeta?.[dependency]?.optional,
					true,
					'The Rsbuild compiler peer must remain optional for Vite consumers',
				);
			} else {
				assert.notEqual(
					owner.manifest.peerDependenciesMeta?.[dependency]?.optional,
					true,
					`${name} must not make ${dependency} optional`,
				);
			}
		}
	}
	for (const [name, owner] of packages) {
		for (const [dependency, expected] of packages) {
			assert.equal(
				owner.manifest.dependencies?.[dependency],
				undefined,
				`${name} must receive shared ${dependency} from the consumer`,
			);
			assert.equal(owner.manifest.optionalDependencies?.[dependency], undefined);
			if (!(dependency in (owner.manifest.peerDependencies ?? {}))) continue;
			// Matching versions alone cannot identify an authenticated fork. Every
			// peer must resolve to the consumer's actual archive installation.
			assert.equal(
				packageInfo(owner.require, dependency).filename,
				expected.filename,
				`${name} resolved a second ${dependency}`,
			);
		}
	}
	console.log('Installed Start closure uses the exact requested helpers and router-core 1.171.38.');
}

verifyDependencyClosure();
if (!process.argv.includes('--check-dependencies')) await runAcceptance();

async function runAcceptance() {
	// Only the generated route tree may accompany the authored router/routes.
	// There are no custom client/server/start entries or alternate build scripts.
	const sources = readdirSync(path.join(directory, 'src'), { recursive: true })
		.filter((file) => statSync(path.join(directory, 'src', file)).isFile())
		.map((file) => file.split(path.sep).join('/'))
		.sort();
	assert.deepEqual(sources, [
		'routeTree.gen.ts',
		'router.ts',
		'routes/__root.tsrx',
		'routes/client-only.tsrx',
		'routes/index.tsrx',
	]);
	const { default: config } = await import('./rsbuild.config.mjs');
	assert.deepEqual(Object.keys(config), ['plugins']);
	assert.equal(config.plugins.length, 1);
	assert.equal(config.plugins[0].name, 'octanejs-tanstack-start');
	assert.equal(Reflect.get(globalThis, 'startAcceptanceSsrFalseLoaderCalls'), undefined);

	const { chromium } = await import('playwright');
	const { default: entry } = await import(
		pathToFileURL(path.join(directory, 'dist/server/index.js'))
	);
	assert.equal(
		typeof entry.fetch,
		'function',
		'The public Start production entry must expose fetch',
	);
	const clientDirectory = path.join(directory, 'dist/client');
	const serverErrors = [];
	const contentTypes = {
		'.js': 'text/javascript',
		'.css': 'text/css',
		'.json': 'application/json',
		'.svg': 'image/svg+xml',
		'.ico': 'image/x-icon',
	};

	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url, `http://${request.headers.host}`);
			const asset = path.resolve(clientDirectory, '.' + decodeURIComponent(url.pathname));
			if (
				asset.startsWith(clientDirectory + path.sep) &&
				existsSync(asset) &&
				statSync(asset).isFile()
			) {
				response.setHeader(
					'content-type',
					contentTypes[path.extname(asset)] ?? 'application/octet-stream',
				);
				response.end(readFileSync(asset));
				return;
			}
			const result = await entry.fetch(
				new Request(url, { method: request.method, headers: request.headers }),
			);
			response.writeHead(result.status, Object.fromEntries(result.headers));
			if (result.body) await pipeline(Readable.fromWeb(result.body), response);
			else response.end();
		} catch (error) {
			serverErrors.push(error);
			response.statusCode = 500;
			response.end('Start acceptance request failed');
		}
	});

	let browser;
	let failure;
	const cleanupErrors = [];
	try {
		await new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		const base = `http://127.0.0.1:${server.address().port}`;
		browser = await chromium.launch({
			headless: true,
			handleSIGINT: true,
			handleSIGTERM: true,
			handleSIGHUP: true,
		});
		for (const pathname of ['/', '/client-only']) {
			const response = await fetch(base + pathname);
			assert.equal(response.status, 200);
			assert.match(response.headers.get('content-type'), /text\/html/);
			const html = await response.text();
			assert.match(html, rootOutput);
			if (pathname === '/') assert.match(html, pageOutput);
			else assert.doesNotMatch(html, /browser loader completed/);
			assert.equal(Reflect.get(globalThis, 'startAcceptanceSsrFalseLoaderCalls') ?? 0, 0);

			const page = await browser.newPage();
			page.setDefaultTimeout(20_000);
			const diagnostics = [];
			page.on('pageerror', (error) => diagnostics.push(error.message));
			page.on('console', (message) => {
				if (
					message.type() === 'error' ||
					(message.type() === 'warning' && /hydrat/i.test(message.text()))
				)
					diagnostics.push(message.text());
			});
			page.on('requestfailed', (request) =>
				diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`),
			);
			page.on('response', (result) => {
				if (result.status() >= 400) diagnostics.push(`${result.status()} ${result.url()}`);
			});
			let releaseScripts;
			const scriptsHeld = new Promise((resolve) => {
				releaseScripts = resolve;
			});
			await page.route('**/*', async (route) => {
				if (route.request().resourceType() === 'script') await scriptsHeld;
				await route.continue();
			});
			try {
				await page.goto(base + pathname, { waitUntil: 'commit' });
				const main = await page.waitForSelector('#retained-root');
				const input = await page.waitForSelector('#draft');
				const counter = await page.waitForSelector('#counter');
				const rootData = await page.locator('#root-data').textContent();
				const pageNode = pathname === '/' ? await page.waitForSelector('#ssr-page') : undefined;
				const pageData = pageNode ? await pageNode.textContent() : undefined;
				assert.match(rootData, /^root-[a-z0-9]+$/);
				if (pageNode) assert.match(pageData, /^page-[a-z0-9]+$/);
				assert(
					(await page.locator('script[src]').count()) > 0,
					'The production Start manifest must emit its client assets',
				);
				assert.equal(await main.getAttribute('data-ready'), 'false');
				if (pathname !== '/') assert.equal(await page.locator('#client-page').count(), 0);
				await input.fill('draft typed before Start hydration');
				releaseScripts();
				await page.waitForSelector('#retained-root[data-ready="true"]');
				if (pathname !== '/') {
					await page.waitForFunction(
						() =>
							document.getElementById('client-page')?.textContent === 'browser loader completed',
					);
				}
				for (const [handle, id] of [
					[main, 'retained-root'],
					[input, 'draft'],
					[counter, 'counter'],
					...(pageNode ? [[pageNode, 'ssr-page']] : []),
				]) {
					assert.equal(
						await handle.evaluate((node, id) => node === document.getElementById(id), id),
						true,
						`${pathname}: #${id} was replaced`,
					);
				}
				assert.equal(await input.inputValue(), 'draft typed before Start hydration');
				assert.equal(
					await page.locator('#root-data').textContent(),
					rootData,
					'Start must hydrate the serialized root loader data',
				);
				if (pageNode)
					assert.equal(
						await pageNode.textContent(),
						pageData,
						'Start must hydrate the serialized page loader data',
					);
				await counter.click();
				await page.waitForFunction(
					() => document.getElementById('counter')?.textContent === 'Count: 1',
				);
				assert.deepEqual(diagnostics, []);
				assert.deepEqual(serverErrors, []);
				assert.equal(
					Reflect.get(globalThis, 'startAcceptanceSsrFalseLoaderCalls') ?? 0,
					0,
					'An ssr:false loader ran on the server',
				);
				console.log(
					`PASS ${pathname}: public Start request, hydration, retained nodes/draft/data, and live events`,
				);
			} finally {
				releaseScripts();
				for (const close of [() => page.unrouteAll({ behavior: 'wait' }), () => page.close()]) {
					try {
						await close();
					} catch (error) {
						cleanupErrors.push(error);
					}
				}
			}
		}
	} catch (error) {
		failure = error;
	}
	for (const close of [
		() => browser?.close(),
		() =>
			new Promise((resolve, reject) => {
				if (!server.listening) {
					resolve();
					return;
				}
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	]) {
		try {
			await close();
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	if (cleanupErrors.length)
		throw new AggregateError(
			failure ? [failure, ...cleanupErrors] : cleanupErrors,
			'Start acceptance cleanup failed',
		);
	if (failure) throw failure;
}
