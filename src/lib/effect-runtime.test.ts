import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	runEffectBackground,
	runEffectPromise,
	tryPromise,
} from "./effect-runtime";

describe("effect runtime boundary", () => {
	it("throws original promise errors instead of UnknownException wrappers", async () => {
		const original = Object.assign(new Error("socket reset"), {
			code: "ECONNRESET",
		});

		let rejected: unknown;
		try {
			await runEffectPromise(tryPromise(() => Promise.reject(original)));
		} catch (error) {
			rejected = error;
		}

		expect(rejected).toBe(original);
		expect(String(rejected)).not.toContain("UnknownException");
	});

	it("routes background Effect exits to success and failure handlers", async () => {
		const success = new Promise<string>((resolve) => {
			runEffectBackground(Effect.succeed("ok"), {
				onSuccess: resolve,
				onFailure: (error) => {
					throw error;
				},
			});
		});
		await expect(success).resolves.toBe("ok");

		const original = new Error("background failed");
		const failure = new Promise<unknown>((resolve) => {
			runEffectBackground(Effect.fail(original), {
				onSuccess: () => {
					throw new Error("unexpected success");
				},
				onFailure: resolve,
			});
		});
		await expect(failure).resolves.toBe(original);
	});
});
