/**
 * Optional, Node-only TypeScript evidence for authored JSX child expressions.
 *
 * The ordinary compiler remains synchronous, browser-safe, and independent of a
 * TypeScript project. This entry owns the expensive typed virtual-TSX graph and
 * hands the compiler only source-bound, serializable ranges. Callers must keep
 * one project alive for a build, invalidate changed inputs explicitly, and use
 * the same returned facts for client and server compilation.
 */

import nodePath from 'node:path';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { version as typescriptVersion } from 'typescript';
import { API, DiagnosticCategory, TypeFlags } from 'typescript/unstable/sync';
import * as ts from 'typescript/unstable/ast';
import { FileMap, SourceMap } from '@volar/language-core';
import { normalizeRendererConfig } from './renderers.js';
import {
	TEXT_TYPE_FACTS_VERSION,
	normalizeTextTypeFilename,
	textTypeSourceVersion,
} from './text-type-facts.js';
import { compileToVolarMappings } from './volar.js';
export { validateNativeSignalNames } from './native-read-types.js';

/** @typedef {import('typescript/unstable/ast').SourceFile} SourceFile */
/** @typedef {import('typescript/unstable/sync').Project} Project */
/** @typedef {{ source: string, version: string }} SourceRecord */
/** @typedef {{ start: number, end: number, containerStart: number, containerEnd: number }} AuthoredChild */

const WALK_SKIP = new Set(['metadata', 'loc', 'parent', 'css']);

function absoluteFilename(filename, directory) {
	if (typeof filename !== 'string' || filename.length === 0) {
		throw new TypeError('Octane text type projects require a non-empty filename.');
	}
	return normalizeTextTypeFilename(
		nodePath.resolve(directory, normalizeTextTypeFilename(filename)),
	);
}

function rendererFilename(filename, directory) {
	const relative = nodePath.relative(directory, filename);
	return relative !== '..' &&
		!relative.startsWith('..' + nodePath.sep) &&
		!nodePath.isAbsolute(relative)
		? '/' + normalizeTextTypeFilename(relative)
		: filename;
}

/** Stable JSON for TypeScript's data-only compiler options, excluding its AST. */
function stableJson(value) {
	return JSON.stringify(value, (key, entry) => {
		if (key === 'configFile') return undefined;
		if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
			return Object.fromEntries(
				Object.keys(entry)
					.sort()
					.map((name) => [name, entry[name]]),
			);
		}
		return entry;
	});
}

function sourceRecord(source) {
	return {
		source,
		version: textTypeSourceVersion(source),
	};
}

function validRange(start, end, length) {
	return (
		Number.isSafeInteger(start) &&
		Number.isSafeInteger(end) &&
		start >= 0 &&
		start < end &&
		end <= length
	);
}

/**
 * Select actual authored children, not attributes, dynamic tag names, or an
 * arbitrary expression elsewhere in the module. ESTree offsets and TS offsets
 * are both half-open UTF-16 code-unit ranges.
 * @param {unknown} ast
 * @param {string} source
 * @returns {AuthoredChild[]}
 */
function authoredChildren(ast, source) {
	const children = [];
	const seen = new WeakSet();
	const visit = (node, parent, key) => {
		if (!node || typeof node !== 'object' || seen.has(node)) return;
		seen.add(node);
		if (Array.isArray(node)) {
			for (const child of node) visit(child, parent, key);
			return;
		}
		// The type-only parser preserves grouping parentheses for editor mappings;
		// the runtime parser intentionally does not. Facts name the expression the
		// runtime compiler will actually adopt, while the full container still owns
		// the exact mapping used below.
		let expression = node.expression;
		while (expression?.type === 'ParenthesizedExpression') expression = expression.expression;
		if (
			node.type === 'JSXExpressionContainer' &&
			(key === 'children' || (parent?.type === 'JSXCodeBlock' && key === 'render')) &&
			expression?.type !== 'JSXEmptyExpression' &&
			validRange(expression?.start, expression?.end, source.length) &&
			validRange(node.start, node.end, source.length) &&
			source[node.start] === '{' &&
			source[node.end - 1] === '}'
		) {
			children.push({
				start: expression.start,
				end: expression.end,
				containerStart: node.start,
				containerEnd: node.end,
			});
		}
		for (const property in node) {
			if (!WALK_SKIP.has(property)) visit(node[property], node, property);
		}
	};
	visit(ast, null, null);
	return children;
}

