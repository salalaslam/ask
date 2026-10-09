#!/usr/bin/env node
// ask: send products a link with brief questions, and close the brief items once they answer.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const USAGE = `usage:
  ask new BRIEF_ID... [--title TEXT]  draft questions from brief items, review, push
  ask push FILE                       create a link from a draft file
  ask list                            recent sets and their answers
  ask revoke TOKEN                    close a link by hand
  ask poll                            close answered brief items, notify (run by ask-poll.timer)

Drafts are written to ~/ask/drafts/. ASK_URL overrides the site URL.`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = process.env.ASK_URL;
const BRIEF = "brief";
const BRIEF_DB = join(homedir(), ".local/state/brief/brief.sqlite");
const PROJECTS = join(homedir(), ".config/teams-reader/projects.toml");
const DEFAULT_DAYS = 14;

function convex(fn, args = {}) {
  const out = execFileSync(
    join(ROOT, "node_modules/.bin/convex"),
    ["run", "--prod", fn, JSON.stringify(args)],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return out.trim() ? JSON.parse(out) : null;
}

// brief and projects.toml are Python-side; read them with Python rather than add deps.
function python(code, ...args) {
  return JSON.parse(execFileSync("python3", ["-c", code, ...args], { encoding: "utf8" }));
}

function briefItems(ids) {
  const rows = python(
    `import json, sqlite3, sys
c = sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True); c.row_factory = sqlite3.Row
ids = [int(i) for i in sys.argv[2:]]
q = f"SELECT id, project, person, what, url, status FROM items WHERE id IN ({','.join('?' * len(ids))})"
print(json.dumps([dict(r) for r in c.execute(q, ids)]))`,
    BRIEF_DB,
    ...ids,
  );
  const missing = ids.filter((id) => !rows.some((r) => r.id === Number(id)));
  if (missing.length) die(`No brief item ${missing.join(", ")}.`);
  const closed = rows.filter((r) => r.status !== "open");
  if (closed.length) die(`Brief item ${closed.map((r) => r.id).join(", ")} is already closed.`);
  return ids.map((id) => rows.find((r) => r.id === Number(id)));
}

function projectRepos(project) {
  return python(
    `import json, sys, tomllib, glob, os
p = tomllib.load(open(sys.argv[1], 'rb')).get('projects', {}).get(sys.argv[2], {})
print(json.dumps([d for r in p.get('repos', []) for d in sorted(glob.glob(os.path.expanduser(r)))]))`,
    PROJECTS,
    project,
  );
}

function ntfyUrl() {
  return python(
    `import json, sys, tomllib
print(json.dumps(tomllib.load(open(sys.argv[1], 'rb')).get('notify', {}).get('ntfy')))`,
    PROJECTS,
  );
}

const DRAFT_PROMPT = `You are drafting multiple-choice questions for a product team who will answer on a phone.
Each brief item below is a question the developer already asked them in Slack. Turn each into one question.

Look up what you need first: open the linked PR with \`gh pr view URL\` (and its diff if it helps),
and read the code in the repo you're in. Don't change anything.

Rules:
- Plain English for a non-developer. No file names, PR numbers, function names or jargon they wouldn't use.
- title: the question itself, under 12 words.
- context: one or two short sentences: what the situation is and why it needs their decision.
- 2 to 4 options. id: short kebab-case slug. label: under 8 words. detail: one sentence with the
  consequence or trade-off of picking it (under 25 words).
- suits: which side each option works best for. "us" = the dev team (least work, least risk, already
  built), "you" = the products team (best for the people using it and the business). An option can suit both or neither;
  mark at least one option per question for each side.
- Keep the options the developer listed in the brief item, in the same order; add one only if it is
  an obvious missing choice.
- Keep domain terms the team uses as they write them, untranslated.

Reply with only JSON, no code fences:
{"questions": [{"brief": <brief id>, "title": "...", "context": "...",
  "options": [{"id": "...", "label": "...", "detail": "...", "suits": ["us", "you"]}]}]}

Brief items:
`;

function draft(items) {
  const repos = projectRepos(items[0].project);
  const prompt =
    DRAFT_PROMPT +
    items.map((i) => `- #${i.id} (${i.project}, asked ${i.person}): ${i.what}${i.url ? ` ${i.url}` : ""}`).join("\n");
  console.error(`Drafting ${items.length} question(s) with claude…`);
  const run = spawnSync(
    "claude",
    ["-p", prompt, "--output-format", "json", "--allowedTools", "Read,Grep,Glob,Bash(gh pr view:*),Bash(gh pr diff:*)"],
    { cwd: repos[0] ?? homedir(), encoding: "utf8", maxBuffer: 64 << 20 },
  );
  if (run.status !== 0) die(`claude failed:\n${run.stderr || run.stdout}`);
  const text = JSON.parse(run.stdout).result.trim().replace(/^```(json)?\s*|\s*```$/g, "");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).questions;
}

