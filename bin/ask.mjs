#!/usr/bin/env node
// ask: send products a link with brief questions, and close the brief items once they answer.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import YAML from "yaml";

const USAGE = `usage:
  ask new BRIEF_ID... [--title TEXT]  draft questions from brief items, review, push
  ask push FILE [--thread KEY]         create a link, optionally wake a Toucan thread
  ask list                            recent sets and their answers
  ask revoke TOKEN|URL [--discard]     close a link; --discard skips reporting
  ask show TOKEN|URL                   show a link's answers
  ask wait TOKEN|URL [--timeout MINUTES]
                                      wait for an answer count/status change (default 110m; timeout exits 3)
  ask retitle TOKEN TEXT              change the title of an open link
  ask retitle-question TOKEN N TEXT   change the title of question N of an open link
  ask add-option TOKEN N FILE         add an option (YAML) to question N of an open link
  ask remove-question TOKEN N         remove question N from an open link
  ask add-question TOKEN FILE [--after N]
                                      add a question (YAML, may have brief:) to an open link
  ask poll                            close answered brief items, notify (run by ask-poll.timer)

Drafts are written to drafts/ in this repo; thread: KEY can set their Toucan owner.
Settings in .env.local or the environment: ASK_URL (site),
ASK_WHATSAPP (optional owner number), TOUCAN_CONFIG (optional config path).`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Local settings (ASK_URL, ASK_BRIEF, ASK_DRAFT_RULES) can live in the git-ignored .env.local.
const LOCAL = existsSync(join(ROOT, ".env.local")) ? parseEnv(readFileSync(join(ROOT, ".env.local"), "utf8")) : {};
const setting = (key) => process.env[key] ?? LOCAL[key];
const SITE = setting("ASK_URL");
const BRIEF = setting("ASK_BRIEF") ?? "brief";
const BRIEF_DB = join(homedir(), ".local/state/brief/brief.sqlite");
const PROJECTS = join(homedir(), ".config/teams-reader/projects.toml");
const DEFAULT_DAYS = 14;
const TOUCAN = setting("TOUCAN_CONFIG") ?? join(homedir(), ".config/toucan/toucan.toml");
const DELIVERY_FILE = join(homedir(), ".local/state/ask/delivered.json");
const QUIET = 10 * 60 * 1000;
const GIVE_UP = 6 * 60 * 60 * 1000;
const IO_TIMEOUT = 60 * 1000;

function convex(fn, args = {}) {
  const out = execFileSync(
    join(ROOT, "node_modules/.bin/convex"),
    ["run", "--prod", fn, JSON.stringify(args)],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: IO_TIMEOUT },
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
- title: the question itself, under 12 words. If the brief item names a ticket (like T9 or ORION-12),
  start the title with it, as in "T9: How many free checks a day?".
- context: one or two short sentences: what the situation is and why it needs their decision.
- 2 to 4 options. id: short kebab-case slug. label: under 8 words. detail: one sentence with the
  consequence or trade-off of picking it (under 25 words).
- chooseIf: the situation in which products should pick this option, as a clause that follows
  "Choose this if" (lowercase start, no full stop, under 15 words). Make the conditions of a
  question's options clearly different, so the reader can tell which one fits them.
- suits: which side each option works best for. "us" = the dev team (least work, least risk, already
  built), "you" = the products team (best for the people using it and the business). An option can suit both or neither;
  mark at least one option per question for each side.
- Keep the options the developer listed in the brief item, in the same order; add one only if it is
  an obvious missing choice.
- Keep domain terms the team uses as they write them, untranslated.
${setting("ASK_DRAFT_RULES") ? `- ${setting("ASK_DRAFT_RULES")}\n` : ""}
Reply with only JSON, no code fences:
{"questions": [{"brief": <brief id>, "title": "...", "context": "...",
  "options": [{"id": "...", "label": "...", "detail": "...", "chooseIf": "...", "suits": ["us", "you"]}]}]}

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

function toOption(o) {
  return {
    id: String(o.id),
    label: o.label,
    ...(o.detail && { detail: o.detail }),
    ...(o.chooseIf && { chooseIf: o.chooseIf }),
    ...(o.suits?.length && { suits: o.suits }),
  };
}

function toQuestion(q) {
  return {
    ...(q.brief != null && { briefId: Number(q.brief) }),
    title: q.title,
    context: q.context,
    options: q.options.map(toOption),
  };
}

// Letters and digits only: Slack turns _text_ into italics and drops the underscores from links.
function randomToken(length = 24) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  while (token.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte < 248 && token.length < length) token += alphabet[byte % 62]; // 248 = 4 * 62, no modulo bias
    }
  }
  return token;
}

