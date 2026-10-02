// Reading a module-level `let` keeps these hookless calls lite in the
// production compile too, where auto-memo would otherwise give them full slots.
let label = 'p';

function Pair() @{
	<>
		<p>{label as string}</p>
		<i>{'i' as string}</i>
	</>
}

function Em() @{
	<em>{'e' as string}</em>
}

// A dynamic text root between the fragment's elements.
function Spaced() @{
	<>
		<p>{label as string}</p>
		{label as string}
		<i>{'i' as string}</i>
	</>
}

// Renders no template of its own: each call adopts in place in turn.
function Wrapper() @{
	<>
		<Pair />
		<Em />
	</>
}

function Empty() @{
	<></>
}

// Renders no template of its own: its first call renders nothing, and its arm
// adopts the server node in place.
function Shell() @{
	<>
		<Empty />
		@if (label !== '') {
			<em>{label as string}</em>
		}
	</>
}

// Each client arm renders a fragment component, then another component. The
// server rendered the other arm, which has no component range around the
// fragment's roots.
export function PairArms(props: { on: boolean }) @{
	<div id="r">
		@if (props.on) {
			<>
				<Pair />
				<Em />
			</>
		} @else {
			<>
				<p>{label as string}</p>
				<i>{'i' as string}</i>
				<Em />
			</>
		}
	</div>
}

export function SpacedArms(props: { on: boolean }) @{
	<div id="r">
		@if (props.on) {
			<>
				<Spaced />
				<Em />
			</>
		} @else {
			<>
				<p>{label as string}</p>
				{label as string}
				<i>{'i' as string}</i>
				<Em />
			</>
		}
	</div>
}

export function WrapperArms(props: { on: boolean }) @{
	<div id="r">
		@if (props.on) {
			<>
				<Wrapper />
				<Em />
			</>
		} @else {
			<>
				<p>{label as string}</p>
				<i>{'i' as string}</i>
				<em>{'e' as string}</em>
				<Em />
			</>
		}
	</div>
}

export function ShellArms(props: { on: boolean }) @{
	<div id="r">
		@if (props.on) {
			<>
				<Shell />
				<Em />
			</>
		} @else {
			<>
				<em>{label as string}</em>
				<Em />
			</>
		}
	</div>
}

// The server's arm starts with another element.
export function OtherArms(props: { on: boolean }) @{
	<div id="r">
		@if (props.on) {
			<>
				<Pair />
				<Em />
			</>
		} @else {
			<>
				<s>{label as string}</s>
				<i>{'i' as string}</i>
				<Em />
			</>
		}
	</div>
}
