import { Effect } from "effect";
import { runEffectPromise, tryPromise } from "./effect-runtime";

export function jsonResponse(data: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			"content-type": "application/json",
			...init?.headers,
		},
	});
}

export function requestJsonEffect<T = Record<string, unknown>>(
	request: Request,
	fallback?: T,
): Effect.Effect<T, unknown> {
	return tryPromise(() => request.json() as Promise<T>).pipe(
		Effect.catchAll((error) =>
			fallback === undefined ? Effect.fail(error) : Effect.succeed(fallback),
		),
	);
}

export function runRouteEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
	return runEffectPromise(effect);
}
