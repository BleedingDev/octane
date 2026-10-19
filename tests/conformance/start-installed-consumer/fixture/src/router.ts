import { createRouter } from '@octanejs/tanstack-router';
import { routeTree } from './routeTree.gen';

export function getRouter() {
	return createRouter({ routeTree });
}
