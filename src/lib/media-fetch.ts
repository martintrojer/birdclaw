/**
 * Respectful media caching for tweet records already present in birdclaw.
 *
 * This is not a scraper: it never crawls, enumerates, or derives Twitter/X CDN
 * URLs. It only downloads image URLs already stored in `tweets.media_json`,
 * skips files present on disk, paces requests, and backs off on 429.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getBirdclawPaths } from "./config";
import { getNativeDb } from "./db";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Row = { id: string; media_json: string };
type Candidate = { mediaKey: string; tweetId: string; url: string; path: string };
type FetchOneResult = {
	fetched: number;
	bytes: number;
	rateLimited: boolean;
	failure?: MediaFetchResult["failures"][number];
};

export type MediaFetchResult = {
	ok: true;
	fetched: number;
	skipped_cached: number;
	failed: number;
	rate_limited: number;
	bytes: number;
	duration_ms: number;
	failures: Array<{ media_key: string; url: string; reason: string }>;
	dry_run?: true;
	would_fetch?: Array<{
		media_key: string;
		tweet_id: string;
		url: string;
		path: string;
	}>;
};

export type MediaFetchOptions = {
	account?: string;
	limit?: number;
	kind?: string;
	since?: string;
	parallel?: number;
	pacingMs?: number;
	retryMax?: number;
	dryRun?: boolean;
	fetchImpl?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	userAgent?: string;
};

const PBS_PREFIXES = [
	"/media/",
	"/ext_tw_video_thumb/",
	"/amplify_video_thumb/",
	"/tweet_video_thumb/",
	"/profile_images/",
] as const;
const packageVersion = (
	JSON.parse(
		readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
	) as { version?: string }
).version;

function defaultSleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function extension(url: URL) {
	const ext = path.posix.extname(url.pathname).toLowerCase();
	if (ext === ".jpeg" || ext === ".jpg") return ".jpg";
	if (ext === ".png" || ext === ".webp" || ext === ".gif" || ext === ".svg") {
		return ext;
	}
	const format = url.searchParams.get("format")?.toLowerCase();
	return format === "png" || format === "webp" || format === "gif" ? `.${format}` : ".jpg";
}

function pbsMedia(urlValue: string, dir: string, tweetId: string): Candidate | null {
	let url: URL;
	try {
		url = new URL(urlValue);
	} catch {
		return null;
	}
	if (
		url.protocol !== "https:" ||
		url.hostname !== "pbs.twimg.com" ||
		!PBS_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
	) {
		return null;
	}
	const mediaKey = path.posix.parse(path.posix.basename(url.pathname)).name;
	return {
		mediaKey,
		tweetId,
		url: url.toString(),
		path: path.join(dir, `${mediaKey}${extension(url)}`),
	};
}

function rowCandidates(row: Row, dir: string) {
	let items: unknown;
	try {
		items = JSON.parse(row.media_json);
	} catch {
		return [];
	}
	if (!Array.isArray(items)) return [];
	return items
		.map((item) =>
			item &&
			typeof item === "object" &&
			!Array.isArray(item) &&
			typeof (item as Record<string, unknown>).url === "string"
				? pbsMedia((item as { url: string }).url, dir, row.id)
				: null,
		)
		.filter((item): item is Candidate => item !== null);
}

function queryRows(options: MediaFetchOptions) {
	const params: Array<string | number> = [];
	let sql = `
    select t.id, t.media_json
    from tweets t
    where t.media_count > 0
      and t.media_json not in ('', '[]', 'null')
  `;
	if (options.account && options.account !== "all") {
		params.push(options.account);
		sql += " and t.account_id = ?";
	}
	if (options.kind && options.kind !== "all") {
		params.push(options.kind.trim().toLowerCase());
		sql += " and t.kind = ?";
	}
	if (options.since) {
		params.push(options.since);
		sql += " and t.created_at >= ?";
	}
	sql += " order by t.created_at desc, t.id desc";
	if (options.limit !== undefined) {
		params.push(Math.max(0, Math.floor(options.limit)));
		sql += " limit ?";
	}
	return getNativeDb().prepare(sql).all(params) as Row[];
}

function collect(options: MediaFetchOptions, dir: string) {
	const seen = new Set<string>();
	const candidates: Candidate[] = [];
	const would_fetch: NonNullable<MediaFetchResult["would_fetch"]> = [];
	let skipped_cached = 0;

	for (const row of queryRows(options)) {
		for (const item of rowCandidates(row, dir)) {
			if (seen.has(item.mediaKey)) continue;
			seen.add(item.mediaKey);
			if (existsSync(item.path)) {
				skipped_cached += 1;
			} else if (options.dryRun) {
				would_fetch.push({
					media_key: item.mediaKey,
					tweet_id: item.tweetId,
					url: item.url,
					path: item.path,
				});
			} else {
				candidates.push(item);
			}
		}
	}
	return { candidates, skipped_cached, would_fetch };
}

function fail(item: Candidate, reason: string, rateLimited = false) {
	return {
		fetched: 0,
		bytes: 0,
		rateLimited,
		failure: { media_key: item.mediaKey, url: item.url, reason },
	};
}

async function fetchOne({
	item,
	fetchImpl,
	sleep,
	retryMax,
	userAgent,
}: {
	item: Candidate;
	fetchImpl: FetchLike;
	sleep: (ms: number) => Promise<void>;
	retryMax: number;
	userAgent: string;
}): Promise<FetchOneResult> {
	let rateLimited = false;
	for (let attempt = 0; attempt <= retryMax; attempt += 1) {
		let response: Response;
		try {
			response = await fetchImpl(item.url, {
				headers: { "user-agent": userAgent },
			});
		} catch (error) {
			return fail(item, error instanceof Error ? error.message : String(error), rateLimited);
		}
		if (response.status === 429) {
			rateLimited = true;
			if (attempt < retryMax) {
				await sleep(1000 * 2 ** attempt);
				continue;
			}
			return fail(item, "429", true);
		}
		if (!response.ok) return fail(item, String(response.status), rateLimited);

		const buffer = Buffer.from(await response.arrayBuffer());
		const tmpPath = `${item.path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(tmpPath, buffer);
		await rename(tmpPath, item.path);
		return { fetched: 1, bytes: buffer.byteLength, rateLimited };
	}
	return fail(item, "retry exhausted", rateLimited);
}

export async function fetchTweetMedia(options: MediaFetchOptions = {}) {
	const now = options.now ?? Date.now;
	const startedAt = now();
	const sleep = options.sleep ?? defaultSleep;
	const fetchImpl = options.fetchImpl ?? fetch;
	const retryMax = Math.max(0, Math.floor(options.retryMax ?? 3));
	const parallel = Math.min(5, Math.max(1, Math.floor(options.parallel ?? 1)));
	const pacingMs = Math.max(0, Math.floor(options.pacingMs ?? 250));
	const userAgent =
		options.userAgent ??
		`birdclaw/${packageVersion ?? "0.0.0"} (https://github.com/steipete/birdclaw)`;
	const { mediaOriginalsDir } = getBirdclawPaths();
	mkdirSync(mediaOriginalsDir, { recursive: true });

	const { candidates, skipped_cached, would_fetch } = collect(
		options,
		mediaOriginalsDir,
	);
	const result: MediaFetchResult = {
		ok: true,
		fetched: 0,
		skipped_cached,
		failed: 0,
		rate_limited: 0,
		bytes: 0,
		duration_ms: 0,
		failures: [],
		...(options.dryRun ? { dry_run: true as const, would_fetch } : {}),
	};

	if (!options.dryRun) {
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(parallel, candidates.length) }, async () => {
				let lastStart: number | null = null;
				for (;;) {
					const item = candidates[next++];
					if (!item) return;
					const waitMs = lastStart !== null
						? Math.max(0, lastStart + pacingMs - now())
						: 0;
					if (waitMs > 0) await sleep(waitMs);
					lastStart = now();
					const fetched = await fetchOne({
						item,
						fetchImpl,
						sleep,
						retryMax,
						userAgent,
					});
					result.fetched += fetched.fetched;
					result.bytes += fetched.bytes;
					if (fetched.rateLimited) result.rate_limited += 1;
					if (fetched.failure) result.failures.push(fetched.failure);
				}
			}),
		);
	}

	result.failed = result.failures.length;
	result.duration_ms = Math.max(0, Math.round(now() - startedAt));
	return result;
}

export function formatMediaFetchResult(result: MediaFetchResult) {
	if (result.dry_run) {
		return [
			...(result.would_fetch ?? []).map(
				(item) => `${item.media_key}\t${item.url}\t${item.path}`,
			),
			`would_fetch=${result.would_fetch?.length ?? 0} skipped_cached=${result.skipped_cached}`,
		].join("\n");
	}
	return [
		`fetched=${result.fetched}`,
		`skipped_cached=${result.skipped_cached}`,
		`failed=${result.failed}`,
		`rate_limited=${result.rate_limited}`,
		`bytes=${result.bytes}`,
		`duration_ms=${result.duration_ms}`,
	].join(" ");
}
