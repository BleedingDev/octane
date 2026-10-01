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
const SKIP_KEYS = new Set([
	'type',
	'start',
	'end',
	'loc',
	'range',
	'parent',
	'metadata',
	'comments',
	'tokens',
	'typeAnnotation',
	'returnType',
	'typeParameters',
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

function functionScopeOf(scope) {
	let current = scope;
	while (current && current.kind !== 'function' && current.kind !== 'module')
		current = current.parent;
	return current;
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
					if (base !== null) return info.path.length === 0 ? base : memberKey(base, info.path[0]);
				}
			}
			return `b${binding.id}`;
		}
		if (node?.type === 'MemberExpression') {
			const property = memberName(node);
			const object = property === null ? null : keyOf(node.object, depth);
			return object === null ? null : memberKey(object, property);
		}
		return null;
	}

	// A property of the global object names the global itself, whether it is
	// read as `window.name` or destructured as `const { name } = window`.
	function memberKey(object, property) {
		if (object === 'g:window') return GLOBAL_OBJECTS.has(property) ? object : `g:${property}`;
		return `${object}.${property}`;
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

	// The operand a conditional or logical expression evaluates to when its
	// test or left operand is a known value, as in `null && pending`.
	function selected(node) {
		if (node.type === 'ConditionalExpression') {
			const test = staticValue(node.test);
			return test === UNKNOWN ? null : test ? node.consequent : node.alternate;
		}
		const left = staticValue(node.left);
		if (left === UNKNOWN) return null;
		const keepsLeft =
			node.operator === '??' ? left != null : node.operator === '&&' ? !left : Boolean(left);
		return keepsLeft ? node.left : node.right;
	}

	// Some value a conditional or logical expression can evaluate to passes `check`.
	function someResult(node, check, depth) {
		const only = selected(node);
		if (only !== null) return check(only, depth);
		return node.type === 'ConditionalExpression'
			? check(node.consequent, depth) || check(node.alternate, depth)
			: check(node.left, depth) || check(node.right, depth);
	}

	// Awaiting the value may resume in a microtask, before the next paint: some
	// value it can evaluate to is a non-thenable or an already settled promise.
	function maySettle(expression, depth = 0) {
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
				const binding = bindingOf(node);
				if (node.name === 'undefined' && binding === null) return true;
				if (binding != null && !varInitialized(binding, node)) return true;
				const init = depth < 8 ? stableInitOf(node) : null;
				return init !== null && maySettle(init, depth + 1);
			}
			case 'SequenceExpression':
				return maySettle(node.expressions?.at(-1), depth);
			case 'ConditionalExpression':
			case 'LogicalExpression':
				return someResult(node, maySettle, depth);
			case 'CallExpression':
				return settledPromise(node);
			default:
				return false;
		}
	}

	// Where a `var` declarator has run on every path: the rest of the statement
	// list that holds it, the body of a loop whose head declares it, or the rest
	// of a `for` statement whose initializer does. Module code finishes before
	// any component runs. Elsewhere a hoisted `var` may still be undefined.
	let varRegions = null;
	function varInitialized(binding, reference) {
		const info = declarator(binding);
		if (info?.kind !== 'var') return true;
		if (varRegions === null) {
			varRegions = new Map();
			const mark = (statement, start, end) => {
				// `export var` declares in the module like a bare `var`.
				const declaration =
					statement?.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
				if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'var') return;
				for (const decl of declaration.declarations ?? []) {
					varRegions.set(decl, [start ?? decl.end, end]);
				}
			};
			const visit = (node) => {
				if (node == null || typeof node !== 'object') return;
				if (Array.isArray(node)) {
					for (const child of node) visit(child);
					return;
				}
				const list =
					node.type === 'SwitchCase'
						? node.consequent
						: Array.isArray(node.body)
							? node.body
							: null;
				if (list !== null) {
					for (const statement of list) {
						mark(statement, node.type === 'Program' ? node.start : null, node.end);
					}
				}
				if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
					mark(node.left, node.body?.start, node.body?.end);
				} else if (node.type === 'ForStatement') {
					mark(node.init, null, node.end);
				}
				for (const key in node) {
					if (!SKIP_KEYS.has(key) && !key.startsWith('_octane')) visit(node[key]);
				}
			};
			visit(ast);
		}
		const region = varRegions.get(info.decl);
		return region !== undefined && reference.start >= region[0] && reference.end <= region[1];
	}

	// A promise that may settle without waiting on anything else.
	function maySettlePromise(expression, depth = 0) {
		const node = unwrap(expression);
		switch (node?.type) {
			case 'Identifier':
				return depth < 8 && maySettlePromise(stableInitOf(node), depth + 1);
			case 'SequenceExpression':
				return maySettlePromise(node.expressions?.at(-1), depth);
			case 'ConditionalExpression':
			case 'LogicalExpression':
				return someResult(node, maySettlePromise, depth);
			case 'CallExpression':
				return settledPromise(node);
			default:
				return false;
		}
	}

	function settledPromise(node) {
		const callee = unwrap(node.callee);
		if (callee?.type !== 'MemberExpression' || keyOf(callee.object) !== 'g:Promise') return false;
		const method = memberName(callee);
		return method === 'reject' || (method === 'resolve' && maySettle(node.arguments?.[0]));
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
				maySettlePromise(callee.object)
				? 'yield'
				: false;
		},
		// Awaiting the argument may resume before the next paint.
		zeroDelayAwait(argument) {
			return maySettle(argument);
		},
		// The stable initializer of a binding declared in the function that reads
		// it, once that initializer has run on every path to the read: a `const`
		// or `let` by its temporal dead zone, and a hoisted `var` inside the region
		// where its declaration has run.
		localInit(expression) {
			const node = unwrap(expression);
			if (node?.type !== 'Identifier') return null;
			const scope = nodeScopes.get(node);
			const binding = bindingOf(node);
			if (scope === undefined || binding == null || binding.scope == null) return null;
			const kind = declarator(binding)?.kind;
			if (kind !== 'const' && kind !== 'let' && kind !== 'var') return null;
			if (functionScopeOf(binding.scope) !== functionScopeOf(scope)) return null;
			return varInitialized(binding, node) ? stableInit(binding) : null;
		},
		// A provably known operand value, as `{ value }`, or null.
		literal(expression) {
			const value = staticValue(expression);
			return value === UNKNOWN ? null : { value };
		},
		selected,
	};
}
