// Strong effect lifecycle proofs. The Strong visitor owns execution phases and
// state provenance; this policy answers which platform calls run their callback
// before the next paint. Identity comes from the shared lexical analysis, never
// from spelling. Nothing here annotates the parser tree or changes emitted code.

const TRANSPARENT = new Set([
	'ChainExpression',
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSInstantiationExpression',
	'TSNonNullExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
]);
const CONTINUATIONS = new Set(['then', 'catch', 'finally']);
// `window`, `self` and `globalThis` name one object in a browser.
const GLOBAL_OBJECTS = new Set(['window', 'self', 'globalThis']);
const UNKNOWN = Symbol('unknown');

function unwrap(node) {
	while (node && TRANSPARENT.has(node.type)) node = node.expression;
	return node;
}

function memberName(member) {
	if (member.computed !== true)
		return member.property?.type === 'Identifier' ? member.property.name : null;
	const property = unwrap(member.property);
	return property?.type === 'Literal' && typeof property.value === 'string' ? property.value : null;
}

function lookup(scope, name) {
	for (let current = scope; current; current = current.parent) {
		const binding = current.bindings.get(name);
		if (binding !== undefined) return binding;
	}
	return null;
}

/**
 * @param {object} config
 * @param {object} config.analysis Shared lexical analysis from analyzeStrongHookBindings.
 * @param {Map<object, string>} config.callNames Canonical Octane names for authored calls.
 * @param {(code: string, node: object, message: string) => void} config.report
 */
