// Strong state purity checks that share the Strong visitor's lexical bindings
// and execution phases: immutable state values in every phase.
// Like the other Strong policies, this never annotates the parser tree or
// changes the code emitted for a valid module.

export const STRONG_SNAPSHOT_MUTATION = 'OCTANE_STRONG_SNAPSHOT_MUTATION';

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const ARRAY_MUTATORS = new Set([
	'copyWithin',
	'fill',
	'pop',
	'push',
	'reverse',
	'shift',
	'sort',
	'splice',
	'unshift',
]);
const COLLECTION_MUTATORS = new Map([
	['Map', new Set(['set', 'delete', 'clear'])],
	['Set', new Set(['add', 'delete', 'clear'])],
]);
const MUTATOR_METHODS = new Set([...ARRAY_MUTATORS, 'set', 'add', 'delete', 'clear']);
// The first argument is written in place. `Object`/`Reflect` must be the
// unshadowed standard globals for this to be a proof.
const TARGET_MUTATORS = new Map([
	['Object', new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'])],
	['Reflect', new Set(['set', 'deleteProperty', 'defineProperty', 'setPrototypeOf'])],
]);

export const SNAPSHOT_MUTATION_MESSAGE =
	'Strong mode does not allow mutating a state value outside render. Passing the same object back to its setter does not re-render, and the change rewrites the snapshot that transitions and useOptimistic revert to. Pass a new value instead, for example setItems([...items, item]) or setItems((current) => [...current, item]). Keep mutable objects in useRef.';

/**
 * @param {{
 *   resolve: (scope: any, name: string) => any,
 *   unwrap: (node: any) => any,
 *   snapshotBinding: (node: any, scope: any) => any,
 *   staticPrimitiveValue: (node: any, scope: any) => any,
 * }} api
 */
export function createStrongStatePolicy(api) {
	const { resolve, unwrap, snapshotBinding, staticPrimitiveValue } = api;

	function unshadowed(node, scope, names) {
		const value = unwrap(node);
		return value?.type === 'Identifier' &&
			names.has(value.name) &&
			resolve(scope, value.name) === null
			? value.name
			: null;
	}

	function literalShape(node, scope) {
		const value = unwrap(node);
		if (value?.type === 'ArrayExpression' || value?.type === 'ObjectExpression') {
			return { node: value, scope };
		}
		if (value?.type === 'NewExpression' && unshadowed(value.callee, scope, SHAPE_CONSTRUCTORS)) {
			return { node: value, scope };
		}
		return null;
	}

	function shapeKind(shape) {
		const node = shape?.node;
		if (node?.type === 'ArrayExpression') return 'array';
		if (node?.type === 'NewExpression') {
			const name = unwrap(node.callee).name;
			return name === 'Array' ? 'array' : name;
		}
		return node?.type === 'ObjectExpression' ? 'object' : null;
	}

	function propertyKey(property, scope) {
		if (property.computed) return staticPrimitiveValue(property.key, scope);
		return property.key?.type === 'Identifier' ? property.key.name : property.key?.value;
	}

	return {
		/**
		 * State initialized with a literal keeps that literal as a structural
		 * proof for known mutator methods, including nested literal properties.
		 */
		initialShape(hook, node, scope) {
			if (hook === 'useState') {
				const initial = unwrap(node.arguments?.[0]);
				if (!FUNCTIONS.has(initial?.type)) return literalShape(initial, scope);
				const body = initial.body;
				if (body?.type !== 'BlockStatement') return literalShape(body, scope);
				return body.body?.length === 1 && body.body[0].type === 'ReturnStatement'
					? literalShape(body.body[0].argument, scope)
					: null;
			}
			if (hook === 'useReducer' && node.arguments?.length === 2) {
				return literalShape(node.arguments[1], scope);
			}
			return null;
		},

		memberShape(shape, key) {
			if (shape?.node.type !== 'ObjectExpression') return null;
			const properties = shape.node.properties ?? [];
			for (let index = properties.length - 1; index >= 0; index--) {
				const property = properties[index];
				// A later spread may replace the property.
				if (property.type !== 'Property') return null;
				if (propertyKey(property, shape.scope) === key) {
					return property.kind !== 'init' || property.method === true
						? null
						: literalShape(property.value, shape.scope);
				}
			}
			return null;
		},

		shapeIsArray(shape) {
			return shapeKind(shape) === 'array';
		},

		/** The node naming a provable in-place write to a state value, or null. */
		snapshotMutation(callee, args, scope) {
			const member = unwrap(callee);
			if (member?.type !== 'MemberExpression') return null;
			const method = member.computed
				? staticPrimitiveValue(member.property, scope)
				: member.property?.name;
			const receiver = unwrapIdentifierName(unwrap(member.object));
			const targets = TARGET_MUTATORS.get(receiver);
			if (targets?.has(method) && resolve(scope, receiver) === null) {
				return args?.[0] != null && snapshotBinding(args[0], scope) !== null ? member : null;
			}
			if (!MUTATOR_METHODS.has(method)) return null;
			const snapshot = snapshotBinding(member.object, scope);
			if (snapshot === null) return null;
			const kind = snapshot.array === true ? 'array' : shapeKind(snapshot.shape);
			if (kind === 'array') return ARRAY_MUTATORS.has(method) ? member : null;
			return COLLECTION_MUTATORS.get(kind)?.has(method) ? member : null;
		},
	};
}

const SHAPE_CONSTRUCTORS = new Set(['Map', 'Set', 'Array']);

function unwrapIdentifierName(node) {
	return node?.type === 'Identifier' ? node.name : null;
}
