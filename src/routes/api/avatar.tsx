import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { readCachedAvatarEffect } from "#/lib/avatar-cache";
import { jsonResponse, runRouteEffect } from "#/lib/http-effect";

export const Route = createFileRoute("/api/avatar")({
	server: {
		handlers: {
			GET: ({ request }) =>
				runRouteEffect(
					Effect.gen(function* () {
						const url = new URL(request.url);
						const profileId = url.searchParams.get("profileId")?.trim();

						if (!profileId) {
							return jsonResponse(
								{ ok: false, message: "Missing profileId" },
								{ status: 400 },
							);
						}

						const avatar = yield* readCachedAvatarEffect(profileId);
						if (!avatar) {
							return jsonResponse(
								{ ok: false, message: "Avatar not found" },
								{ status: 404 },
							);
						}

						return new Response(new Uint8Array(avatar.buffer), {
							headers: {
								"cache-control": "public, max-age=86400, immutable",
								"content-type": avatar.contentType,
							},
						});
					}),
				),
		},
	},
});
