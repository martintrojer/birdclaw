import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { maybeAutoUpdateBackupEffect } from "#/lib/backup";
import { jsonResponse, runRouteEffect } from "#/lib/http-effect";
import { getQueryEnvelopeEffect } from "#/lib/queries";

export const Route = createFileRoute("/api/status")({
	server: {
		handlers: {
			GET: () =>
				runRouteEffect(
					Effect.gen(function* () {
						yield* maybeAutoUpdateBackupEffect();
						return jsonResponse(yield* getQueryEnvelopeEffect());
					}),
				),
		},
	},
});
