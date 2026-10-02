import { Hydrate } from 'octane';
import { interaction } from 'octane/hydration';
import { query$, signal$ } from 'octane/signals';

interface DeferredStreamProps {
	load: (key: string) => AsyncIterable<string>;
	onClick: () => void;
	onHydrated: () => void;
}

export function DeferredStream(props: DeferredStreamProps) @{
	const value$ = query$(() => 'message', props.load, { kind: 'stream' });
	<Hydrate when={interaction({ events: 'click' })} onHydrated={props.onHydrated}>
		@try {
			<button id="deferred-signal" onClick={props.onClick}>{value$.get() as string}</button>
		} @pending {
			<span id="deferred-pending">{'Waiting'}</span>
		} @catch {
			<span id="deferred-error">{'Failed'}</span>
		}
	</Hydrate>
}

interface CounterProps {
	label: string;
	show: boolean;
}

export function Counter(props: CounterProps) @{
	const count$ = signal$(0);
	<section data-counter={props.label}>
		<button data-action="direct" onClick={() => count$.set(count$.get() + 1)}>{'Add'}</button>
		<output data-value="direct">{String(count$.get())}</output>
		@if (props.show) {
			<div>
				<button
					data-action="nested"
					onClick={() => count$.set(count$.get() + 1)}
				>{'Add nested'}</button>
				<output data-value="nested">{String(count$.get())}</output>
			</div>
		}
	</section>
}

export function ComponentCounters(props: { showFirst: boolean }) @{
	<main>
		<Counter label="first" show={props.showFirst} />
		<Counter label="second" show={true} />
	</main>
}

interface CounterViewProps extends CounterProps {
	read: () => string;
	bump: () => void;
}

function CounterView(props: CounterViewProps) @{
	<section data-counter={props.label}>
		<button data-action="direct" onClick={props.bump}>{'Add'}</button>
		<output data-value="direct">{props.read() as string}</output>
		@if (props.show) {
			<div>
				<button data-action="nested" onClick={props.bump}>{'Add nested'}</button>
				<output data-value="nested">{props.read() as string}</output>
			</div>
		}
	</section>
}

export function CallbackCounters(props: { showFirst: boolean }) @{
	const count$ = signal$(0);
	<main>
		<CounterView
			label="first"
			show={props.showFirst}
			read={() => String(count$.get())}
			bump={() => count$.set(count$.get() + 1)}
		/>
		<CounterView
			label="second"
			show={true}
			read={() => String(count$.get())}
			bump={() => count$.set(count$.get() + 1)}
		/>
	</main>
}

export function KeyedCounters(props: { items: CounterProps[] }) @{
	<main>
		@for (const item of props.items; key item.label) {
			<Counter label={item.label} show={item.show} />
		}
	</main>
}
