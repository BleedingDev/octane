/**
 * Admit owned signal generations through Rspack's native module-execution
 * interceptor, retaining the document fence before every unadmitted factory.
 * @param {import('@rspack/core').Compiler} compiler
 * @param {import('@rspack/core').Compilation} compilation
 * @param {Array<{
 *   module: import('@rspack/core').Module,
 *   executableModule?: import('@rspack/core').Module,
 *   info?: { hotSignalModule?: object, streamedSignals?: boolean, independentWidgets?: unknown[] }
 * }>} modules
 */
export function createStreamedSignalHmrRuntimeModule(compiler, compilation, modules) {
	const { RuntimeGlobals, RuntimeModule } = compiler.webpack;
	return new (class extends RuntimeModule {
		constructor() {
			super('octane streamed signal HMR fence', RuntimeModule.STAGE_TRIGGER);
			this.fullHash = true;
		}

		generate() {
			const manifests = new Map();
			const unsupported = new Set();
			const features = new Set();
			for (const { module, executableModule, info } of modules) {
				for (const candidate of [executableModule, module, module?.rootModule]) {
					const id = candidate == null ? null : compilation.chunkGraph.getModuleId(candidate);
					if (id != null) {
						const executableId = String(id);
						if (
							info === undefined ||
							info.streamedSignals === true ||
							(info.independentWidgets?.length ?? 0) > 0
						) {
							features.add(executableId);
						}
						const records = manifests.get(executableId) ?? [];
						manifests.set(executableId, records);
						if (info?.hotSignalModule === undefined) {
							unsupported.add(executableId);
						} else if (!records.some((record) => record === info.hotSignalModule)) {
							records.push(info.hotSignalModule);
						}
						break;
					}
				}
			}
			const records = [...manifests]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([id, entries]) => [id, unsupported.has(id) ? [] : entries]);
			return `
var octaneSignalRuntime = ${RuntimeGlobals.require}.__octaneHotSignalRuntime;
if (!octaneSignalRuntime) {
  octaneSignalRuntime = ${RuntimeGlobals.require}.__octaneHotSignalRuntime = {
    modules: new Map(), features: new Set(), buildId: '', executed: new Set(), generationChanged: false
  };
}
octaneSignalRuntime.modules = new Map(${JSON.stringify(records)});
octaneSignalRuntime.features = new Set(${JSON.stringify([...features].sort())});
// Native compilation ${JSON.stringify(compilation.hash ?? '')} keeps this runtime in every hot update.
octaneSignalRuntime.buildId = ${RuntimeGlobals.getFullHash}();
var octaneSignalExecutionKey = Symbol.for('octane.hot-signals.execution');
var octaneSignalBridgeKey = Symbol.for('octane.hot-signals.bridge');
function octaneReloadSignalDocument() {
  ${RuntimeGlobals.global}.location?.reload?.();
  throw new Error('[octane] The streamed signal client build changed. Reload this document.');
}
function octaneTrackSignalGeneration(hot) {
  if (!hot || octaneSignalRuntime.statusInstalled) return;
  octaneSignalRuntime.statusInstalled = true;
  if (hot.status() !== 'idle') octaneSignalRuntime.generationChanged = true;
  hot.addStatusHandler(function(status) {
    if (status === 'apply') octaneSignalRuntime.generationChanged = true;
    if (octaneSignalRuntime.executed.size === 0 ||
        (status !== 'check' && status !== 'dispose' && status !== 'apply')) return;
    var bridge = ${RuntimeGlobals.global}[octaneSignalBridgeKey];
    try {
      if (bridge && bridge.allowStatus(octaneSignalRuntime, status) === true) return;
    } catch (_) {}
    octaneReloadSignalDocument();
  });
}
// A newly introduced runtime may itself arrive during hot application. The
// entry's cached hot module supplies that state before any feature executes.
for (var octaneCachedId in ${RuntimeGlobals.moduleCache}) {
  octaneTrackSignalGeneration(${RuntimeGlobals.moduleCache}[octaneCachedId].hot);
  if (octaneSignalRuntime.statusInstalled) break;
}
if (!octaneSignalRuntime.interceptorInstalled) {
  octaneSignalRuntime.interceptorInstalled = true;
  ${RuntimeGlobals.interceptModuleExecution}.push(function(options) {
  var hot = options.module.hot;
  octaneTrackSignalGeneration(hot);
  var executableId = String(options.id);
  var manifests = octaneSignalRuntime.modules.get(executableId);
  if (!hot || (!manifests && !octaneSignalRuntime.executed.has(executableId))) return;
  manifests = manifests || [];
  var factory = options.factory;
  options.factory = function() {
    var frame = {
      runtime: octaneSignalRuntime, executableId: executableId,
      buildId: octaneSignalRuntime.buildId, manifests: manifests,
      hot: octaneSignalRuntime.generationChanged || hot.status() !== 'idle',
      requiresAdmission: octaneSignalRuntime.features.has(executableId) || octaneSignalRuntime.executed.has(executableId)
    };
    var previousFrame = ${RuntimeGlobals.global}[octaneSignalExecutionKey];
    var bridge = ${RuntimeGlobals.global}[octaneSignalBridgeKey];
    var phase = 'admission';
    var admitted = false;
    ${RuntimeGlobals.global}[octaneSignalExecutionKey] = frame;
    try {
      if (frame.hot) {
        if (frame.buildId !== ${RuntimeGlobals.getFullHash}()) {
          throw new Error('Octane hot signal factory has stale compiler metadata.');
        }
        if (frame.requiresAdmission) {
          frame.transaction = bridge && bridge.beforeFactory(frame);
          if (frame.transaction === null || typeof frame.transaction !== 'object') {
            throw new Error('Octane hot signal factory has no native admission.');
          }
          admitted = true;
        }
      }
      if (octaneSignalRuntime.features.has(executableId)) octaneSignalRuntime.executed.add(executableId);
      phase = 'factory';
      var result = factory.apply(this, arguments);
      phase = 'commit';
      bridge = ${RuntimeGlobals.global}[octaneSignalBridgeKey];
      if (bridge) bridge.afterFactory(frame);
      return result;
    } catch (error) {
      bridge = ${RuntimeGlobals.global}[octaneSignalBridgeKey];
      var aborted = false;
      try { aborted = bridge && bridge.abortFactory(frame) === true; } catch (_) {}
      if (phase !== 'factory' || (admitted && !aborted)) octaneReloadSignalDocument();
      throw error;
    } finally {
      if (previousFrame === undefined) delete ${RuntimeGlobals.global}[octaneSignalExecutionKey];
      else ${RuntimeGlobals.global}[octaneSignalExecutionKey] = previousFrame;
    }
  };
  });
}`;
		}
	})();
}