function isJsxChild(node) {
	return (
		ts.isJsxExpression(node) &&
		!!node.expression &&
		!node.dotDotDotToken &&
		!!node.parent &&
		(ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
	);
}

function unparenthesizedExpression(expression) {
	while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
	return expression;
}

/** @param {SourceFile} sourceFile */
function indexJsxChildren(sourceFile) {
	const children = new Map();
	const visit = (node) => {
		if (isJsxChild(node)) {
			children.set(`${node.getStart(sourceFile)}:${node.end}`, node);
		}
		node.forEachChild(visit);
	};
	visit(sourceFile);
	return children;
}

/**
 * A container's exact mapping carries its full generated length, even when the
 * printer reformats a multiline expression. Translating an interior offset
 * linearly would be unsafe in that case. Match the complete generated TS JSX
 * container, then ask about its complete inner expression. Multiple distinct
 * matches are ambiguous and deliberately yield no evidence.
 */
function mappedChild(child, sourceMap, generatedChildren, generatedLength) {
	const matches = new Map();
	for (const [, mapping] of sourceMap.toGeneratedLocation(child.containerStart)) {
		for (let index = 0; index < mapping.sourceOffsets.length; index++) {
			if (
				mapping.sourceOffsets[index] !== child.containerStart ||
				mapping.sourceOffsets[index] + mapping.lengths[index] !== child.containerEnd
			) {
				continue;
			}
			const start = mapping.generatedOffsets[index];
			const end = start + (mapping.generatedLengths?.[index] ?? mapping.lengths[index]);
			if (!validRange(start, end, generatedLength)) continue;
			const key = `${start}:${end}`;
			const node = generatedChildren.get(key);
			if (node !== undefined) matches.set(key, node.expression);
		}
	}
	return matches.size === 1 ? matches.values().next().value : null;
}

/**
 * TypeScript assignability alone is insufficient: `any` and `never` are both
 * assignable to string. A direct child can use the text binding when every
 * possible value is a primitive string, number, or bigint. Keep a distinct
 * string result for the compiler's string-only proofs; a mixed union is text,
 * but it is not evidence for string concatenation. Branded intersections and
 * bounded generic constraints retain their primitive domain. Boxed values,
 * nullish/boolean unions, and unresolved/error types do not.
 *
 * This is a typed-program contract, not runtime validation of inaccurate
 * declarations or values smuggled through `any`.
 */
function primitiveTextKind(type, checker, seen = new Set()) {
	if (!type || type.isErrorType() || seen.has(type)) return 0;
	const flags = type.flags;
	if (
		flags &
		(TypeFlags.Any |
			TypeFlags.Unknown |
			TypeFlags.Never |
			TypeFlags.Void |
			TypeFlags.Undefined |
			TypeFlags.Null)
	) {
		return 0;
	}
	if (flags & TypeFlags.StringLike) return 1;
	if (flags & (TypeFlags.NumberLike | TypeFlags.BigIntLike)) return 2;
	if (seen.size >= 64) return 0;
	seen.add(type);
	let result = 0;
	if (type.isUnionType()) {
		const parts = type.getTypes();
		if (parts.length > 0) {
			result = 1;
			for (const part of parts) {
				const kind = primitiveTextKind(part, checker, seen);
				if (kind === 0) {
					result = 0;
					break;
				}
				if (kind === 2) result = 2;
			}
		}
	} else if (type.isIntersectionType()) {
		for (const part of type.getTypes()) {
			result = primitiveTextKind(part, checker, seen);
			if (result !== 0) break;
		}
	} else {
		const constraint = checker.getBaseConstraintOfType(type);
		if (constraint && constraint !== type) result = primitiveTextKind(constraint, checker, seen);
	}
	seen.delete(type);
	return result;
}

function overlapsDiagnostic(diagnostic, start, end) {
	if (diagnostic.pos < 0 || diagnostic.end < diagnostic.pos) return true;
	if (diagnostic.pos === diagnostic.end) return diagnostic.pos >= start && diagnostic.pos <= end;
	return diagnostic.pos < end && diagnostic.end > start;
}

/** Parse tsconfig JSONC without giving comments or trailing commas a second meaning. */
function configJson(source) {
	const scanner = ts.createScanner(true, ts.LanguageVariant.Standard, source);
	const tokens = [];
	for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFile; kind = scanner.scan()) {
		tokens.push([kind, scanner.getTokenText()]);
	}
	return JSON.parse(
		tokens
			.filter(
				([kind], index) =>
					kind !== ts.SyntaxKind.CommaToken ||
					![ts.SyntaxKind.CloseBraceToken, ts.SyntaxKind.CloseBracketToken].includes(
						tokens[index + 1]?.[0],
					),
			)
			.map(([, text]) => text)
			.join(''),
	);
}

