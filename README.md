# ask

Send the products team a link to open brief questions. They pick one option per question on their phone, and the matching brief items close when they're done.

- `ask new 50 51 52`: Claude drafts the questions from those brief items (and their linked PRs) into `drafts/`. Review the file, then run `ask push FILE`. In a terminal it opens `$EDITOR` and asks before pushing.
- `ask push FILE`: creates the link and prints it with a Slack line.
- `ask list`, `ask revoke TOKEN|URL`.
- `ask poll` runs every five minutes (`systemd/ask-poll.timer`, symlinked into `~/.config/systemd/user`). When a set is complete or has expired, it runs `brief done ID --note …` for each answered question and pushes a summary to the ntfy URL in `projects.toml`.

Each link uses one random token. Answers save one at a time and can be changed until the last question is answered; then the link closes. Links expire after 14 days (`days:` in the draft).

## Deploy

- Convex: `pnpm exec convex deploy`. The CLI calls internal functions with `convex run --prod`, so admin access is your Convex login.
- Vercel: `vercel deploy --prod`, with `NEXT_PUBLIC_CONVEX_URL` set on the project.
