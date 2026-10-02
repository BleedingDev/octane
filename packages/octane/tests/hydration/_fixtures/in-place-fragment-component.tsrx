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

function Holed(props: { x: string }) @{
	<>
		<p>{label as string}</p>
		{props.x}
	</>
}

// Each client arm calls hookless components whose server ranges are missing:
// the server rendered the other arm, without ranges, in their place.

// The server's arm ends before Pair's second root.
export function Short(props: { on: boolean }) @{
	<div>
		@if (props.on) {
			<>
				<Pair />
				<Em />
			</>
		} @else {
			<>
				<p>{label as string}</p>
			</>
		}
	</div>
}

// The server's arm differs at Pair's second root.
export function Differs(props: { on: boolean }) @{
	<div>
		@if (props.on) {
			<>
				<Pair />
				<Em />
			</>
		} @else {
			<>
				<p>{label as string}</p>
				<b>{'b' as string}</b>
				<em>{'e' as string}</em>
			</>
		}
	</div>
}

// The server's arm ends where Holed's trailing hole starts.
export function HoleShort(props: { on: boolean; x: string }) @{
	<div>
		@if (props.on) {
			<Holed x={props.x} />
		} @else {
			<>
				<p>{label as string}</p>
			</>
		}
	</div>
}

// The server's arm has the same roots, so the components adopt them.
export function Same(props: { on: boolean }) @{
	<div>
		@if (props.on) {
			<>
				<Pair />
				<Em />
			</>
		} @else {
			<>
				<p>{label as string}</p>
				<i>{'i' as string}</i>
				<em>{'e' as string}</em>
			</>
		}
	</div>
}

export function HoleSame(props: { on: boolean; x: string }) @{
	<div>
		@if (props.on) {
			<Holed x={props.x} />
		} @else {
			<>
				<p>{label as string}</p>
				{props.x}
			</>
		}
	</div>
}
