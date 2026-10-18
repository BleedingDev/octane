import { expect, it, vi } from 'vitest';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const identity = () => ({ buildId: 'cold-build', documentId: 'cold-document' });
const transition = (type: 'pagehide' | 'pageshow', persisted: boolean) =>
	window.dispatchEvent(new PageTransitionEvent(type, { persisted }));

it('freezes signals first loaded after pagehide, including a publisher joining while frozen', async () => {
	vi.resetModules();
	const { installSignalDocumentLifecycle, joinSignalDocumentLifecycle } =
		await import('octane/hydration/document-lifecycle');
	const lifecycle = installSignalDocumentLifecycle({
		document,
		...identity(),
		readIdentity: identity,
	});
	const participantOwner = { scopeKey: 'cold-publisher' };
	const onRetire = vi.fn();
	const suspend = vi.fn();
	try {
		transition('pagehide', true);
		const participant = joinSignalDocumentLifecycle({
			document,
			documentId: 'cold-document',
			signalOwner: participantOwner,
			streamedHydration: { suspend },
			onRetire,
		});
		expect(participant?.active).toBe(false);
		expect(suspend).toHaveBeenCalledOnce();
		const { query$, runWithSignalOwner } = await import('octane/signals');
		const load = vi.fn(async (key: string) => key + ' ready');
		const host = query$(() => 'host', load, { key: 'cold-host-read' });
		const child = query$(() => 'publisher', load, { key: 'cold-publisher-read' });
		const readHost = () => runWithSignalOwner(lifecycle.signalOwner, () => host.snapshot());
		const readChild = () => runWithSignalOwner(participantOwner, () => child.snapshot());
		expect(readHost().status).toBe('pending');
		expect(readChild().status).toBe('pending');
		await tick();
		expect(load).not.toHaveBeenCalled();
		transition('pageshow', true);
		expect(await lifecycle.whenActive()).toBe(true);
		expect(await participant?.whenActive()).toBe(true);
		await tick();
		expect(load.mock.calls.map(([key]) => key)).toEqual(['host', 'publisher']);
		expect(readHost()).toMatchObject({ status: 'ready', value: 'host ready' });
		expect(readChild()).toMatchObject({ status: 'ready', value: 'publisher ready' });
		lifecycle.dispose();
		expect(onRetire).toHaveBeenCalledOnce();
		expect(() => readHost()).toThrow(/retired|disposed/);
		expect(() => readChild()).toThrow(/retired|disposed/);
	} finally {
		lifecycle.dispose();
	}
});

it('drops a disposed frozen document subscription before signals first load', async () => {
	vi.resetModules();
	const { installSignalDocumentLifecycle, joinSignalDocumentLifecycle } =
		await import('octane/hydration/document-lifecycle');
	const retired = installSignalDocumentLifecycle({
		document,
		...identity(),
		readIdentity: identity,
	});
	const participantOwner = { scopeKey: 'retired-cold-publisher' };
	const onRetire = vi.fn();
	const participant = joinSignalDocumentLifecycle({
		document,
		documentId: 'cold-document',
		signalOwner: participantOwner,
		streamedHydration: undefined,
		onRetire,
	});
	transition('pagehide', true);
	retired.dispose();
	expect(onRetire).toHaveBeenCalledOnce();
	expect(await participant?.whenActive()).toBe(false);
	expect(await retired.whenActive()).toBe(false);
	const current = installSignalDocumentLifecycle({
		document,
		signalOwner: { scopeKey: 'replacement-document' },
		...identity(),
		readIdentity: identity,
	});
	try {
		const { query$, runWithSignalOwner } = await import('octane/signals');
		const old = query$(
			() => 'key',
			async () => 'retired',
			{ key: 'retired-document-read' },
		);
		expect(() => runWithSignalOwner(retired.signalOwner, () => old.snapshot())).toThrow(
			/retired|disposed/,
		);
		expect(() => runWithSignalOwner(participantOwner, () => old.snapshot())).toThrow(
			/retired|disposed/,
		);
		const load = vi.fn(async () => 'current document');
		const value = query$(() => 'key', load, { key: 'replacement-document-read' });
		runWithSignalOwner(current.signalOwner, () => value.snapshot());
		await tick();
		expect(load).toHaveBeenCalledOnce();
		expect(runWithSignalOwner(current.signalOwner, () => value.get())).toBe('current document');
		expect(await current.whenActive()).toBe(true);
	} finally {
		current.dispose();
		retired.dispose();
	}
});

it('rejects renderer owners before signals load without breaking healthy documents', async () => {
	vi.resetModules();
	const { installSignalDocumentLifecycle, joinSignalDocumentLifecycle } =
		await import('octane/hydration/document-lifecycle');
	const rendererOwner = {
		scopeKey: 'invalid-document',
		documentOwner: { scopeKey: 'parent-document' },
		instanceOwner: {},
		instanceKey: 'renderer-instance',
	};
	expect(() =>
		installSignalDocumentLifecycle({
			document,
			...identity(),
			signalOwner: rendererOwner,
			readIdentity: identity,
		}),
	).toThrow(TypeError);
	const healthy = installSignalDocumentLifecycle({
		document,
		...identity(),
		signalOwner: { scopeKey: 'healthy-cold-document' },
		readIdentity: identity,
	});
	try {
		expect(() =>
			joinSignalDocumentLifecycle({
				document,
				documentId: 'cold-document',
				signalOwner: rendererOwner,
				streamedHydration: undefined,
				onRetire() {},
			}),
		).toThrow(TypeError);
		const { query$, runWithSignalOwner } = await import('octane/signals');
		const load = vi.fn(async () => 'healthy');
		const value = query$(() => 'key', load, { key: 'healthy-after-invalid-owner' });
		runWithSignalOwner(healthy.signalOwner, () => value.snapshot());
		await tick();
		expect(load).toHaveBeenCalledOnce();
		expect(runWithSignalOwner(healthy.signalOwner, () => value.get())).toBe('healthy');
	} finally {
		healthy.dispose();
	}
});
