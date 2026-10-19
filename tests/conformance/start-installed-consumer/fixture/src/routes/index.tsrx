import { createFileRoute } from '@octanejs/tanstack-router';

export const Route = createFileRoute('/')({
	loader: () => 'page-' + Math.random().toString(36).slice(2),
	staleTime: Infinity,
	component: Page,
});

function Page() @{
	const data = Route.useLoaderData();
	<output id="ssr-page">{data as string}</output>
}
