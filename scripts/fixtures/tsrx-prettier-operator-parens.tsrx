// Formatter fixture for parentheses the TSRX Prettier plugin used to drop,
// which printed code that no longer parsed: `a ?? (b && c)` became
// `a ?? b && c`, and `() => ({ ...o }) instanceof Map` became
// `() => { ...o } instanceof Map`. `pnpm format:check` must leave this file
// byte-identical, and scripts/tsrx-prettier-plugin.test.mjs checks that
// formatting keeps its AST.

type Access = { override?: boolean; admin: boolean; owner: boolean };

function canEdit(access: Access): boolean {
	return access.override ?? (access.admin || access.owner);
}

function isVisible(hidden: boolean | null, active: boolean, pinned: boolean): boolean {
	return (hidden && active) ?? pinned;
}

function labelFor(explicit: string | null, derived: string | null, fallback: string): string {
	return (explicit || derived) ?? fallback;
}

const kindOf = (value: object) => ({ ...value }) instanceof Map ? 'map' : 'object';

function announce(ready: boolean) {
	({ ready }) instanceof Object && console.log('ready');
	(function log(strings: TemplateStringsArray) {
		console.log(strings.raw.join(''));
	})`announced`;
}

export function Badge(props: { label?: string; count: number | null; muted: boolean }) @{
	<span class={props.label ?? (props.muted && 'muted')}>{(props.count || null) ?? 0}</span>
}

export { announce, canEdit, isVisible, kindOf, labelFor };
