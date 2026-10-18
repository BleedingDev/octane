import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { compile } from '../../packages/octane/src/compiler/compile.js';

async function bundleCall(contextual) {
	const directory = path.resolve('packages/octane');
	const source = `module server {
${contextual ? "import type { ServerCallContext } from 'octane/server';" : ''}
export function read(value: string${contextual ? ', context: ServerCallContext' : ''}) { return value; }
}
import { read } from 'server';
export { read };`;
	const { code } = compile(source, path.join(directory, 'RpcClient.tsrx'), {
		mode: 'client',
		dev: false,
		hmr: false,
	});
	return build({
		stdin: { contents: code, resolveDir: directory },
		bundle: true,
		write: false,
		minify: true,
		metafile: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		tsconfigRaw: { compilerOptions: {} },
		define: { 'process.env.NODE_ENV': '"production"', __OCTANE_PROFILE_ENABLED__: 'false' },
	});
}

function devalueBytes(result) {
	return Object.values(result.metafile.outputs).reduce(
		(total, output) =>
			total +
			Object.entries(output.inputs).reduce(
				(bytes, [file, input]) => bytes + (file.includes('/devalue/') ? input.bytesInOutput : 0),
				0,
			),
		0,
	);
}

test('compiled contextual RPC clients omit the unused legacy serializer and preserve local options', async (t) => {
	const contextual = await bundleCall(true);
	const legacy = await bundleCall(false);
	assert.ok(devalueBytes(legacy) > 0, 'the legacy protocol still carries its required serializer');
	assert.equal(
		devalueBytes(contextual),
		0,
		'the bounded protocol uses its own argument/result codec',
	);
	const descriptors = new Map(
		['location', 'fetch'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
	);
	t.after(() => {
		for (const [name, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete globalThis[name];
		}
	});
	let request;
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: { href: 'https://octane.test/page' },
	});
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		value: async (url, options) => {
			request = { url, options };
			return new Response('[1,0,"value",["string","ready"]]\n[1,1,"complete",null]\n', {
				headers: { 'Content-Type': 'application/x-octane-rpc+ndjson' },
			});
		},
	});
	const client = await import(
		'data:text/javascript;base64,' + Buffer.from(contextual.outputFiles[0].text).toString('base64')
	);
	const controller = new AbortController();
	assert.equal(await client.read('ready', { signal: controller.signal }), 'ready');
	assert.equal(new URL(request.url).origin, 'https://octane.test');
	assert.deepEqual(JSON.parse(request.options.body), [1, ['array', [['string', 'ready']]]]);
	assert.equal(request.options.headers.Accept, 'application/x-octane-rpc+ndjson');
	assert.equal(request.options.signal.aborted, false);
	controller.abort();
	assert.equal(request.options.signal.aborted, true, 'local cancellation reaches the transport');
});
