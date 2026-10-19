// @vitest-environment node

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { evaluateCompiledFixtureCode } from '../../octane/tests/_server-fixture.js';

// Exercise the installed handler for CVE-2026-102989 / GHSA-qx66-fv34-fjm8.
// Only the compiler-generated function resolver is supplied by the fixture;
// payload decoding and response serialization use the installed dependencies.
const requireFromBinding = createRequire(
	join(process.cwd(), 'packages/tanstack-start/package.json'),
);
const serverCoreRoot = dirname(
	requireFromBinding.resolve('@tanstack/start-server-core/package.json'),
);
const handlerFile = join(serverCoreRoot, 'dist/esm/server-functions-handler.js');
const requireFromHandler = createRequire(handlerFile);
const clientCoreRoot = dirname(
	requireFromHandler.resolve('@tanstack/start-client-core/package.json'),
);
const storageRoot = dirname(
	requireFromHandler.resolve('@tanstack/start-storage-context/package.json'),
);
const seroval = requireFromHandler('seroval');

type ActionOptions = { data: unknown; context: unknown; method: string };
type ActionResult = { result: unknown } | { error: unknown };
const action = vi.fn<(options: ActionOptions) => Promise<ActionResult>>();
interface HandlerModule extends Record<string, unknown> {
	handleServerAction(input: {
		request: Request;
		serverFnId: string;
	}): Promise<
		Response | { createResponse(event: { request: Request; requestUrl: URL }): Response }
	>;
}
let handler: HandlerModule;

beforeAll(async () => {
	const dependencies = {
		'./internal-request-response.js': join(serverCoreRoot, 'dist/esm/internal-request-response.js'),
		'./frame-protocol.js': join(serverCoreRoot, 'dist/esm/frame-protocol.js'),
		'@tanstack/start-client-core': join(clientCoreRoot, 'dist/esm/index.js'),
		'@tanstack/start-client-core/client-rpc': join(clientCoreRoot, 'dist/esm/client-rpc/index.js'),
	};
	const runtimeModules = Object.fromEntries(
		await Promise.all(
			Object.entries(dependencies).map(async ([request, file]) => [
				request,
				await import(/* @vite-ignore */ pathToFileURL(file).href),
			]),
		),
	);
	const installed = evaluateCompiledFixtureCode<HandlerModule>(
		readFileSync(handlerFile, 'utf8'),
		handlerFile,
		'server',
		{
			...runtimeModules,
			'./getServerFnById.js': { getServerFnById: () => action },
			'@tanstack/router-core': requireFromHandler('@tanstack/router-core'),
			'@tanstack/router-core/ssr/server': requireFromHandler('@tanstack/router-core/ssr/server'),
			seroval,
		},
	);
	const storage = await import(
		/* @vite-ignore */ pathToFileURL(join(storageRoot, 'dist/esm/index.js')).href
	);
	handler = {
		handleServerAction: (input) =>
			storage.runWithStartContext(
				{
					request: input.request,
					startOptions: {},
					contextAfterGlobalMiddlewares: {},
					handlerType: 'serverFn',
					getRouter() {
						throw new Error('The server-function fixture does not render a router');
					},
				},
				() => installed.handleServerAction(input),
			),
	};
});

function requestFor(payload: unknown) {
	return new Request('https://fixture.test/_server/security-test', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(seroval.toJSON(payload)),
	});
}

describe('TanStack Start server-function handler (CVE-2026-102989)', () => {
	it('restricts client-supplied input to the public {data, context, method} fields', async () => {
		const payload = {
			data: { message: 'public data' },
			context: { locale: 'en' },
			method: 'DELETE',
			result: { headers: { 'content-type': 'text/html' }, body: '<script>alert(1)</script>' },
			error: { status: 200 },
			middleware: ['attacker-controlled'],
		};
		action.mockResolvedValue({ result: new Response('ok') });
		await handler.handleServerAction({ request: requestFor(payload), serverFnId: 'security-test' });

		expect(action).toHaveBeenLastCalledWith({
			data: payload.data,
			context: payload.context,
			method: 'POST',
		});
	});

	it.each(['result', 'error'])(
		'serializes a response-shaped %s instead of returning it as raw HTML',
		async (field) => {
			const responseShaped = {
				status: 200,
				headers: { 'content-type': 'text/html' },
				body: '<script>alert(1)</script>',
			};
			action.mockResolvedValue(
				field === 'result' ? { result: responseShaped } : { error: responseShaped },
			);
			const request = requestFor({ data: 'untrusted' });
			const result = await handler.handleServerAction({ request, serverFnId: 'security-test' });

			expect(result).not.toEqual(responseShaped);
			const response =
				result instanceof Response
					? result
					: result.createResponse({ request, requestUrl: new URL(request.url) });
			expect(response.headers.get('content-type')).toBe('application/json');
			expect(response.headers.get('x-tss-serialized')).toBe('true');
			const decoded = seroval.fromCrossJSON(JSON.parse(await response.text()), { refs: new Map() });
			expect(decoded).toEqual(
				field === 'result' ? { result: responseShaped } : { error: responseShaped },
			);
		},
	);
});