// Native TypeScript recognizes TSX filenames. These aliases exist only in its
// virtual filesystem; authored module specifiers and compiler ranges stay exact.
function serviceFilename(filename) {
	return filename.endsWith('.tsrx') ? filename + '.tsx' : filename;
}

function authoredFilename(filename) {
	return filename.endsWith('.tsrx.tsx') ? filename.slice(0, -4) : filename;
}

function freezeRanges(ranges) {
	const unique = new Map();
	for (const [start, end] of ranges) unique.set(`${start}:${end}`, [start, end]);
	const sorted = [...unique.values()].sort(
		(left, right) => left[0] - right[0] || left[1] - right[1],
	);
	return Object.freeze(sorted.map((range) => Object.freeze(range)));
}

function freezeFacts(filename, record, projectVersion, stringRanges, primitiveRanges) {
	return Object.freeze({
		version: TEXT_TYPE_FACTS_VERSION,
		filename,
		sourceVersion: record.version,
		projectVersion,
		stringChildRanges: freezeRanges(stringRanges),
		primitiveTextChildRanges: freezeRanges(primitiveRanges),
	});
}

/**
 * @param {import('./typescript.js').TextTypeProjectOptions} options
 * @returns {import('./typescript.js').TextTypeProject}
 */
export function createTextTypeProject(options) {
	if (!options || typeof options.tsconfig !== 'string' || options.tsconfig.length === 0) {
		throw new TypeError('createTextTypeProject requires a tsconfig filename.');
	}
	const configFilename = absoluteFilename(options.tsconfig, process.cwd());
	const directory = nodePath.dirname(configFilename);
	const rendererRoot =
		options.root === undefined ? directory : absoluteFilename(options.root, process.cwd());
	const renderers = normalizeRendererConfig(options.renderers);
	const caseSensitive = process.platform !== 'win32' && process.platform !== 'darwin';
	const sources = new FileMap(caseSensitive);
	const overrides = new FileMap(caseSensitive);
	const virtualSources = new FileMap(caseSensitive);
	const configSources = new FileMap(caseSensitive);
	const configFiles = new Set([configFilename]);
	const referencedConfigs = new Set([configFilename]);
	const extraRoots = new Set();
	const factsCache = new FileMap(caseSensitive);
	const analyses = new FileMap(caseSensitive);
	let generation = 0;
	let disposed = false;
	let config = null;
	let rootFileNames = null;
	let discovery = 'ordinary';
	let api = null;
	let nativeSnapshot = null;
	let nativeGeneration = -1;
	let currentProject = null;
	let currentProjectVersion = null;

	const normalize = (filename) => absoluteFilename(filename, directory);
	const authoredName = (filename) => {
		const original = authoredFilename(filename);
		return original !== filename &&
			!existsSync(filename) &&
			(overrides.has(original) || existsSync(original))
			? original
			: filename;
	};
	const assertAlive = () => {
		if (disposed) throw new Error('This Octane text type project has been disposed.');
	};
	/** @returns {SourceRecord | undefined} */
	const readSource = (filename) => {
		const file = normalize(filename);
		if (overrides.has(file)) return overrides.get(file);
		if (sources.has(file)) return sources.get(file);
		let source;
		try {
			source = readFileSync(file, 'utf8');
		} catch (error) {
			if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
		}
		const record = source === undefined ? undefined : sourceRecord(source);
		sources.set(file, record);
		return record;
	};
	const virtualCode = (filename, record) => {
		const file = normalize(filename);
		const cached = virtualSources.get(file);
		if (cached?.version === record.version) return cached;
		let compilation = null;
		try {
			compilation = compileToVolarMappings(record.source, rendererFilename(file, rendererRoot), {
				renderers,
				knownAttributeSpreads: options.knownAttributeSpreads,
			});
		} catch {
			// Broken authored syntax cannot produce proof. Native TypeScript may
			// still recover from the authored text and report its own diagnostics.
		}
		const virtual = {
			version: record.version,
			compilation,
			source: compilation?.code ?? record.source,
		};
		virtualSources.set(file, virtual);
		return virtual;
	};
	const configSource = (file, source) => {
		let cached = configSources.get(file);
		if (cached === undefined) {
			const data = configJson(source);
			cached = { data, version: textTypeSourceVersion(source) };
			configSources.set(file, cached);
		}
		// Native TypeScript does not inherit project references through extends.
		// Only the root or an explicitly referenced config can admit new targets.
		if (referencedConfigs.has(file) && Array.isArray(cached.data.references)) {
			for (const reference of cached.data.references) {
				if (typeof reference?.path !== 'string') continue;
				const target = normalize(nodePath.resolve(nodePath.dirname(file), reference.path));
				const configTarget = target.endsWith('.json')
					? target
					: nodePath.join(target, 'tsconfig.json');
				configFiles.add(configTarget);
				referencedConfigs.add(configTarget);
			}
		}
		const data = { ...cached.data };
		for (const field of ['files', 'include', 'exclude']) {
			if (!Array.isArray(data[field])) continue;
			data[field] = data[field].map((value) => {
				if (field === 'files' || discovery === 'complete') return serviceFilename(value);
				const leaf = value.replaceAll('\\', '/').split('/').at(-1);
				return discovery === 'native' && /[.*?]/.test(leaf)
					? `${value.endsWith('/**') ? value + '/*' : value}.tsx`
					: value;
			});
		}
		if (data.compilerOptions?.paths) {
			data.compilerOptions = {
				...data.compilerOptions,
				paths: Object.fromEntries(
					Object.entries(data.compilerOptions.paths).map(([name, values]) => [
						name,
						values.map(serviceFilename),
					]),
				),
			};
		}
		if (file !== configFilename) return JSON.stringify(data);
		return JSON.stringify({
			...data,
			...(rootFileNames === null
				? {}
				: { files: rootFileNames.map(serviceFilename), include: [], exclude: [] }),
			compilerOptions: {
				...data.compilerOptions,
				...(config !== null && config.options.jsx === undefined ? { jsx: 'preserve' } : {}),
				noEmit: true,
				noCheck: false,
				skipLibCheck: false,
				skipDefaultLibCheck: false,
				allowArbitraryExtensions: true,
				noUncheckedIndexedAccess: true,
			},
		});
	};
	const fs = {
		readFile: (filename) => {
			const file = normalize(filename);
			const original = authoredName(file);
			const record = readSource(original);
			if (record === undefined) return null;
			if (original !== file) return virtualCode(original, record).source;
			if (
				file.endsWith('.json') &&
				(configFiles.has(file) ||
					configSources.has(file) ||
					(discovery !== 'complete' && nodePath.basename(file) !== 'package.json'))
			)
				return configSource(file, record.source);
			return record.source;
		},
		fileExists: (filename) => {
			const file = normalize(filename);
			if (file.endsWith('.tsrx')) return false;
			const authored = authoredName(file);
			return overrides.has(authored) || existsSync(authored);
		},
		directoryExists: (filename) => {
			if (existsSync(filename)) return true;
			const prefix = normalize(filename).replace(/\/$/, '') + '/';
			for (const file of overrides.keys()) if (file.startsWith(prefix)) return true;
			return false;
		},
		getAccessibleEntries: (filename) => {
			const files = new Set();
			const directories = new Set();
			try {
				for (const entry of readdirSync(filename, { withFileTypes: true })) {
					const isDirectory =
						entry.isDirectory() ||
						(entry.isSymbolicLink() && statSync(nodePath.join(filename, entry.name)).isDirectory());
					if (isDirectory) directories.add(entry.name);
					else if (entry.isFile() || entry.isSymbolicLink()) files.add(serviceFilename(entry.name));
				}
			} catch (error) {
				if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
			}
			const prefix = normalize(filename).replace(/\/$/, '') + '/';
			for (const file of overrides.keys()) {
				if (!file.startsWith(prefix)) continue;
				const relative = file.slice(prefix.length);
				const slash = relative.indexOf('/');
				if (slash < 0) {
					files.add(relative);
					files.add(serviceFilename(relative));
				} else directories.add(relative.slice(0, slash));
			}
			return {
				files: [...files].filter(
					(file) =>
						discovery !== 'ordinary' ||
						authoredName(nodePath.join(filename, file)) === nodePath.join(filename, file),
				),
				directories: [...directories],
			};
		},
		realpath: (filename) => {
			try {
				return serviceFilename(realpathSync(authoredName(filename)));
			} catch {
				return filename;
			}
		},
	};
	const ensureApi = () => (api ??= new API({ cwd: directory, fs }));
	const loadConfig = () => {
		if (config !== null) return config;
		if (readSource(configFilename) === undefined)
			throw new Error(`Cannot read text type config ${JSON.stringify(configFilename)}.`);
		const fileNames = new Set();
		let parsed;
		// Native config matching runs over authored names and suffix-transposed
		// TSRX names separately. A '*.tsx' selector must retain its authored meaning.
		for (const mode of ['ordinary', 'native']) {
			discovery = mode;
			const parser = new API({ cwd: directory, fs });
			try {
				const visited = new Set();
				// Parsing a reference natively also discovers its own extends chain.
				// Set iteration follows recursively admitted targets without folding
				// their roots into this project's authored root list.
				for (const reference of referencedConfigs) {
					// Relative extends/references belong to the configured location,
					// including distinct config filenames symlinked to the same file.
					const canonical = caseSensitive ? reference : reference.toLowerCase();
					if (visited.has(canonical)) continue;
					visited.add(canonical);
					const result = parser.parseConfigFile(reference);
					if (reference !== configFilename) continue;
					parsed ??= result;
					for (const file of result.fileNames) {
						if (mode === 'ordinary' || authoredName(file) !== file)
							fileNames.add(normalize(authoredName(file)));
					}
				}
			} finally {
				parser.close();
			}
		}
		discovery = 'complete';
		config = { ...parsed, fileNames: [...fileNames], fileNameSet: fileNames };

		return config;
	};
	const roots = () => {
		if (rootFileNames === null)
			rootFileNames = [...new Set([...loadConfig().fileNames, ...extraRoots])].sort();
		return rootFileNames;
	};
	const clearProofs = () => {
		factsCache.clear();
		analyses.clear();
		currentProject = null;
		currentProjectVersion = null;
	};
	const closeApi = () => {
		api?.close();
		api = null;
		nativeSnapshot = null;
		nativeGeneration = -1;
		clearProofs();
	};
	const changed = (filename) => {
		generation++;
		virtualSources.delete(filename);
		clearProofs();
	};
	const ensureProject = () => {
		roots();
		if (nativeSnapshot === null || nativeGeneration !== generation) {
			const previous = nativeSnapshot;
			// The native API carries unchanged ASTs into the next snapshot. Let it
			// retain that cache before releasing the preceding snapshot.
			const next = ensureApi().updateSnapshot({
				...(previous === null ? { openProjects: [configFilename] } : {}),
				fileChanges: { invalidateAll: true },
			});
			nativeSnapshot = next;
			nativeGeneration = generation;
			previous?.dispose();
			clearProofs();
		}
		const project = nativeSnapshot.getProject(configFilename);
		if (project === undefined) throw new Error('TypeScript did not create a text type Project.');
		const errors = project.program
			.getConfigFileParsingDiagnostics()
			.filter(
				(error) =>
					error.category === DiagnosticCategory.Error &&
					error.code !== 18002 &&
					error.code !== 18003,
			);
		if (errors.length > 0) throw new Error(errors.map((error) => error.text).join('\n'));
		return project;
	};
	/** @param {Project} project */
	const projectVersion = (project) => {
		if (currentProject === project && currentProjectVersion !== null) return currentProjectVersion;
		clearProofs();
		currentProject = project;
		const inputs = project.program
			.getSourceFileNames()
			.map((filename) => {
				const file = project.program.getSourceFile(filename);
				return [
					normalize(authoredName(filename)),
					readSource(authoredName(filename))?.version ?? textTypeSourceVersion(file.text),
					project.program.getSourceFileMetadata(filename)?.impliedNodeFormat ?? null,
				];
			})
			.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
		currentProjectVersion = textTypeSourceVersion(
			stableJson({
				typescript: typescriptVersion,
				config: configFilename,
				configInputs: [...configSources.entries()]
					.map(([file, record]) => [file, record.version])
					.sort(),
				options: project.compilerOptions,
				renderers: renderers.signature,
				knownAttributeSpreads: options.knownAttributeSpreads,
				rendererRoot,
				roots: roots(),
				inputs,
			}),
		);
		return currentProjectVersion;
	};
	/** @param {Project} project @param {SourceFile} sourceFile */
	const analyzeFile = (project, sourceFile) => {
		const filename = normalize(sourceFile.fileName);
		const cached = analyses.get(filename);
		if (cached !== undefined) return cached;
		const syntaxErrors = project.program
			.getSyntacticDiagnostics(filename)
			.some((diagnostic) => diagnostic.category === DiagnosticCategory.Error);
		const analysis = {
			syntaxErrors,
			children: syntaxErrors ? new Map() : indexJsxChildren(sourceFile),
			errors: syntaxErrors
				? []
				: [
						...project.program.getBindDiagnostics(filename),
						...project.program.getSemanticDiagnostics(filename),
					].filter((diagnostic) => diagnostic.category === DiagnosticCategory.Error),
		};
		analyses.set(filename, analysis);
		return analysis;
	};
	const snapshot = (filename, source) => {
		assertAlive();
		const file = normalize(filename);
		if (!file.endsWith('.tsrx') && !file.endsWith('.tsx'))
			throw new TypeError('Octane text type snapshots require a .tsrx or .tsx filename.');
		if (source !== undefined && typeof source !== 'string')
			throw new TypeError('Octane text type snapshot source must be a string.');
		if (file.endsWith('.tsrx') && existsSync(serviceFilename(file)))
			throw new TypeError(
				`Text type projection conflicts with authored file ${JSON.stringify(serviceFilename(file))}.`,
			);
		let record = readSource(file);
		if (source !== undefined && record?.source !== source) {
			record = sourceRecord(source);
			overrides.set(file, record);
			changed(file);
		} else if (source !== undefined) overrides.set(file, record);
		if (record === undefined)
			throw new Error(`Cannot read text type source ${JSON.stringify(file)}.`);
		if (!loadConfig().fileNameSet.has(file) && !extraRoots.has(file)) {
			extraRoots.add(file);
			rootFileNames = null;
			changed(file);
			// A newly admitted root changes the configured project itself. Native
			// file invalidation updates existing roots, so reopen this owner once.
			closeApi();
		}
		const project = ensureProject();
		const version = projectVersion(project);
		const cached = factsCache.get(file);
		if (
			cached?.filename === file &&
			cached.sourceVersion === record.version &&
			cached.projectVersion === version
		)
			return cached;
		const stringRanges = [];
		const primitiveRanges = [];
		const strictNullChecks =
			project.compilerOptions.strictNullChecks ?? project.compilerOptions.strict ?? false;
		const sourceFile = project.program.getSourceFile(serviceFilename(file));
		if (strictNullChecks && sourceFile !== undefined) {
			const virtual = file.endsWith('.tsrx') ? virtualSources.get(file) : null;
			const compilation = virtual?.compilation;
			const validSource = virtual
				? virtual.version === record.version &&
					sourceFile.text === virtual.source &&
					compilation !== null &&
					compilation.errors.length === 0
				: sourceFile.text === record.source;
			if (validSource) {
				const analysis = analyzeFile(project, sourceFile);
				if (!analysis.syntaxErrors) {
					const checker = project.checker;
					const accept = (expression, start, end) => {
						if (!expression) return;
						const generatedStart = expression.getStart(sourceFile);
						if (
							analysis.errors.some((error) =>
								overlapsDiagnostic(error, generatedStart, expression.end),
							)
						)
							return;
						const kind = primitiveTextKind(checker.getTypeAtLocation(expression), checker);
						if (kind === 1) stringRanges.push([start, end]);
						else if (kind === 2) primitiveRanges.push([start, end]);
					};
					if (compilation) {
						const sourceMap = new SourceMap(compilation.mappings);
						for (const child of authoredChildren(compilation.sourceAst, record.source))
							accept(
								mappedChild(child, sourceMap, analysis.children, sourceFile.text.length),
								child.start,
								child.end,
							);
					} else {
						for (const child of analysis.children.values()) {
							const expression = unparenthesizedExpression(child.expression);
							accept(child.expression, expression.getStart(sourceFile), expression.end);
						}
					}
				}
			}
		}
		const facts = freezeFacts(file, record, version, stringRanges, primitiveRanges);
		factsCache.set(file, facts);
		return facts;
	};
	const invalidate = (filename) => {
		assertAlive();
		generation++;
		if (filename === undefined) {
			overrides.clear();
			sources.clear();
			virtualSources.clear();
		} else {
			const file = normalize(filename);
			overrides.delete(file);
			sources.delete(file);
			virtualSources.delete(file);
		}
		for (const file of configSources.keys()) sources.delete(file);
		configSources.clear();
		configFiles.clear();
		configFiles.add(configFilename);
		referencedConfigs.clear();
		referencedConfigs.add(configFilename);
		config = null;
		rootFileNames = null;
		closeApi();
	};
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		closeApi();
		overrides.clear();
		sources.clear();
		virtualSources.clear();
		configSources.clear();
		configFiles.clear();
		referencedConfigs.clear();
		extraRoots.clear();
		config = null;
		rootFileNames = null;
	};
	try {
		loadConfig();
	} catch (error) {
		dispose();
		throw error;
	}
	return Object.freeze({ snapshot, invalidate, dispose });
}
