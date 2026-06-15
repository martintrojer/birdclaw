import { createFileRoute } from "@tanstack/react-router";
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useSelectedAccountId } from "#/components/account-selection";
import { InboxCard } from "#/components/InboxCard";
import { fetchQueryEnvelope, postAction } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
import type { InboxItem, InboxKind, InboxResponse } from "#/lib/types";
import {
	cx,
	emptyStateClass,
	feedClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	primaryButtonClass,
	secondaryButtonClass,
	tabButtonActiveClass,
	tabButtonClass,
	tabButtonIndicatorClass,
	tabStripClass,
	textFieldClass,
	textFieldShortClass,
	timestampClass,
} from "#/lib/ui";

export const Route = createFileRoute("/inbox")({
	component: InboxRoute,
});

const TABS: Array<{ value: InboxKind; label: string }> = [
	{ value: "mixed", label: "Mixed" },
	{ value: "mentions", label: "Mentions" },
	{ value: "dms", label: "DMs" },
];

function InboxRoute() {
	const queryClient = useQueryClient();
	const [kind, setKind] = useState<InboxKind>("mixed");
	const [minScore, setMinScore] = useState("40");
	const [hideLowSignal, setHideLowSignal] = useState(true);
	const [activeReplyId, setActiveReplyId] = useState<string | null>(null);
	const [replyDraft, setReplyDraft] = useState("");
	const [isSendingReply, setIsSendingReply] = useState(false);
	const [replyError, setReplyError] = useState<string | null>(null);
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const meta = statusQuery.data ?? null;
	const selectedAccountId = useSelectedAccountId(meta?.accounts);
	const inboxQueryKey = [
		...queryKeys.inbox,
		{
			hideLowSignal,
			kind,
			minScore,
			selectedAccountId: selectedAccountId ?? null,
		},
	] as const;
	const inboxQuery = useQuery({
		queryKey: inboxQueryKey,
		queryFn: async ({ signal }) => {
			const url = new URL("/api/inbox", window.location.origin);
			url.searchParams.set("kind", kind);
			url.searchParams.set("minScore", minScore);
			if (selectedAccountId) {
				url.searchParams.set("account", selectedAccountId);
			}
			if (hideLowSignal) {
				url.searchParams.set("hideLowSignal", "1");
			}

			const response = await fetch(url, { signal });
			if (!response.ok) {
				throw new Error(`Inbox request failed (${String(response.status)})`);
			}
			return (await response.json()) as InboxResponse;
		},
		placeholderData: keepPreviousData,
		staleTime: 5 * 60_000,
	});
	const items = inboxQuery.data?.items ?? [];
	const stats = inboxQuery.data?.stats ?? null;
	const scoreMutation = useMutation({
		mutationFn: () =>
			postAction({
				kind: "scoreInbox",
				scoreKind: kind,
				account: selectedAccountId,
				limit: 8,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: queryKeys.inbox }),
	});

	const subtitle = useMemo(() => {
		if (!meta || !stats) return "Ranking unreplied mentions and DMs...";
		return `${String(stats.total)} in queue · ${String(stats.openai)} OpenAI scored · ${meta.transport.statusText}`;
	}, [meta, stats]);

	async function scoreNow() {
		await scoreMutation.mutateAsync();
	}

	async function sendReply(item: InboxItem) {
		if (!replyDraft.trim()) return;
		setIsSendingReply(true);
		setReplyError(null);
		try {
			await postAction(
				item.entityKind === "dm"
					? {
							kind: "replyDm",
							conversationId: item.entityId,
							text: replyDraft,
						}
					: {
							kind: "replyTweet",
							accountId: item.accountId,
							tweetId: item.entityId,
							text: replyDraft,
						},
			);
			setReplyDraft("");
			setActiveReplyId(null);
			await queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
		} catch (error) {
			setReplyError(error instanceof Error ? error.message : "Reply failed");
		} finally {
			setIsSendingReply(false);
		}
	}

	return (
		<>
			<header className={pageHeaderClass}>
				<div className={pageHeaderRowClass}>
					<div className="flex min-w-0 flex-col">
						<h1 className={pageTitleClass}>Inbox</h1>
						<p className={pageSubtitleClass}>{subtitle}</p>
					</div>
					<button
						className={primaryButtonClass}
						disabled={scoreMutation.isPending}
						onClick={() => void scoreNow()}
						type="button"
					>
						<Sparkles className="size-4" strokeWidth={2.2} />
						{scoreMutation.isPending ? "Scoring..." : "Score with OpenAI"}
					</button>
				</div>
				<div className="flex flex-wrap items-center gap-2 px-4 pb-3">
					<input
						className={cx(textFieldClass, textFieldShortClass)}
						inputMode="numeric"
						onChange={(event) => setMinScore(event.target.value)}
						placeholder="Min AI score"
						value={minScore}
					/>
					<button
						className={secondaryButtonClass}
						onClick={() => setHideLowSignal((value) => !value)}
						type="button"
						aria-pressed={hideLowSignal}
					>
						{hideLowSignal ? "Hide low-signal" : "Show all"}
					</button>
				</div>
				<div className={tabStripClass}>
					{TABS.map((tab) => {
						const active = kind === tab.value;
						return (
							<button
								key={tab.value}
								type="button"
								aria-pressed={active}
								className={cx(tabButtonClass, active && tabButtonActiveClass)}
								onClick={() => setKind(tab.value)}
							>
								<span className="relative inline-flex flex-col items-center justify-center py-1">
									{tab.value}
									{active ? <span className={tabButtonIndicatorClass} /> : null}
								</span>
							</button>
						);
					})}
				</div>
			</header>
			{replyError ? (
				<p className={cx(timestampClass, "px-4 py-2 text-red-500")}>
					{replyError}
				</p>
			) : null}
			<section className={feedClass}>
				{items.length === 0 ? (
					<div className={emptyStateClass}>Inbox clear.</div>
				) : null}
				{items.map((item) => (
					<InboxCard
						key={item.id}
						isReplying={activeReplyId === item.id}
						item={item}
						onReplyChange={setReplyDraft}
						onReplySend={() => void sendReply(item)}
						onReplyToggle={() => {
							setReplyError(null);
							if (activeReplyId === item.id) {
								setActiveReplyId(null);
								setReplyDraft("");
								return;
							}
							setActiveReplyId(item.id);
							setReplyDraft("");
						}}
						replyDraft={activeReplyId === item.id ? replyDraft : ""}
					/>
				))}
			</section>
			{isSendingReply ? (
				<p className={cx(timestampClass, "px-4 py-2")}>Sending reply...</p>
			) : null}
		</>
	);
}