export function createStrongEffectPolicy({ ast, analysis, callNames, report }) {
	const { nodeScopes, declarators } = analysis;
	let declaratorInfo = null;
	// undefined: not an analyzed reference; null: an unshadowed global.
	function bindingOf(identifier) {
		const scope = nodeScopes.get(identifier);
		return scope === undefined ? undefined : lookup(scope, identifier.name);
	}

	function declarator(binding) {
		if (declaratorInfo === null) {
			declaratorInfo = new Map();
			const collect = (pattern, decl, kind, path) => {
				if (pattern?.type === 'Identifier') {
					const scope = nodeScopes.get(decl);
					const binding = scope && lookup(scope, pattern.name);
					if (binding) declaratorInfo.set(binding, { decl, kind, path, pattern });
				} else if (pattern?.type === 'ObjectPattern' && path.length === 0) {
					for (const property of pattern.properties ?? []) {
						if (property.type !== 'Property') continue;
						const key = property.computed
							? unwrap(property.key)?.type === 'Literal'
								? unwrap(property.key).value
								: null
							: property.key?.name;
						if (typeof key === 'string') collect(property.value, decl, kind, [key]);
					}
				}
			};
			for (const { decl, kind } of declarators) collect(decl.id, decl, kind, []);
		}
		return declaratorInfo.get(binding) ?? null;
	}

	// The initializer of a binding that always holds it: const, or never reassigned.
	function stableInit(binding) {
		if (binding == null || binding.reassigned) return null;
		const info = declarator(binding);
		return info === null || info.path.length !== 0 ? null : unwrap(info.decl.init);
	}

	function stableInitOf(expression) {
		const node = unwrap(expression);
		return node?.type === 'Identifier' ? stableInit(bindingOf(node)) : null;
	}

	// A canonical source key for a receiver, handle, or handler. Stable aliases
	// resolve to what they alias, so `const el = ref.current` names `ref.current`.
	function keyOf(expression, depth = 0) {
		const node = unwrap(expression);
		if (node?.type === 'Identifier') {
			const binding = bindingOf(node);
			if (binding === undefined) return null;
			if (binding === null) return GLOBAL_OBJECTS.has(node.name) ? 'g:window' : `g:${node.name}`;
			if (!binding.reassigned && depth < 8) {
				const info = declarator(binding);
				const init = info === null ? null : unwrap(info.decl.init);
				if (init?.type === 'Identifier' || init?.type === 'MemberExpression') {
					const base = keyOf(init, depth + 1);
					if (base !== null) return info.path.length === 0 ? base : `${base}.${info.path[0]}`;
				}
			}
			return `b${binding.id}`;
		}
		if (node?.type === 'MemberExpression') {
			const property = memberName(node);
			const object = property === null ? null : keyOf(node.object, depth);
			if (object === null) return null;
			if (object === 'g:window') return GLOBAL_OBJECTS.has(property) ? object : `g:${property}`;
			return `${object}.${property}`;
		}
		return null;
	}

	function staticValue(expression, depth = 0) {
		const node = unwrap(expression);
		if (node?.type === 'Literal') return node.value;
		if (node?.type === 'Identifier') {
			if (node.name === 'undefined' && bindingOf(node) === null) return undefined;
			return depth < 8 ? staticValue(stableInitOf(node), depth + 1) : UNKNOWN;
		}
		if (node?.type === 'UnaryExpression') {
			if (node.operator === 'void') return undefined;
			const argument = staticValue(node.argument, depth);
			if (argument === UNKNOWN) return UNKNOWN;
			if (node.operator === '!') return !argument;
			if (node.operator === '-' && typeof argument === 'number') return -argument;
			if (node.operator === '+' && typeof argument === 'number') return argument;
		}
		return UNKNOWN;
	}

	// Values that are never thenables: awaiting one resumes in a microtask.
	function nonPromise(expression, depth = 0) {
		const node = unwrap(expression);
		if (node == null) return true;
		switch (node.type) {
			case 'Literal':
			case 'TemplateLiteral':
			case 'UnaryExpression':
			case 'UpdateExpression':
			case 'BinaryExpression':
			case 'ArrowFunctionExpression':
			case 'FunctionExpression':
			case 'ClassExpression':
			case 'ArrayExpression':
			// Awaiting unwraps thenables, so an await result is never one.
			case 'AwaitExpression':
				return true;
			case 'ObjectExpression':
				return (node.properties ?? []).every(
					(property) =>
						property.type === 'Property' &&
						property.computed !== true &&
						(property.key?.name ?? property.key?.value) !== 'then',
				);
			case 'Identifier': {
				if (node.name === 'undefined' && bindingOf(node) === null) return true;
				const init = depth < 8 ? stableInitOf(node) : null;
				return init !== null && nonPromise(init, depth + 1);
			}
			case 'SequenceExpression':
				return nonPromise(node.expressions?.at(-1), depth);
			case 'ConditionalExpression':
				return nonPromise(node.consequent, depth) && nonPromise(node.alternate, depth);
			case 'LogicalExpression':
				return nonPromise(node.left, depth) && nonPromise(node.right, depth);
			default:
				return false;
		}
	}

	// A promise that settles without waiting on anything else.
	function zeroDelayPromise(expression, depth = 0) {
		const node = unwrap(expression);
		switch (node?.type) {
			case 'Identifier':
				return depth < 8 && zeroDelayPromise(stableInitOf(node), depth + 1);
			case 'SequenceExpression':
				return zeroDelayPromise(node.expressions?.at(-1), depth);
			case 'ConditionalExpression':
				return zeroDelayPromise(node.consequent, depth) && zeroDelayPromise(node.alternate, depth);
			case 'LogicalExpression':
				return zeroDelayPromise(node.left, depth) && zeroDelayPromise(node.right, depth);
			case 'CallExpression': {
				const callee = unwrap(node.callee);
				if (callee?.type !== 'MemberExpression' || keyOf(callee.object) !== 'g:Promise')
					return false;
				const method = memberName(callee);
				if (method === 'reject') return true;
				return method === 'resolve' && nonPromise(node.arguments?.[0]);
			}
			default:
				return false;
		}
	}

	// Awaiting a settled value resumes in a microtask, before the next paint.
	function settled(expression, depth = 0) {
		const node = unwrap(expression);
		switch (node?.type) {
			case 'SequenceExpression':
				return settled(node.expressions?.at(-1), depth);
			case 'ConditionalExpression':
				return settled(node.consequent, depth) && settled(node.alternate, depth);
			case 'LogicalExpression':
				return settled(node.left, depth) && settled(node.right, depth);
			case 'Identifier': {
				const init = depth < 8 ? stableInitOf(node) : null;
				if (init !== null) return settled(init, depth + 1);
			}
		}
		return nonPromise(node, depth) || zeroDelayPromise(node, depth);
	}

	function globalFunction(callee) {
		const node = unwrap(callee);
		const key = keyOf(node);
		return key?.startsWith('g:') && !key.includes('.') ? key.slice(2) : null;
	}

	function zeroDelay(expression) {
		if (expression == null) return true;
		const value = staticValue(expression);
		if (value === UNKNOWN || (value !== null && typeof value === 'object')) return false;
		const delay = typeof value === 'bigint' || typeof value === 'symbol' ? NaN : Number(value);
		return !(delay > 0);
	}

	return {
		// Callbacks of these calls run before the browser paints, so an update
		// inside them is as synchronous as one in effect setup. 'sync' runs the
		// callback immediately; 'yield' runs it after pending microtasks.
		runsBeforePaint(node) {
			if (callNames.get(node) === 'startTransition') return 'sync';
			const callee = unwrap(node.callee);
			const name = globalFunction(callee);
			if (name === 'queueMicrotask') return 'yield';
			if (name === 'setTimeout') {
				const handler = unwrap(node.arguments?.[0]);
				return handler != null &&
					handler.type !== 'SpreadElement' &&
					node.arguments?.[1]?.type !== 'SpreadElement' &&
					typeof staticValue(handler) !== 'string' &&
					zeroDelay(node.arguments?.[1])
					? 'yield'
					: false;
			}
			return callee?.type === 'MemberExpression' &&
				CONTINUATIONS.has(memberName(callee)) &&
				zeroDelayPromise(callee.object)
				? 'yield'
				: false;
		},
		zeroDelayAwait(argument) {
			return settled(argument);
		},
	};
}
