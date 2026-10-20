# ask

Send the products team a link to open brief questions. They pick one option per question on their phone, and the matching brief items close when they're done.

- `ask new 50 51 52`: Claude drafts the questions from those brief items (and their linked PRs) into `drafts/`. Review the file, then run `ask push FILE`. In a terminal it opens `$EDITOR` and asks before pushing.
- `ask push FILE [--thread KEY]`: creates the link and prints it with a Slack line. `--thread` (or `thread:` in the draft) names the Toucan thread (`[threads]` in `toucan.toml`) whose agent is waiting on the answers; the poller wakes it.
- `ask show TOKEN|URL` prints the answers so far. `ask wait TOKEN|URL [--timeout MIN]` is for an agent to run in the background: it exits as soon as an answer or the link's status changes (exit 3 after 110 minutes with no change).
- `ask list`, `ask revoke TOKEN|URL [--discard]`. A revoked link's answers are still reported and close their brief items; `--discard` drops them (use it for test links).
- `ask poll` runs every minute (`systemd/ask-poll.timer`, symlinked into `~/.config/systemd/user`):
  - When a link is complete, expired or revoked, it runs `brief done ID --note …` for each answered question and sends a summary to every channel: ntfy (high priority, the URL in `projects.toml`), WhatsApp to `ASK_WHATSAPP` if set, and the link's Toucan thread.
  - While a link is open, it sends a "started answering" notice when answers come in and an "answered N of M so far" notice once they stop for 10 minutes. Those go to ntfy and the thread, not WhatsApp, and close nothing.
  - Delivery is at least once: a link counts as reported only after every brief item is closed and every channel has accepted the notice. Each channel is retried every minute; after 6 hours of failures it is given up (logged as `GIVING UP`) so the link can still be reported. Per-channel state is in `~/.local/state/ask/delivered.json`; failures show in `journalctl --user -u ask-poll`.

Each option in a draft has `label`, `detail` (the trade-off), `chooseIf` (shown as "Choose this if …") and `suits: [us, you]` (shown as Suits us (dev) / Suits you (products)). Every question also gets a "Something else" text answer (option id `other` is reserved); the poller's brief note then reads "Something else: …". For a test link, copy the draft without its `brief:` keys so answering it closes nothing.

Each link uses one random token. Answers save one at a time and can be changed until the last question is answered; then the link closes. Links expire after 14 days (`days:` in the draft).

## Deploy

The CLI and the Convex functions change together (`admin:collect`'s result shape), so stop the poller first: `systemctl --user stop ask-poll.timer`, wait until `systemctl --user is-active ask-poll.service` isn't `activating`, deploy Convex, then `systemctl --user daemon-reload && systemctl --user start ask-poll.timer`.

- Convex: `pnpm exec convex deploy`. The CLI calls internal functions with `convex run --prod`, so admin access is your Convex login.
- Vercel: `vercel deploy --prod`, with `NEXT_PUBLIC_CONVEX_URL` set on the project.
- Put `ASK_URL=https://your-site.example` in `.env.local` (ignored by git) so the CLI prints the right links.
