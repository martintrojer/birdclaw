import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { getBlocksResponse } from "#/lib/blocks";
import { jsonResponse, runRouteEffect } from "#/lib/http-effect";

function parseNumber(value: string | null) {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export const Route = createFileRoute("/api/blocks")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.sync(() => {
						const url = new URL(request.url);
						return jsonResponse(
							getBlocksResponse({
								accountId: url.searchParams.get("account") ?? undefined,
								search: url.searchParams.get("search") ?? undefined,
								limit: parseNumber(url.searchParams.get("limit")) ?? 12,
							}),
						);
					}),
				),
		},
	},
});