async function cmdNew(argv) {
  const ids = argv.filter((a, i) => /^\d+$/.test(a) && argv[i - 1] !== "--title");
  const titleAt = argv.indexOf("--title");
  if (!ids.length) die(USAGE);
  const items = briefItems(ids);
  const questions = draft(items);
  const doc = {
    title: titleAt >= 0 ? argv[titleAt + 1] : `${questions.length} quick decisions`,
    days: DEFAULT_DAYS,
    questions,
  };
  const dir = join(ROOT, "drafts");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${ids.join("-")}.yaml`);
  writeFileSync(file, YAML.stringify(doc, { lineWidth: 0 }));
  console.log(file);

  if (!process.stdin.isTTY) {
    console.error(`Review it, then run: ask push ${file}`);
    return;
  }
  spawnSync(process.env.EDITOR || "vi", [file], { stdio: "inherit" });
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const yes = /^y/i.test(await rl.question("Create the link? [y/N] "));
  rl.close();
  if (yes) push(file);
}

function push(file) {
  const doc = YAML.parse(readFileSync(file, "utf8"));
  const token = randomBytes(18).toString("base64url");
  convex("admin:create", {
    token,
    title: doc.title,
    ttlDays: doc.days ?? DEFAULT_DAYS,
    questions: doc.questions.map((q) => ({
      ...(q.brief != null && { briefId: Number(q.brief) }),
      title: q.title,
      context: q.context,
      options: q.options.map((o) => ({
        id: String(o.id),
        label: o.label,
        ...(o.detail && { detail: o.detail }),
        ...(o.suits?.length && { suits: o.suits }),
      })),
    })),
  });
  const url = `${SITE}/${token}`;
  console.log(url);
  console.log(
    `\nSlack: ${doc.questions.length} quick decisions, one tap each on your phone: ${url} (link works for ${doc.days ?? DEFAULT_DAYS} days)`,
  );
}

function cmdList() {
  for (const set of convex("admin:list")) {
    const done = set.questions.filter((q) => q.answer).length;
    console.log(`${set.status.padEnd(8)} ${done}/${set.questions.length}  ${set.title}  ${SITE}/${set.token}`);
    for (const q of set.questions) {
      console.log(`  ${q.briefId ? `#${q.briefId} ` : ""}${q.title}: ${q.answerLabel ?? "-"}`);
    }
  }
}

async function cmdPoll() {
  const ntfy = ntfyUrl();
  for (const set of convex("admin:collect")) {
    const lines = [];
    for (const q of set.questions) {
      const ref = q.briefId ? `#${q.briefId} ` : "";
      if (q.answerLabel) {
        if (q.briefId) {
          const done = spawnSync(BRIEF, ["done", String(q.briefId), "--note", `Products chose: ${q.answerLabel} (via ask)`], {
            encoding: "utf8",
          });
          if (done.status !== 0) console.error(`brief done ${q.briefId} failed: ${done.stderr.trim()}`);
        }
        lines.push(`${ref}${q.title} → ${q.answerLabel}`);
      } else {
        lines.push(`${ref}${q.title} → no answer, link expired`);
      }
    }
    const title = set.status === "complete" ? `Products answered: ${set.title}` : `Link expired: ${set.title}`;
    console.log(`${title}\n${lines.join("\n")}`);
    if (ntfy) {
      await fetch(ntfy, { method: "POST", headers: { Title: title, Tags: "ballot_box_with_check" }, body: lines.join("\n") }).catch(
        (err) => console.error(`ntfy failed: ${err.message}`),
      );
    }
    convex("admin:markReported", { id: set.id });
  }
}

function die(message) {
  console.error(message);
  process.exit(1);
}

const [cmd, ...argv] = process.argv.slice(2);
try {
  if (cmd === "new") await cmdNew(argv);
  else if (cmd === "push" && argv[0]) push(argv[0]);
  else if (cmd === "list") cmdList();
  else if (cmd === "revoke" && argv[0]) convex("admin:revoke", { token: argv[0].split("/").pop() });
  else if (cmd === "poll") await cmdPoll();
  else die(USAGE);
} catch (err) {
  die(err.stderr?.toString().trim() || err.message);
}
