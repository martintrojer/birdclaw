// @vitest-environment node
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { fetchTweetMedia } from "./media-fetch";

const tempDirs: string[] = [];

function home() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-media-fetch-"));
	tempDirs.push(dir);
	process.env.BIRDCLAW_HOME = dir;
	return dir;
}

function insertTweet(id: string, media: unknown[], createdAt = "2026-05-01T12:00:00.000Z") {
	getNativeDb({ seedDemoData: false })
		.prepare(
			`
      insert into tweets (
        id, account_id, author_profile_id, kind, text, created_at,
        is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
        entities_json, media_json, quoted_tweet_id
      ) values (?, 'acct_primary', 'profile_me', 'home', ?, ?, 0, null, 0, ?, 0, 0, '{}', ?, null)
    `,
		)
		.run(id, `tweet ${id}`, createdAt, media.length, JSON.stringify(media));
}

function pbs(name: string) {
	return { url: `https://pbs.twimg.com/media/${name}.jpg`, type: "image" };
}

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	vi.unstubAllGlobals();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("media fetch", () => {
	it("dry-runs missing pbs media without downloading", async () => {
		const root = home();
		insertTweet("tweet_1", [
			pbs("demo"),
			{ url: "https://video.twimg.com/ext_tw_video/1/pu/vid/x.mp4" },
		]);
		const fetchMock = vi.fn(async () => {
			throw new Error("must not fetch");
		});

		const result = await fetchTweetMedia({ dryRun: true, fetchImpl: fetchMock });

		expect(result).toMatchObject({
			fetched: 0,
			would_fetch: [
				{
					media_key: "demo",
					tweet_id: "tweet_1",
					url: "https://pbs.twimg.com/media/demo.jpg",
					path: path.join(root, "media", "originals", "demo.jpg"),
				},
			],
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(existsSync(path.join(root, "media", "originals", "demo.jpg"))).toBe(false);
	});

	it("skips existing files by media key", async () => {
		const root = home();
		const mediaDir = path.join(root, "media", "originals");
		mkdirSync(mediaDir, { recursive: true });
		writeFileSync(path.join(mediaDir, "demo.jpg"), "cached");
		insertTweet("tweet_1", [pbs("demo")]);
		const fetchMock = vi.fn();

		await expect(fetchTweetMedia({ fetchImpl: fetchMock })).resolves.toMatchObject({
			fetched: 0,
			skipped_cached: 1,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("backs off and retries once after 429", async () => {
		const root = home();
		insertTweet("tweet_1", [pbs("demo")]);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("slow", { status: 429 }))
			.mockResolvedValueOnce(
				new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				}),
			);
		const sleeps: number[] = [];

		const result = await fetchTweetMedia({
			fetchImpl: fetchMock,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			pacingMs: 0,
		});

		expect(result).toMatchObject({
			ok: true,
			fetched: 1,
			skipped_cached: 0,
			failed: 0,
			rate_limited: 1,
			bytes: 3,
			failures: [],
		});
		expect(sleeps).toEqual([1000]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(readFileSync(path.join(root, "media", "originals", "demo.jpg"))).toEqual(
			Buffer.from([1, 2, 3]),
		);
	});

	it("records a failure when retry-max is exhausted", async () => {
		home();
		insertTweet("tweet_1", [pbs("demo")]);
		const fetchMock = vi.fn(async () => new Response("no", { status: 429 }));

		const result = await fetchTweetMedia({
			fetchImpl: fetchMock,
			sleep: async () => {},
			pacingMs: 0,
			retryMax: 1,
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({
			failed: 1,
			rate_limited: 1,
			failures: [
				{
					media_key: "demo",
					url: "https://pbs.twimg.com/media/demo.jpg",
					reason: "429",
				},
			],
		});
	});

	it("paces sequential requests between media downloads", async () => {
		home();
		insertTweet("tweet_1", [pbs("one")], "2026-05-02T12:00:00.000Z");
		insertTweet("tweet_2", [pbs("two")]);
		let clock = 0;
		const sleeps: number[] = [];
		const fetchMock = vi.fn(async () => new Response(new Uint8Array([1])));

		const result = await fetchTweetMedia({
			fetchImpl: fetchMock,
			now: () => clock,
			sleep: async (ms) => {
				sleeps.push(ms);
				clock += ms;
			},
			pacingMs: 25,
			parallel: 1,
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(sleeps).toEqual([25]);
		expect(result.duration_ms).toBeGreaterThanOrEqual(25);
	});

});
