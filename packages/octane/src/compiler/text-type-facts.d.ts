/** Source-bound, serializable primitive-text proofs for JSX child holes. */
export interface TextTypeFacts {
	readonly version: 1;
	/** Clean absolute filename, with forward-slash separators. */
	readonly filename: string;
	/** Digest of every authored UTF-16 code unit, including line endings. */
	readonly sourceVersion: string;
	/** Identifies the TypeScript options and source graph used for this proof. */
	readonly projectVersion: string;
	/** Sorted, unique, half-open UTF-16 ranges of authored child expressions. */
	readonly stringChildRanges: readonly (readonly [start: number, end: number])[];
	/**
	 * Number, bigint, and mixed string/number/bigint children. Older version-1
	 * snapshots omit this field and retain their string-only behavior.
	 */
	readonly primitiveTextChildRanges?: readonly (readonly [start: number, end: number])[];
}

/** The source-bound proof format consumed by the ordinary compiler. */
export const TEXT_TYPE_FACTS_VERSION: 1;

/** Remove bundler suffixes and normalize separators without Node utilities. */
export function normalizeTextTypeFilename(filename: unknown): string | null;

/** Digest the complete authored UTF-16 source. */
export function textTypeSourceVersion(source: string): string;

/** Validate authored child ranges before runtime lowering consumes them. */
export function createTextTypeFactsLookup(
	facts: TextTypeFacts | undefined,
	filename: string,
	source: string,
): { stringRanges: Set<string>; primitiveRanges: Set<string> } | null;
