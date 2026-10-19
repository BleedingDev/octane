import { createContext, Suspense, useContext, useId } from 'octane';

export const SnapshotTheme = createContext('default theme');

export function SnapshotRemote(props: { label: string }) @{
	const theme = useContext(SnapshotTheme);
	const id = useId();
	<article id={id} class="snapshot-remote">
		<title>{props.label as string}</title>
		<p>{props.label as string}</p>
		<output>{theme as string}</output>
		<style>
			.snapshot-remote {
				color: rebeccapurple;
			}
		</style>
	</article>
}

export function SnapshotHost(props: {
	Boundary: typeof SnapshotRemote;
	label: string;
	theme?: string;
}) @{
	const Boundary = props.Boundary;
	const id = useId();
	<SnapshotTheme value={props.theme ?? 'host theme'}>
		<main id={id}>
			<Boundary label={props.label} />
		</main>
	</SnapshotTheme>
}

export function SnapshotPair(props: { Boundary: typeof SnapshotRemote }) @{
	const Boundary = props.Boundary;
	<SnapshotTheme value="pair theme">
		<section>
			<Boundary label="first publisher" />
			<Boundary label="second publisher" />
		</section>
	</SnapshotTheme>
}

export function SnapshotPlain() @{
	<p>{'Plain native SSR'}</p>
}

export function SnapshotStreamingHost(props: { Boundary: typeof SnapshotRemote; label: string }) @{
	const Boundary = props.Boundary;
	<SnapshotTheme value="stream theme">
		<main>
			<Suspense fallback={<p>{'Waiting for publisher'}</p>}>
				<Boundary label={props.label} />
			</Suspense>
		</main>
	</SnapshotTheme>
}

export function createNestedSnapshotRemote(Child: typeof SnapshotRemote) {
	return function NestedSnapshotRemote(props: { label: string }) @{
		<section>
			<p>{props.label as string}</p>
			<Child label="Nested publisher" />
		</section>
	};
}
