module server {
	import type { ServerCallContext } from 'octane/server';

	export function fixtureContextualRpc(value: string, context: ServerCallContext) {
		return 'contextual-rpc:' + value;
	}
}

import { fixtureContextualRpc } from 'server';

export function ContextualRpcProbe() @{
	<button onClick={() => fixtureContextualRpc('browser')}>Call contextual server</button>
}
