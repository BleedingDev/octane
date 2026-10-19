import { createFileRoute } from '@octanejs/tanstack-router';

export const Route = createFileRoute('/client-only')({
	ssr: false,
	loader: async () => {
		if (typeof window === 'undefined') {
			// Observe the authored loader even if a route boundary catches its error.
			Reflect.set(
				globalThis,
				'startAcceptanceSsrFalseLoaderCalls',
				Number(Reflect.get(globalThis, 'startAcceptanceSsrFalseLoaderCalls') ?? 0) + 1,
			);
			throw new Error('An ssr:false loader executed on the server');
		}
		await Promise.resolve();
		return 'browser loader completed';
	},
	component: Page,
});

function Page() @{
	const data = Route.useLoaderData();
	<output id="client-page">{data as string}</output>
}
