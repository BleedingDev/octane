import type { TextTypeFacts } from './text-type-facts.js';
export type { TextTypeFacts } from './text-type-facts.js';

export interface TextTypeProjectOptions {
	/** Path to the consumer tsconfig. Relative paths resolve from the process cwd. */
	tsconfig: string;
	/** Root for project-relative renderer module IDs; defaults to the tsconfig directory. */
	root?: string;
	/** The same renderer configuration used by the Octane compiler. */
	renderers?: unknown;
	/** The same native attribute contracts used by runtime compilation. */
	knownAttributeSpreads?: readonly import('./index.js').KnownAttributeSpread[];
}

export interface TextTypeProject {
	/**
	 * Return immutable facts for a .tsrx or .tsx file. Relative filenames resolve
	 * from the tsconfig directory. An optional source is an authoritative in-memory
	 * override until that file, or the whole project, is invalidated.
	 *
	 * The project uses strict null checking only when the consumer enables it and
	 * always enables full checking and noUncheckedIndexedAccess for this analysis. Unproven, unsafe,
	 * erroneous, or ambiguously mapped expressions are omitted. These facts trust
	 * TypeScript declarations; they do not validate runtime values.
	 */
	snapshot(filename: string, source?: string): TextTypeFacts;
	/**
	 * Discard a changed file's cached source/override and all semantic proofs.
	 * Without a filename, discard every cached source/override. Both forms reload
	 * the tsconfig and project roots before the next snapshot. No watcher is started.
	 */
	invalidate(filename?: string): void;
	/** Release the native TypeScript API and retained source graph. Idempotent. */
	dispose(): void;
}

/**
 * Create an explicit, Node-only TypeScript project for Octane child-text facts.
 * Requires the optional TypeScript peer. Reuse one instance across a build and
 * pass the same snapshot to client and server compilation.
 */
export function createTextTypeProject(options: TextTypeProjectOptions): TextTypeProject;

/**
 * Validate native signal names and known live reads in ordinary memo callbacks
 * against the exact SourceFile in an existing native TypeScript Project. The caller
 * owns project lifetime and mapping diagnostics from virtual .tsrx files.
 * Resolves the native SIGNAL_HANDLE brand by symbol; unrelated structural
 * shapes and ordinary sampled values are not native capabilities.
 */
export function validateNativeSignalNames(
	project: import('typescript/unstable/sync').Project,
	file: string | import('typescript/unstable/ast').SourceFile,
): import('./index.js').CompileDiagnostic[];
