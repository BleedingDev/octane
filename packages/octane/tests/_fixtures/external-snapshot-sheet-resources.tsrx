import { preinit, Suspense, use } from 'octane';

function registerSheets(nonce: string, precedence: string, label: string) {
	preinit('/shared.css', {
		as: 'style',
		precedence,
		nonce,
		crossOrigin: 'anonymous',
		integrity: 'sha256-shared',
		media: 'screen',
	});
	preinit(`/${label}.css`, { as: 'style', precedence, nonce });
}

export function ResourceRemote(props: { label: string; nonce: string }) @{
	registerSheets(props.nonce, 'federated', props.label);
	<article data-resource={props.label}>
		<title>{props.label as string}</title>
		<p>{props.label as string}</p>
		<style href="/inline.css" precedence="federated" nonce={props.nonce}>
			.resource-inline {
				color: rebeccapurple;
			}
		</style>
	</article>
}

export function createResourceParent(Child: typeof ResourceRemote) {
	return function ResourceParent(props: { label: string; nonce: string }) @{
		registerSheets(props.nonce, 'federated', props.label);
		<section data-parent>
			<Child label="nested" nonce={props.nonce} />
			<style href="/inline.css" precedence="federated" nonce={props.nonce}>
				.resource-inline {
					color: rebeccapurple;
				}
			</style>
		</section>
	};
}

export function ResourceHost(props: { Boundary: typeof ResourceRemote; nonce: string }) @{
	preinit('/shared.css', { as: 'style', precedence: 'host', nonce: props.nonce });
	const Boundary = props.Boundary;
	<main>
		<Boundary label="remote" nonce={props.nonce} />
	</main>
}

export function ResourcePair(props: { Boundary: typeof ResourceRemote; nonce: string }) @{
	const Boundary = props.Boundary;
	<main>
		<Boundary label="first" nonce={props.nonce} />
		<Boundary label="second" nonce={props.nonce} />
	</main>
}

export function ResourceStreamingHost(props: {
	Boundary: typeof ResourceRemote;
	nonce: string;
	publisherNonce?: string;
}) @{
	preinit('/shared.css', { as: 'style', precedence: 'host', nonce: props.nonce });
	const Boundary = props.Boundary;
	<main>
		<Suspense fallback={<p>{'Waiting for resource publisher'}</p>}>
			<Boundary label="remote" nonce={props.publisherNonce ?? props.nonce} />
		</Suspense>
	</main>
}

export function ResourceInlineHost(props: { Boundary: typeof ResourceRemote; nonce: string }) @{
	const Boundary = props.Boundary;
	<main>
		<style href="/shared.css" precedence="host-inline" nonce={props.nonce}>
			.host-inline {
				color: blue;
			}
		</style>
		<Boundary label="remote" nonce={props.nonce} />
	</main>
}

export function ResourceGroupedRemote(props: { label: string; nonce: string }) @{
	preinit('/group-a-first.css', { as: 'style', precedence: 'a', nonce: props.nonce });
	preinit('/group-b-first.css', { as: 'style', precedence: 'b', nonce: props.nonce });
	preinit('/group-a-last.css', { as: 'style', precedence: 'a', nonce: props.nonce });
	<article data-resource={props.label}>{props.label as string}</article>
}

export function ResourceGroupedHost(props: { Boundary: typeof ResourceRemote; nonce: string }) @{
	preinit('/host-a.css', { as: 'style', precedence: 'a', nonce: props.nonce });
	preinit('/host-c.css', { as: 'style', precedence: 'c', nonce: props.nonce });
	const Boundary = props.Boundary;
	<main>
		<Boundary label="grouped" nonce={props.nonce} />
	</main>
}

export function createPendingResourceRemote(
	promise: Promise<void>,
	onAttempt: () => void,
	onPending: () => void,
) {
	let pending = true;
	promise.then(() => {
		pending = false;
	});
	function PendingContent(props: { label: string; nonce: string }) @{
		if (pending) {
			preinit('/abandoned-attempt.css', { as: 'style', precedence: 'attempt', nonce: props.nonce });
			onAttempt();
		}
		use(promise);
		<ResourceRemote label={props.label} nonce={props.nonce} />
	}
	function PendingFallback(props: { nonce: string }) @{
		onPending();
		preinit('/abandoned-fallback.css', { as: 'style', precedence: 'pending', nonce: props.nonce });
		<p>{'Publisher pending'}</p>
	}
	return function PendingResourceRemote(props: { label: string; nonce: string }) @{
		<Suspense fallback={<PendingFallback nonce={props.nonce} />}>
			<PendingContent label={props.label} nonce={props.nonce} />
		</Suspense>
	};
}
