import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const publicTypecheckOptions = {
	target: 'esnext',
	module: 'preserve',
	moduleResolution: 'bundler',
	lib: ['esnext', 'dom', 'dom.iterable'],
	strict: true,
	exactOptionalPropertyTypes: true,
	noUncheckedIndexedAccess: true,
	noPropertyAccessFromIndexSignature: true,
	noImplicitOverride: true,
	noImplicitReturns: true,
	noFallthroughCasesInSwitch: true,
	isolatedModules: true,
	verbatimModuleSyntax: true,
	skipLibCheck: false,
	noEmit: true,
};

/** The same real public API uses are checked in emitted declarations and installed tarballs. */
export function publicTypeConsumerSources(
	{ runtime = 'octane', signals = 'octane/signals', server = 'octane/server' } = {},
	{ commonjs = false } = {},
) {
	const namespace = (name, specifier) =>
		commonjs
			? `import ${name} = require(${JSON.stringify(specifier)});`
			: `import * as ${name} from ${JSON.stringify(specifier)};`;
	const privateAuthority = commonjs
		? `// @ts-expect-error Publisher admission belongs to the private native owner driver.
Signals.admitHotSignalPublisher;
// @ts-expect-error Native authority cannot be minted by a public consumer.
Signals.createNativeHotSignalOwnerProof;
// @ts-expect-error Private proof is not a public application type.
type PrivateProof = Signals.HotSignalOwnerProof;`
		: `// @ts-expect-error Publisher admission belongs to the private native owner driver.
import { admitHotSignalPublisher } from ${JSON.stringify(signals)};
// @ts-expect-error Native authority cannot be minted by a public consumer.
import { createNativeHotSignalOwnerProof } from ${JSON.stringify(signals)};
// @ts-expect-error Private proof is not a public application type.
import type { HotSignalOwnerProof } from ${JSON.stringify(signals)};`;
	const client = `${namespace('Octane', runtime)}
${namespace('Signals', signals)}
declare const nativeComponent: Octane.ComponentBody<{ count: number }>;
declare const snapshot: Octane.ExternalSnapshot;
const Theme = Octane.createContext({ title: 'host' });
const unregister = Octane.registerExternalSnapshotContext(Theme, {
 key: 'theme',
 encode: value => value.title,
 decode: async (value, signal) => { signal?.throwIfAborted(); return { title: String(value) }; },
 dispose: async value => { const title: string = value.title; void title; },
 validate: async (value, readContext, signal) => {
  signal?.throwIfAborted();
  const selected = readContext(Theme);
  if (selected.present) {
   const title: string = selected.value.title; void title;
   // @ts-expect-error Captured context reader results are readonly.
   selected.value = value;
  }
  // @ts-expect-error The reader requires a physical native context identity.
  readContext({ defaultValue: { title: 'forged' } });
 },
});
const authority: Octane.ExternalSnapshotAuthority = { publisherBuildId: 'published-client', runtimeABI: 1 };
const Boundary = Octane.externalSnapshotBoundary({ authority, component: nativeComponent, contextKeys: ['theme'], snapshot: async (request, signal) => {
 const admitted: Octane.ExternalSnapshotRequest = Octane.decodeExternalSnapshotRequest(request, authority);
 const capturedContext: Octane.ExternalSnapshotRequest['contexts'][number] = { key: 'forged', value: ['null'] };
 // @ts-expect-error Captured request contexts are readonly.
 admitted.contexts.push(capturedContext);
 void signal; return snapshot;
} });
const Publisher: Octane.ComponentBody<{ count: number }> = Octane.publisherBoundary(nativeComponent, { publisherKey: 'remote/widget' });
const typedBoundary: Octane.ComponentBody<{ count: number }> = Boundary;
// @ts-expect-error Native publisher identity is a string.
Octane.publisherBoundary(nativeComponent, { publisherKey: 42 });
const manifest: Signals.HotSignalModuleManifest = {
 version: 1, moduleId: '/remote/Widget.tsrx', generation: 'source:1', hookSlots: ['native:slot'],
 declarations: [
  { site: 'g:count', key: 'g:count', scope: 'document', kind: 'signal', factory: '__signalAt' },
  { site: 'g:scalar', key: 'g:scalar', scope: 'document', kind: 'derived', factory: '__derivedScalarAt' },
  { site: 'g:derived', key: 'g:derived', scope: 'document', kind: 'derived', factory: '__derivedAt' },
  { site: 'g:query', key: 'g:query', scope: 'document', kind: 'async', factory: '__queryAt', queryKind: 'promise' },
 ],
};
const stamp: Signals.HotSignalModuleStamp = Signals.__hotSignalModule(manifest);
const count: Signals.WritableSignal<number> = Signals.__signalAt('g:count', 0, undefined, stamp);
const scalar: Signals.DerivedSignal<number> = Signals.__derivedScalarAt('g:scalar', () => count.latest(0) + 1, undefined, stamp);
const derived: Signals.DerivedSignal<{ count: number }> = Signals.__derivedAt<{ count: number }>('g:derived', async () => ({ count: count.latest(0) }), undefined, stamp);
const query: Signals.QuerySignal<string> = Signals.__queryAt<number, string>('g:query', () => count.latest(0), async (selection, context) => { context.signal.throwIfAborted(); return String(selection); }, { kind: 'promise' }, stamp);
Signals.__registerHotSignalComponent(stamp, nativeComponent);
const remounted: boolean = Signals.__remountHotSignalComponent(stamp, nativeComponent, nativeComponent);
// @ts-expect-error A structural object cannot forge a compiler module stamp.
Signals.__registerHotSignalComponent({}, nativeComponent);
// @ts-expect-error Compiled declaration shape is readonly.
manifest.hookSlots.push('foreign-slot');
${privateAuthority}
void Publisher; void typedBoundary; void remounted; void scalar; void derived; void query; unregister();
`;
	const producer = `${namespace('Server', server)}
declare const wireRequest: unknown;
async function checkPreparedPublisher() {
 const Local = Server.createContext({ name: 'local' });
 const authority: Server.ExternalSnapshotAuthority = { publisherBuildId: 'published-client', runtimeABI: 1 };
 const signal = new AbortController().signal;
 const request = Server.decodeExternalSnapshotRequest(wireRequest, authority);
 const endpoint = (props: { count: number }) => String(props.count);
 const publisher: typeof endpoint = Server.publisherBoundary(endpoint, { publisherKey: 'remote/widget' });
 const options: Server.ExternalSnapshotRenderOptions = { authority, signal, timeoutMs: 1000,
  initializeContexts(provide) { provide(Local, { name: 'endpoint' }); },
 };
 const prepared: Server.PreparedExternalSnapshotRequest = await Server.prepareExternalSnapshotRequest(request, options);
 const cancellation: AbortSignal = prepared.signal;
 try {
  const result: Server.ExternalSnapshot = await Server.renderExternalSnapshot(publisher, prepared);
  const serialized: string = Server.serializeExternalSnapshot(result);
  const ordinary: Server.ExternalSnapshot = await Server.renderExternalSnapshot(publisher, request, options);
  void serialized; void ordinary; void cancellation;
 } finally {
  const released: Promise<void> = Server.releasePreparedExternalSnapshotRequest(prepared);
  await released;
 }
 // @ts-expect-error A structural handle cannot claim the private prepared request lease.
 Server.releasePreparedExternalSnapshotRequest({ signal });
 // @ts-expect-error Prepared handles cannot supply a new render authority.
 Server.renderExternalSnapshot(publisher, prepared, options);
 // @ts-expect-error Prepared cancellation is readonly.
 prepared.signal = signal;
}
void checkPreparedPublisher;
`;
	return { client, server: producer };
}

