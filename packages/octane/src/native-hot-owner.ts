import type {
	getNativeHotSignalComponentBuild,
	createNativeHotSignalOwnerProof,
	admitHotSignalPublisher,
	prepareNativePublisherReplacement,
} from './signals/hot-declarations.js';
import { formatClientError } from './error-codes.client.generated.js';

/** Private, engine-free seam installed only by compiler-emitted dev signal metadata. */
export interface NativeHotOwnerDriver {
	readonly getComponentBuild: typeof getNativeHotSignalComponentBuild;
	readonly createProof: typeof createNativeHotSignalOwnerProof;
	readonly admit: typeof admitHotSignalPublisher;
	readonly prepareReplacement: typeof prepareNativePublisherReplacement;
}

let nativeHotOwnerDriver: NativeHotOwnerDriver | undefined;

export function installNativeHotOwnerDriver(driver: NativeHotOwnerDriver): void {
	if (nativeHotOwnerDriver !== undefined && nativeHotOwnerDriver !== driver)
		throw new Error(formatClientError(363));
	nativeHotOwnerDriver = driver;
}

export function getNativeHotOwnerDriver(): NativeHotOwnerDriver | undefined {
	return nativeHotOwnerDriver;
}
