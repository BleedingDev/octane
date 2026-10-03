import { dirname, resolve } from 'node:path';
import { API } from 'typescript/unstable/sync';

export class NativeSyntaxError extends Error {
	constructor(diagnostics, sourceFiles) {
		super(
			diagnostics
				.map((diagnostic) => {
					const file = sourceFiles.get(diagnostic.fileName);
					const position = file?.getLineAndCharacterOfPosition(diagnostic.pos);
					const location = position ? `:${position.line + 1}:${position.character + 1}` : '';
					return `${diagnostic.fileName ?? 'native syntax project'}${location}: TS${diagnostic.code}: ${diagnostic.text}`;
				})
				.join('\n'),
		);
		this.name = 'NativeSyntaxError';
		this.diagnostics = Object.freeze([...diagnostics]);
	}
}

let projectId = 0;

/** Parse build inputs through the native compiler while their snapshot remains live. */
export function withNativeSyntaxProject(
	sources,
	run,
	{ cwd = process.cwd(), allowParseDiagnostics = false } = {},
) {
	if (!Array.isArray(sources) || sources.length === 0) {
		throw new TypeError('A native syntax project requires at least one source.');
	}
	if (typeof allowParseDiagnostics !== 'boolean') {
		throw new TypeError('Native syntax recovery must be selected explicitly.');
	}
	const files = sources.map(([filename, source]) => [resolve(cwd, filename), source]);
	const virtual = new Map(files);
	if (virtual.size !== files.length)
		throw new TypeError('Native syntax project filenames must be unique.');
	const configFile = resolve(dirname(files[0][0]), `.octane-native-syntax-${++projectId}.json`);
	virtual.set(
		configFile,
		JSON.stringify({
			compilerOptions: {
				allowJs: true,
				jsx: 'preserve',
				target: 'ESNext',
				module: 'Preserve',
				moduleResolution: 'Bundler',
				noEmit: true,
				noLib: true,
				noResolve: true,
				types: [],
			},
			files: files.map(([filename]) => filename),
		}),
	);
	const api = new API({
		cwd,
		fs: {
			readFile: (filename) => virtual.get(filename),
			fileExists: (filename) => virtual.has(filename) || undefined,
		},
	});
	let snapshot;
	try {
		snapshot = api.updateSnapshot({ openProjects: [configFile] });
		const project = snapshot.getProject(configFile);
		if (!project) throw new Error('The native compiler did not open the syntax project.');
		const program = project.program;
		const sourceFiles = files.map(([filename]) => {
			const file = program.getSourceFile(filename);
			if (!file) throw new Error(`The native compiler did not parse ${filename}.`);
			return [filename, file];
		});
		const diagnostics = files.flatMap(([filename]) => program.getSyntacticDiagnostics(filename));
		if (diagnostics.length !== 0 && !allowParseDiagnostics) {
			throw new NativeSyntaxError(diagnostics, new Map(sourceFiles));
		}
		return run({ api, project, program, sourceFiles, parseDiagnostics: diagnostics });
	} finally {
		try {
			snapshot?.dispose();
		} finally {
			api.close();
		}
	}
}