export async function checkPublicTypes(
	packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'packages/octane'),
) {
	const { API } = await import('typescript/unstable/sync');
	const { createVirtualFileSystem } = await import('typescript/unstable/fs');
	const sources = publicTypeConsumerSources({
		runtime: './dist/index.js',
		signals: './dist/signals/index.js',
		server: './dist/server/index.js',
	});
	// Browser/graph consumers remain Node-free. The published server entry also
	// supports Node streams, and is checked in its declared Node environment.
	const consumers = [
		{
			name: 'client',
			source:
				sources.client +
				"\nimport type { ReactiveNode } from 'alien-signals/system';\nimport type { ScopedNode, SignalObserver } from './dist/signals/graph.js';\ndeclare const node: ScopedNode; declare const observer: SignalObserver;\nconst nativeNode: ReactiveNode = node; const nativeObserver: ReactiveNode = observer; void nativeNode; void nativeObserver;\n",
			types: [],
		},
		{ name: 'server', source: sources.server, types: ['node'] },
	].map((consumer) => ({
		...consumer,
		sourcePath: resolve(packageRoot, `ultramodern-native-${consumer.name}-public-types.ts`),
		configPath: resolve(
			packageRoot,
			`ultramodern-native-${consumer.name}-public-types.tsconfig.json`,
		),
	}));
	const virtualFiles = createVirtualFileSystem(
		Object.fromEntries(
			consumers.flatMap(({ sourcePath, source, configPath, types }) => [
				[sourcePath, source],
				[
					configPath,
					JSON.stringify({
						compilerOptions: { ...publicTypecheckOptions, types },
						files: [sourcePath],
					}),
				],
			]),
		),
	);
	const api = new API({
		cwd: packageRoot,
		fs: {
			readFile: virtualFiles.readFile,
			fileExists: (path) => virtualFiles.fileExists(path) || undefined,
		},
	});
	try {
		const snapshot = api.updateSnapshot({
			openProjects: consumers.map(({ configPath }) => configPath),
		});
		try {
			for (const { name, configPath, types } of consumers) {
				const project = snapshot.getProject(configPath);
				assert(project, 'The native TypeScript consumer project must load.');
				assert.equal(project.compilerOptions.skipLibCheck, false);
				assert.deepEqual(project.compilerOptions.types, types);
				const { program } = project;
				const diagnostics = [
					...program.getConfigFileParsingDiagnostics(),
					...program.getProgramDiagnostics(),
					...program.getGlobalDiagnostics(),
					...program.getSyntacticDiagnostics(),
					...program.getSemanticDiagnostics(),
				];
				if (diagnostics.length) console.error(JSON.stringify(diagnostics, null, 2));
				assert.equal(
					diagnostics.length,
					0,
					`Published native ${name} types must honor canonical consumer flags.`,
				);
			}
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
	console.log(
		'Native declarations: strict browser types:[] and server types:[node], skipLibCheck:false passed.',
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	await checkPublicTypes();
