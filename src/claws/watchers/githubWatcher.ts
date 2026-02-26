import cron from "node-cron";
import { listAllUsers } from "../../db/userStore";
import { getUserProfile } from "../../db/profileStore";
import { config } from "../../config";

const CHECK_CRON = "0 12 * * *"; // daily at 12:00 UTC
const MAX_REPOS = 3;

async function fetchRepo(repo: string): Promise<{ ok: boolean; text: string }> {
    const headers: Record<string, string> = { "User-Agent": "xclaw-github-watcher" };
    if (config.GITHUB_TOKEN) headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;

    try {
        const res = await fetch(`https://api.github.com/repos/${repo}`, { headers });
        if (!res.ok) return { ok: false, text: `Failed ${repo}: ${res.status}` };
        const data = await res.json();
        const stars = data.stargazers_count ?? 0;
        const forks = data.forks_count ?? 0;
        const issues = data.open_issues_count ?? 0;
        const watchers = data.subscribers_count ?? 0;
        const desc = data.description ?? "(no description)";
        return {
            ok: true,
            text: `${repo}: ⭐ ${stars} | 🍴 ${forks} | 👀 ${watchers} | ❗ ${issues} — ${desc}`,
        };
    } catch (err: any) {
        return { ok: false, text: `Failed ${repo}: ${err?.message ?? err}` };
    }
}

export function startGithubWatcher(
    sendMessage: (chatId: number, text: string, extra?: { reply_markup?: any }) => Promise<void>
): void {
    cron.schedule(CHECK_CRON, async () => {
        try {
            const users = await listAllUsers();
            if (!users || users.length === 0) return;

            for (const user of users) {
                const telegramId = user.telegram_id;
                const profile = await getUserProfile(telegramId);
                const repos = (profile.watchedRepos ?? []).slice(0, MAX_REPOS);
                if (!repos.length) continue;

                const lines: string[] = [];
                for (const repo of repos) {
                    const result = await fetchRepo(repo);
                    lines.push(result.text);
                }

                if (!lines.length) continue;

                const message = [
                    "🛠️ GitHub Watcher",
                    `Repos: ${repos.join(", ")}`,
                    "",
                    ...lines,
                ]
                    .filter(Boolean)
                    .join("\n");

                const reply_markup = {
                    inline_keyboard: [
                        [
                            { text: "Draft X post", callback_data: "gh:draft" },
                            { text: "Dismiss", callback_data: "gh:dismiss" },
                        ],
                    ],
                };

                try {
                    await sendMessage(telegramId, message, { reply_markup });
                    console.log(`[github-watcher] Sent update to ${telegramId} (${repos.length} repos)`);
                } catch (err) {
                    console.error(`[github-watcher] Failed to send to ${telegramId}:`, err);
                }
            }
        } catch (err) {
            console.error("[github-watcher] Loop failed:", err);
        }
    });

    console.log(`[github-watcher] Scheduler active — cron: "${CHECK_CRON}"`);
}
