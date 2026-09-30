// Formatter fixture for `as`/`satisfies` casts whose parentheses the TSRX
// Prettier plugin used to drop, which moved the cast onto the surrounding
// operator: `'name' in (e.target as Element)` became
// `('name' in e.target) as Element`. `pnpm format:check` must leave this file
// byte-identical, and scripts/tsrx-prettier-plugin.test.mjs checks that
// formatting keeps its AST.

type Named = { name: string };

function hasName(e: Event): boolean {
	return 'name' in (e.target as Element);
}

function isNode(value: unknown, Ctor: unknown): boolean {
	return value instanceof (Ctor as typeof Node);
}

function scale(value: unknown, limit: unknown): number {
	const next = (value as number) + 1;
	if (next < (limit as number)) return 2 ** (value as number);
	return (limit as number) ** 2;
}

function clamp(value: number, max: number): number {
	return value > (max satisfies number) ? max : value;
}

async function load(request: unknown): Promise<Named> {
	return await (request as Promise<Named>);
}

function build(Base: unknown, tag: unknown, count: unknown) {
	class Widget extends (Base as typeof HTMLElement) {}
	const label = (tag as (strings: TemplateStringsArray) => string)`widget`;
	(count as number)++;
	const empty = () => ({}) as Named;
	return [new (Widget as new () => HTMLElement)(), label, empty()];
}

export function Field(props: { name?: unknown; rest: object; ready: boolean }) @{
	<label {...(props.rest as object)}>
		{props.ready && (props.name as string)}
		{('field:' + props.name) as string}
	</label>
}

export function Summary({ event }: { event: Event }) @{
	<p>{`${hasName(event)}:${isNode(event.target, Node)}:${scale(1, 2)}:${clamp(1, 2)}`}</p>
}

export { build, load };
