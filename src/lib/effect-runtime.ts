import { Cause, Effect, Exit, Option } from "effect";

export function tryPromise<A>(
	try_: () => PromiseLike<A>,
): Effect.Effect<A, unknown> {
	return Effect.tryPromise({
		try: try_,
		catch: (cause) => cause,
	});
}

export function runEffectPromise<A, E>(
	effect: Effect.Effect<A, E>,
): Promise<A> {
	return Effect.runPromiseExit(effect).then((exit) => {
		if (Exit.isSuccess(exit)) return exit.value;
		throw effectExitError(exit);
	});
}

export function effectExitError<E>(exit: Exit.Exit<unknown, E>): E | Error {
	if (Exit.isSuccess(exit)) {
		return new Error("Effect completed successfully");
	}
	const failure = Cause.failureOption(exit.cause);
	if (Option.isSome(failure)) return failure.value;
	const squashed = Cause.squash(exit.cause);
	return squashed instanceof Error ? squashed : new Error(String(squashed));
}

export function runEffectBackground<A, E>(
	effect: Effect.Effect<A, E>,
	handlers: {
		onSuccess: (value: A) => void;
		onFailure: (error: E | Error) => void;
	},
) {
	void Effect.runPromiseExit(effect).then((exit) => {
		if (Exit.isSuccess(exit)) {
			handlers.onSuccess(exit.value);
			return;
		}
		handlers.onFailure(effectExitError(exit));
	});
}
