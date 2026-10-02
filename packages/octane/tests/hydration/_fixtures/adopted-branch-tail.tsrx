import type { ComponentBody } from 'octane';

function label(): string {
	return 'ok';
}

function Leaf() @{
	<i>{label() as string}</i>
}

function Bold() @{
	<b>{'b'}</b>
}

function Strike() @{
	<s>{'s'}</s>
}

// Each branch renders its `@else` arm on the client. The server renders the
// `@if` arm, whose content starts with what the `@else` arm renders and ends
// with a stale tail, so the client adopts the arm's range and leaves the tail.
export function SoleComponent(props: { server?: boolean }) @{
	<div>
		@if (props.server) {
			<>
				<Leaf />
				<s class="foreign">{'f'}</s>
			</>
		} @else {
			<Leaf />
		}
	</div>
}

export function SingleRoot(props: { server?: boolean }) @{
	<div>
		@if (props.server) {
			<>
				<i>{label() as string}</i>
				<s class="foreign">{'f'}</s>
			</>
		} @else {
			<i>{label() as string}</i>
		}
	</div>
}

// The stale tail ends with the same tag as the client's last root.
export function StaticFragment(props: { server?: boolean }) @{
	<div>
		@if (props.server) {
			<>
				<i>{label() as string}</i>
				<b>{'b'}</b>
				<s class="foreign">{'f'}</s>
				<b class="foreign">{'b'}</b>
			</>
		} @else {
			<>
				<i>{label() as string}</i>
				<b>{'b'}</b>
			</>
		}
	</div>
}

export function HoleFragment(props: { server?: boolean }) @{
	<div>
		@if (props.server) {
			<>
				<i>{label() as string}</i>
				<Bold />
				<s class="foreign">{'f'}</s>
			</>
		} @else {
			<>
				<i>{label() as string}</i>
				<Bold />
			</>
		}
	</div>
}

export function SwitchBranch(props: { server?: boolean }) @{
	<div>
		@switch (props.server ? 'server' : 'client') {
			@case 'server': {
				<>
					<i>{label() as string}</i>
					<s class="foreign">{'f'}</s>
				</>
			}
			@default: {
				<i>{label() as string}</i>
			}
		}
	</div>
}

// Both sides render the outer `@if` arm; only the inner arm leaves a tail.
export function NestedBranch(props: { server?: boolean }) @{
	<div>
		@if (true) {
			<>
				<Leaf />
				@if (props.server) {
					<>
						<b>{'b'}</b>
						<s class="foreign">{'f'}</s>
					</>
				} @else {
					<b>{'b'}</b>
				}
				<u>{'u'}</u>
			</>
		}
	</div>
}

// Only the outer arm leaves a tail, after an inner branch both sides render.
export function OuterBranch(props: { server?: boolean }) @{
	<div>
		@if (props.server) {
			<>
				<Leaf />
				@if (true) {
					<b>{'b'}</b>
				}
				<u>{'u'}</u>
				<s class="foreign">{'f'}</s>
			</>
		} @else {
			<>
				<Leaf />
				@if (true) {
					<b>{'b'}</b>
				}
				<u>{'u'}</u>
			</>
		}
	</div>
}

// The client's last component finds the server's `<s>` where it expects its
// range and adopts it without one. That `<s>` is client content now.
export function UnframedComponent(props: { server?: boolean }) @{
	<div>
		@if (props.server) {
			<>
				<Bold />
				<s>{'s'}</s>
				<u class="foreign">{'tail'}</u>
			</>
		} @else {
			<>
				<Bold />
				<Strike />
			</>
		}
	</div>
}

// A module binding that these components read: the production compile then
// renders their calls through the lite component slot, as development does.
let word = 'w';

function Pair() @{
	<>
		<i>{word as string}</i>
		<em>{'e'}</em>
	</>
}

function Trio() @{
	<>
		<i>{word as string}</i>
		<em>{'e'}</em>
		<small>{'m'}</small>
	</>
}

function Word() @{
	<>
		{word as string}
	</>
}

// The client's last component finds the server's `<i>` and `<em>` where it
// expects its range and adopts both, the roots of its fragment, without one.
// The server's `<u>` after them is the tail.
export function UnframedFragment(props: { server?: boolean }) @{
	<div>
		@if (props.server) {
			<>
				<Bold />
				<i>{'w'}</i>
				<em>{'e'}</em>
				<u class="foreign">{'tail'}</u>
			</>
		} @else {
			<>
				<Bold />
				<Pair />
			</>
		}
	</div>
}

// The same, for a component whose fragment is one text root.
export function UnframedText(props: { server?: boolean }) @{
	<div>
		@if (props.server) {
			<>
				<Bold />
				{'w'}
				<u class="foreign">{'tail'}</u>
			</>
		} @else {
			<>
				<Bold />
				<Word />
			</>
		}
	</div>
}

// The component after one that adopted a fragment in place claims its own
// server range.
export function UnframedFragmentSibling(props: { server?: boolean }) @{
	<div>
		@if (props.server) {
			<>
				<Bold />
				<i>{'w'}</i>
				<em>{'e'}</em>
				<Strike />
			</>
		} @else {
			<>
				<Bold />
				<Pair />
				<Strike />
			</>
		}
	</div>
}

// The server's arm ends after the first of the fragment's three roots, which
// adopts the arm's last node, and Strike finds the arm's end.
export function UnframedFragmentPastRange(props: { server?: boolean }) @{
	<div>
		@if (props.server) {
			<>
				<Bold />
				<i>{'w'}</i>
			</>
		} @else {
			<>
				<Bold />
				<Trio />
				<Strike />
			</>
		}
		<u>{'after'}</u>
	</div>
}

function Slot(props: { render: ComponentBody }) @{
	const Render = props.render;
	<section>
		<Render />
	</section>
}

// The branch sits in a template that a helper passed as a render prop returns.
export function HelperFragment(props: { server?: boolean }) @{
	const render = () => @{
		<div>
			@if (props.server) {
				<>
					<i>{label() as string}</i>
					<b>{'b'}</b>
					<s class="foreign">{'f'}</s>
				</>
			} @else {
				<>
					<i>{label() as string}</i>
					<b>{'b'}</b>
				</>
			}
		</div>
	};
	<Slot render={render} />
}
