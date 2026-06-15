import { Effect } from "effect";
import {
	runSyncPlanEffect,
	type PaginationPageContext,
	type PaginationStopReason,
} from "./sync-plan";

export type { PaginationPageContext, PaginationStopReason } from "./sync-plan";

export interface PaginatedSyncResult<Page> {
	complete: boolean;
	fetched: number;
	nextCursor?: string;
	pages: Page[];
	stopReason: PaginationStopReason;
}

export function collectPaginatedEffect<Page, ErrorType>({
	fetchPage,
	getItemCount,
	getNextCursor,
	initialCursor,
	maxItems,
	maxPages,
	onPage,
	pageDelayMs,
	shouldStop,
}: {
	fetchPage: (context: {
		cursor?: string;
		fetched: number;
		pageIndex: number;
	}) => Effect.Effect<Page, ErrorType>;
	getItemCount?: (page: Page) => number;
	getNextCursor: (page: Page) => string | null | undefined;
	initialCursor?: string;
	maxItems?: number;
	maxPages?: number;
	onPage?: (context: PaginationPageContext<Page>) => void;
	pageDelayMs?: number;
	shouldStop?: (context: Omit<PaginationPageContext<Page>, "done">) => boolean;
}): Effect.Effect<PaginatedSyncResult<Page>, ErrorType> {
	return runSyncPlanEffect({
		fetchPage,
		getNextCursor,
		...(getItemCount ? { getItemCount } : {}),
		...(initialCursor ? { initialCursor } : {}),
		...(maxItems !== undefined ? { maxItems } : {}),
		...(maxPages !== undefined ? { maxPages } : {}),
		...(onPage
			? {
					onPage: (context: {
						cursor?: string;
						fetched: number;
						page: Page;
						pageIndex: number;
						pageNumber: number;
						stopReason?: PaginationStopReason | "error";
						done: boolean;
					}) =>
						onPage({
							...context,
							stopReason: context.stopReason as
								| PaginationStopReason
								| undefined,
						}),
				}
			: {}),
		...(pageDelayMs !== undefined ? { pageDelayMs } : {}),
		...(shouldStop
			? {
					shouldStop: (context: {
						cursor?: string;
						fetched: number;
						page: Page;
						pageIndex: number;
						pageNumber: number;
					}) => shouldStop(context),
				}
			: {}),
	}).pipe(
		Effect.map(
			(result) =>
				({
					complete: result.complete,
					fetched: result.fetched,
					...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
					pages: result.pages,
					stopReason: result.stopReason as PaginationStopReason,
				}) satisfies PaginatedSyncResult<Page>,
		),
	);
}