const readYaml = (file) => YAML.parse(readFileSync(file, "utf8"));
const tokenOf = (arg) => /^https?:\/\//.test(arg) ? new URL(arg).pathname.split("/").filter(Boolean).pop() : arg;
const expandHome = (path) => path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

function toucanThread(key) {
  const threads = python(
    `import json, sys, tomllib
print(json.dumps(tomllib.load(open(sys.argv[1], 'rb')).get('threads', {})))`,
    expandHome(TOUCAN),
  );
  if (typeof key !== "string" || !Object.hasOwn(threads, key)) throw new Error(`Unknown Toucan thread: ${key}`);
  return threads[key];
}

function push(file, threadFlag) {
  const doc = readYaml(file);
  const thread = threadFlag ?? doc.thread;
  if (thread != null) toucanThread(thread);
  const token = randomToken();
  convex("admin:create", {
    token,
    title: doc.title,
    ttlDays: doc.days ?? DEFAULT_DAYS,
    ...(thread != null && { thread }),
    questions: doc.questions.map(toQuestion),
  });
  const url = `${SITE}/${token}`;
  console.log(url);
  console.log(`Token: ${token}`);
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

function answerLabel(q) {
  if (q.answer === "other" && q.answerText != null) return `Something else: ${q.answerText}`;
  return q.answerLabel ?? q.options?.find((o) => o.id === q.answer)?.label ?? q.answer;
}

const answered = (set) => set.questions.filter((q) => q.answer != null);
const answeredLines = (set) => answered(set).map((q) => `${q.title} → ${answerLabel(q)}`);
const summary = (set) => [`${set.title}: ${set.status}, ${answered(set).length}/${set.questions.length} answered`, ...answeredLines(set)].join("\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getSet(arg) {
  const set = convex("admin:get", { token: tokenOf(arg) });
  if (!set) throw new Error("No set with that token.");
  return set;
}

function cmdShow(arg) {
  console.log(summary(getSet(arg)));
}

// For agents to run in the background: exits as soon as answers or the status change.
async function cmdWait(arg, minutes = 110) {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("--timeout must be a positive number of minutes.");
  const deadline = Date.now() + minutes * 60 * 1000;
  const seen = (set) => `${set.status} ${set.questions.map((q) => `${q.id}=${q.answer}:${q.answeredAt}`).join(",")}`;
  let initial;
  while (Date.now() < deadline) {
    let set;
    try {
      set = getSet(arg);
    } catch (err) {
      if (/No set with that token/.test(err.message)) throw err;
      console.error(`wait: lookup failed; retrying: ${err.stderr?.toString().trim() || err.message}`);
    }
    if (set && initial == null) {
      initial = seen(set);
      if (set.status !== "open") {
        console.log(summary(set));
        return;
      }
      console.error(`wait: ${answered(set).length}/${set.questions.length} answered; waiting for a change`);
    } else if (set && seen(set) !== initial) {
      console.log(summary(set));
      return;
    }
    await sleep(Math.min(30_000, Math.max(0, deadline - Date.now())));
  }
  console.error("wait: timed out with no new answers");
  process.exitCode = 3;
}

function readDeliveryState() {
  if (!existsSync(DELIVERY_FILE)) return {};
  const state = JSON.parse(readFileSync(DELIVERY_FILE, "utf8"));
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid ask delivery state.");
  return state;
}

function saveDeliveryState(state) {
  mkdirSync(dirname(DELIVERY_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${DELIVERY_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, DELIVERY_FILE);
}

function noticeFor(set, key, kind) {
  const count = answered(set).length;
  const total = set.questions.length;
  const title = kind === "final"
    ? `${set.status === "complete" ? "Products answered" : `Link ${set.status}`}: ${set.title}`
    : kind === "started" ? `Products started answering: ${set.title}` : `Products answered ${count} of ${total} so far on ${set.title}`;
  const lines = kind === "final"
    ? set.questions.map((q) => `${q.title} → ${q.answer != null ? answerLabel(q) : `no answer, link ${set.status}`}`)
    : answeredLines(set);
  return {
    key,
    kind,
    title,
    message: [`${set.status}, ${count}/${total} answered`, ...lines].join("\n"),
    // Wakes contain counts and our title only, never respondent answer text.
    wake: `ask: ${count} of ${total} answered on ${JSON.stringify(set.title)} (${set.status}; ${kind}). Run: ask show ${set.token}`,
  };
}

async function post(url, options) {
  return await fetch(url, { ...options, method: "POST", signal: AbortSignal.timeout(IO_TIMEOUT), redirect: "error" });
}

async function sendNtfy(url, set, notice) {
  const res = await post(url, {
    headers: {
      Title: `=?UTF-8?B?${Buffer.from(notice.title).toString("base64")}?=`,
      Tags: "ballot_box_with_check",
      Priority: notice.kind === "final" ? "high" : "default",
      Click: new URL(set.token, `${SITE.replace(/\/$/, "")}/`).href,
    },
    body: notice.message,
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
  await res.body?.cancel();
}

function sendWhatsapp(number, set, notice) {
  const run = spawnSync("wacli", ["send", "text", "--to", number, "--message", `${notice.title}\n${notice.message}\n${SITE}/${set.token}`], {
    encoding: "utf8", timeout: IO_TIMEOUT,
  });
  if (run.status !== 0) throw new Error(run.error?.message || run.stderr?.trim() || "wacli failed");
}

async function wakeThread(key, notice) {
  const thread = toucanThread(key);
  if (typeof thread.hook_file !== "string") throw new Error("Thread has no hook_file.");
  const file = expandHome(thread.hook_file);
  const stat = statSync(file);
  if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600) throw new Error("hook_file must exist and have mode 600.");
  const url = new URL(readFileSync(file, "utf8").trim());
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("hook_file must contain an HTTP(S) URL.");
  const res = await post(url, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread: key, summary: notice.wake, count: 0 }),
  });
  if (![200, 202].includes(res.status)) throw new Error(`thread wake HTTP ${res.status}`);
  await res.body?.cancel();
}

async function deliverChannel(state, key, send) {
  const previous = state[key];
  if (previous?.deliveredAt != null) return true;
  if (previous?.firstFailedAt != null && Date.now() - previous.firstFailedAt > GIVE_UP) {
    console.error(`GIVING UP ${key}: failed for over 6 hours after ${previous.attempts} attempts: ${previous.lastError}`);
    return true;
  }
  try {
    if (await send() === false) {
      console.log(`skipped ${key}: not configured`);
      return true;
    }
  } catch (err) {
    state[key] = { firstFailedAt: previous?.firstFailedAt ?? Date.now(), attempts: (previous?.attempts ?? 0) + 1, lastError: err.message };
    saveDeliveryState(state);
    console.error(`FAILED ${key} (attempt ${state[key].attempts}): ${err.message}`);
    return false;
  }
  state[key] = { deliveredAt: Date.now() };
  saveDeliveryState(state);
  console.log(`delivered ${key}`);
  return true;
}

async function notify(state, set, notice) {
  const channels = [
    // Read configuration inside the delivery attempt so config errors are retried too.
    ["ntfy", async () => {
      const url = ntfyUrl();
      if (!url) return false;
      await sendNtfy(url, set, notice);
    }],
    ...(notice.kind === "final" && setting("ASK_WHATSAPP") ? [["whatsapp", () => sendWhatsapp(setting("ASK_WHATSAPP"), set, notice)]] : []),
    ...(set.thread ? [["thread", () => wakeThread(set.thread, notice)]] : []),
  ];
  let done = true;
  for (const [channel, send] of channels) {
    if (!await deliverChannel(state, `${set.id}:${notice.key}:${channel}`, send)) done = false;
  }
  return done;
}

function closeBriefItems(set) {
  let closed = true;
  for (const q of answered(set).filter((q) => q.briefId != null && q.closedAt == null)) {
    try {
      const run = spawnSync(BRIEF, ["done", String(q.briefId), "--note", `Products chose: ${answerLabel(q)} (via ask)`], {
        encoding: "utf8", timeout: IO_TIMEOUT,
      });
      if (run.status !== 0 && !/no open item/i.test(run.stderr ?? "")) {
        throw new Error(run.error?.message || run.stderr?.trim() || "brief done failed");
      }
      convex("admin:markClosed", { questionId: q.id });
      console.log(`closed brief ${q.briefId} for ${set.id}`);
    } catch (err) {
      closed = false;
      console.error(`FAILED brief ${q.briefId} for ${set.id}: ${err.stderr?.toString().trim() || err.message}`);
    }
  }
  return closed;
}

async function pollFinal(state, set) {
  if (set.status === "revoked" && !answered(set).length) {
    convex("admin:markReported", { id: set.id });
    console.log(`reported ${set.id}: revoked with no answers; no notification`);
    return true;
  }
  const closed = closeBriefItems(set);
  const delivered = await notify(state, set, noticeFor(set, "final", "final"));
  if (!closed || !delivered) return false;
  convex("admin:markReported", { id: set.id });
  console.log(`reported ${set.id}: ${set.status}`);
  return true;
}

async function pollProgress(state, set) {
  const newest = Math.max(...answered(set).map((q) => q.answeredAt ?? 0));
  const after = set.progressAt ?? 0;
  if (newest <= after) return true;
  const key = `${set.id}:burst`;
  // The early notice never advances progressAt. Freeze both notices for retries;
  // only a delivered paused notice advances it, so later answers form a new burst.
  if (!state[key] || state[key].after < after) {
    state[key] = { after, started: noticeFor(set, `started:${after}`, "started") };
    saveDeliveryState(state);
  }
  const burst = state[key];
  const started = await notify(state, set, burst.started);
  if (!burst.paused && Date.now() - newest >= QUIET) {
    burst.paused = { at: newest, notice: noticeFor(set, `paused:${newest}`, "paused") };
    saveDeliveryState(state);
  }
  if (!burst.paused) return started;
  const paused = await notify(state, set, burst.paused.notice);
  if (!started || !paused) return false;
  convex("admin:markProgress", { id: set.id, at: burst.paused.at });
  console.log(`marked progress ${set.id} through ${burst.paused.at}`);
  delete state[key];
  saveDeliveryState(state);
  return true;
}

async function cmdPoll() {
  if (!SITE) throw new Error("Set ASK_URL for notification links.");
  const state = readDeliveryState();
  const sets = convex("admin:collect");
  console.log(`collected ${sets.final.length} final, ${sets.progress.length} progress`);
  let failed = false;
  for (const [kind, list] of [["final", sets.final], ["progress", sets.progress]]) {
    for (const set of list) {
      try {
        if (!await (kind === "final" ? pollFinal(state, set) : pollProgress(state, set))) failed = true;
      } catch (err) {
        failed = true;
        console.error(`FAILED ${kind} ${set.id}: ${err.stderr?.toString().trim() || err.message}`);
      }
    }
  }
  if (failed) process.exitCode = 1;
}

function die(message) {
  console.error(message);
  process.exit(1);
}

const [cmd, ...argv] = process.argv.slice(2);
if (!SITE && cmd && !["poll", "show", "wait"].includes(cmd)) die("Set ASK_URL to the deployed site, in .env.local or the environment.");
try {
  if (cmd === "new") await cmdNew(argv);
  else if (cmd === "push" && argv[0]) {
    if (argv.length !== 1 && !(argv.length === 3 && argv[1] === "--thread" && argv[2])) die(USAGE);
    push(argv[0], argv[2]);
  }
  else if (cmd === "list") cmdList();
  else if (cmd === "revoke" && argv[0]) {
    if (argv.length !== 1 && !(argv.length === 2 && argv[1] === "--discard")) die(USAGE);
    convex("admin:revoke", { token: tokenOf(argv[0]), ...(argv[1] === "--discard" && { discard: true }) });
  }
  else if (cmd === "show" && argv.length === 1) cmdShow(argv[0]);
  else if (cmd === "wait" && argv[0]) {
    if (argv.length !== 1 && !(argv.length === 3 && argv[1] === "--timeout")) die(USAGE);
    await cmdWait(argv[0], argv.length === 3 ? Number(argv[2]) : 110);
  }
  else if (cmd === "retitle" && argv.length === 2) convex("admin:retitle", { token: tokenOf(argv[0]), title: argv[1] });
  else if (cmd === "retitle-question" && argv.length === 3) {
    convex("admin:retitleQuestion", { token: tokenOf(argv[0]), question: Number(argv[1]), title: argv[2] });
  } else if (cmd === "remove-question" && argv.length === 2) {
    convex("admin:removeQuestion", { token: tokenOf(argv[0]), question: Number(argv[1]) });
  } else if (cmd === "add-option" && argv.length === 3) {
    convex("admin:addOption", { token: tokenOf(argv[0]), question: Number(argv[1]), option: toOption(readYaml(argv[2])) });
  } else if (cmd === "add-question" && argv.length >= 2) {
    const after = argv.indexOf("--after");
    convex("admin:addQuestion", {
      token: tokenOf(argv[0]),
      ...(after >= 0 && { after: Number(argv[after + 1]) }),
      question: toQuestion(readYaml(argv[1])),
    });
  }
  else if (cmd === "poll") await cmdPoll();
  else die(USAGE);
} catch (err) {
  die(err.stderr?.toString().trim() || err.message);
}
