#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryScopes } from "../src/repository.js";

export const EXIT = { arguments: 2, exists: 3, pi: 4, malformed: 5 };
const here = dirname(fileURLToPath(import.meta.url));
const modes = new Set(["security", "maintainability", "consistency", "plan", "ux", "ideas", "balance", "adversary", "general"]);
const profiles = new Set(["generic", "irc-bot", "web-app", "simulation"]);
const usage = `usage: nightwatch <mode> <path> [--base-url <loopback-url>] [--model <id>]
  [--api-key-env <name>] [--context-window <tokens>] [--profile <name>]
  [--max-tool-calls <count>] [--output <path>] [--fresh|--resume]`;
const configKeys = new Set(["baseUrl", "model", "apiKeyEnv", "contextWindow", "profile", "maxToolCalls", "output"]);

export function parseArgs(argv, config = {}) {
  if (!modes.has(argv[0]) || !argv[1] || argv[1].startsWith("-")) throw new Error(usage);
  const out = { contextWindow: 65536, profile: "generic", maxToolCalls: 16, output: "NIGHTWATCH_REPORT.md", ...config, command: argv[0], path: argv[1], fresh: false, resume: false };
  const valued = new Map([["--base-url", "baseUrl"], ["--model", "model"], ["--api-key-env", "apiKeyEnv"], ["--context-window", "contextWindow"], ["--profile", "profile"], ["--max-tool-calls", "maxToolCalls"], ["--output", "output"]]);
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--fresh") { out.fresh = true; continue; }
    if (argv[i] === "--resume") { out.resume = true; continue; }
    const key = valued.get(argv[i]);
    if (!key || !argv[i + 1]) throw new Error(`invalid argument: ${argv[i]}\n${usage}`);
    out[key] = argv[++i];
  }
  if (typeof out.baseUrl !== "string" || !out.baseUrl || typeof out.model !== "string" || !out.model) throw new Error(`baseUrl and model are required through CLI or .nightwatch/config.json\n${usage}`);
  if (out.fresh && out.resume) throw new Error("--fresh and --resume cannot be combined");
  if (!profiles.has(out.profile)) throw new Error(`unknown profile: ${out.profile}`);
  if (typeof out.output !== "string" || !out.output) throw new Error("--output must be a non-empty path");
  const url = new URL(out.baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--base-url must use http or https");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error("--base-url must be loopback");
  out.contextWindow = Number(out.contextWindow);
  if (!Number.isSafeInteger(out.contextWindow) || out.contextWindow < 1024) throw new Error("--context-window must be an integer of at least 1024");
  out.maxToolCalls = Number(out.maxToolCalls);
  if (!Number.isSafeInteger(out.maxToolCalls) || out.maxToolCalls < 1 || out.maxToolCalls > 1000) throw new Error("--max-tool-calls must be an integer from 1 to 1000");
  if (out.apiKeyEnv && (typeof out.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(out.apiKeyEnv))) throw new Error("invalid --api-key-env name");
  return out;
}

export async function loadConfig(repository) {
  const path = join(repository, ".nightwatch", "config.json");
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  if (!info.isFile() || info.size > 64 * 1024) throw new Error(".nightwatch/config.json must be a regular file no larger than 64 KiB");
  if (await realpath(path) !== path) throw new Error(".nightwatch/config.json may not traverse symlinks");
  let config;
  try { config = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`invalid .nightwatch/config.json: ${error.message}`); }
  if (!config || Array.isArray(config) || typeof config !== "object") throw new Error(".nightwatch/config.json must contain an object");
  const unknown = Object.keys(config).find(key => !configKeys.has(key));
  if (unknown) throw new Error(`unknown configuration key: ${unknown}`);
  return config;
}

export function assistantText(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type !== "message_end" || event.message?.role !== "assistant") return;
  if (!Array.isArray(event.message.content)) return;
  return event.message.content.filter(x => x?.type === "text" && typeof x.text === "string").map(x => x.text).join("");
}

export function contextExhausted(raw) {
  let exhausted = false;
  for (const line of raw.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "message_end" && event.message?.role === "assistant") exhausted = event.message.stopReason === "length";
    if (event.type === "compaction_end" && /context|token cap|overflow/i.test(event.errorMessage || "")) exhausted = true;
  }
  return exhausted;
}

export function validateReport(text, mode = "security") {
  const required = ["Run Status", "Summary", "Findings", "Rejected Hypotheses", "Unreviewed Areas"];
  const title = mode === "ux" ? "UX" : mode[0].toUpperCase() + mode.slice(1);
  if (!text?.trim() || !new RegExp(`^# +Nightwatch ${title} Report\\s*$`, "im").test(text) || required.some(h => !new RegExp(`^#{1,6} +${h}\\s*$`, "im").test(text))) return false;
  const prefix = { ux: "UX", ideas: "IDEA", balance: "BAL", adversary: "ADV" }[mode] || "NW";
  const finding = new RegExp(`^#{1,6} +(${prefix}-\\d{3})\\b`, "gm");
  const ids = [...text.matchAll(finding)].map(m => m[1]);
  if (new Set(ids).size !== ids.length) return false;
  const sections = text.split(new RegExp(`^#{1,6} +(?=${prefix}-\\d{3}\\b)`, "gm")).slice(1);
  const fields = ["Evidence", "Affected Files", "Severity", "Confidence", "Suggested Action", "Verification", ...(mode === "plan" ? ["Classification"] : []), ...(mode === "ideas" ? ["User Value", "Implementation Cost", "Complexity Risk", "Fit"] : [])];
  return sections.every(s => fields.every(k => new RegExp(`(?:^|\\n)[ \\t]*(?:[-*+] +)?(?:#{1,6} +|\\*\\*)?${k}`, "i").test(s)));
}

export function hasIncompleteStatus(text) {
  const status = text?.split(/^#{1,6} +Run Status[ \t]*$/im)[1]?.split(/^#{1,6} +/m)[0] || "";
  return /\bAUDIT INCOMPLETE\b/i.test(status);
}

export function unreviewedPaths(text, scope) {
  const section = text?.split(/^## +Unreviewed Areas[ \t]*$/im)[1]?.split(/^## +/m)[0] || "";
  return scope.filter(path => section.includes(`\`${path}\``));
}

export async function containedDirectory(root, directory) {
  const rel = relative(root, directory);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== directory) throw new Error("write path escapes repository");
  let existing = directory;
  while (true) {
    try { existing = await realpath(existing); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; const parent = dirname(existing); if (parent === existing) throw error; existing = parent; }
  }
  if (existing !== root && !existing.startsWith(root + sep)) throw new Error("write path escapes repository through symlink");
  await mkdir(directory, { recursive: true });
  const actual = await realpath(directory);
  if (actual !== root && !actual.startsWith(root + sep)) throw new Error("write path escapes repository through symlink");
}

async function gitState(repository) {
  const run = args => new Promise(resolve => {
    const child = spawn("git", args, { cwd: repository, stdio: ["ignore", "pipe", "ignore"] }); let value = "";
    child.stdout.on("data", chunk => value += chunk); child.on("error", () => resolve(null)); child.on("close", code => resolve(code === 0 ? value.trim() : null));
  });
  return { commit: await run(["rev-parse", "HEAD"]), dirty: await run(["status", "--porcelain=v1", "--untracked-files=all"]) };
}

async function resumableRun(repository, mode, profile, state) {
  const runs = join(repository, ".nightwatch", "runs");
  const names = await readdir(runs).catch(() => []);
  for (const name of names.sort().reverse()) {
    const directory = join(runs, name);
    try {
      const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
      if (metadata.mode !== mode || (metadata.profile || "generic") !== profile || metadata.status === "complete") continue;
      if (!metadata.git || metadata.git.commit !== state.commit || metadata.git.dirty !== state.dirty) throw new Error("repository changed since the resumable run");
      const session = (await readdir(join(directory, "session")).catch(() => [])).find(file => file.endsWith(".jsonl"));
      if (session || metadata.scopes) return { directory, session: session && join(directory, "session", session), metadata };
    } catch (error) { if (error.message === "repository changed since the resumable run") throw error; }
  }
  throw new Error("no matching failed run is available to resume");
}

function finalAssistantText(raw) {
  let text;
  for (const line of raw.split("\n")) text = assistantText(line) ?? text;
  return text;
}

function launchPi(repository, args, env) {
  const child = spawn(process.env.NIGHTWATCH_PI || "pi", args, { cwd: repository, env, stdio: ["ignore", "pipe", "pipe"] });
  let interruptedBy, spawnError = "";
  const collect = async stream => { let value = ""; stream.setEncoding("utf8"); for await (const chunk of stream) value += chunk; return value; };
  const stdout = collect(child.stdout), errors = collect(child.stderr);
  const interrupted = signal => { interruptedBy = signal; child.kill("SIGTERM"); };
  process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
  return new Promise(resolve => {
    child.once("error", error => { spawnError = error.message; });
    child.once("close", async code => {
      process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted);
      let stderr = await errors; stderr += spawnError;
      if (interruptedBy) stderr += `\nAUDIT INCOMPLETE: interrupted by ${interruptedBy}\n`;
      resolve({ code: code ?? -1, raw: await stdout, stderr, interruptedBy });
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ["-h", "--help"].includes(argv[0])) { console.log(usage); return 0; }
  if (!modes.has(argv[0]) || !argv[1] || argv[1].startsWith("-")) { console.error(usage); return EXIT.arguments; }
  let repository;
  try { repository = await realpath(resolve(argv[1])); if (!(await stat(repository)).isDirectory()) throw new Error(); }
  catch { console.error("repository path must be an existing directory"); return EXIT.arguments; }
  let options;
  try {
    options = parseArgs(argv, await loadConfig(repository));
  } catch (error) { console.error(error.message); return EXIT.arguments; }
  const output = resolve(repository, options.output);
  if (output === repository) { console.error("--output must name a file inside the repository"); return EXIT.arguments; }
  try { await containedDirectory(repository, dirname(output)); }
  catch { console.error("--output must be inside the repository and may not traverse symlinks"); return EXIT.arguments; }
  try { await access(output, constants.F_OK); if (!options.fresh) { console.error(`${output} already exists; use --fresh to replace it`); return EXIT.exists; } }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  const git = await gitState(repository);
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  let runDir = join(repository, ".nightwatch", "runs", runId), resumeSession, previousMetadata, originalStart = startedAt;
  if (options.resume) {
    try { const previous = await resumableRun(repository, options.command, options.profile, git); runDir = previous.directory; resumeSession = previous.session; previousMetadata = previous.metadata; originalStart = previous.metadata.startedAt || originalStart; }
    catch (error) { console.error(error.message); return EXIT.arguments; }
  }
  const agentDir = join(runDir, "agent");
  const sessionDir = join(runDir, "session");
  try { await containedDirectory(repository, sessionDir); await mkdir(agentDir, { recursive: true }); }
  catch { console.error(".nightwatch must be a real directory inside the repository"); return EXIT.arguments; }
  const extension = resolve(here, "../src/audit-extension.js");
  const skill = resolve(here, `../skills/${options.command}/SKILL.md`);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, NIGHTWATCH_REPOSITORY: repository, NIGHTWATCH_MODE: options.command, NIGHTWATCH_PROFILE: options.profile, NIGHTWATCH_BASE_URL: options.baseUrl, NIGHTWATCH_MODEL: options.model, NIGHTWATCH_CONTEXT_WINDOW: String(options.contextWindow), NIGHTWATCH_MAX_TOOL_CALLS: String(options.maxToolCalls), NIGHTWATCH_OUTPUT: output };
  delete env.NIGHTWATCH_SCOPES; delete env.NIGHTWATCH_SYNTHESIS_INPUT;
  if (options.apiKeyEnv) {
    if (!process.env[options.apiKeyEnv]) { console.error(`credential environment variable ${options.apiKeyEnv} is not set`); return EXIT.arguments; }
    env.NIGHTWATCH_API_KEY = process.env[options.apiKeyEnv];
  }
  const argsFor = (directory, prompt, session) => {
    const args = ["--mode", "json", "--print", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-builtin-tools", "--no-approve", "--extension", extension, "--skill", skill, "--tools", "list_repository,read_repository_file,search_repository,detect_repository_tooling,check_javascript_syntax", "--session-dir", directory, "--model", `nightwatch-local/${options.model}`, "--thinking", "medium", "--", prompt];
    if (session) args.splice(args.indexOf("--"), 0, "--session", session);
    return args;
  };
  // ponytail: source bytes only approximate review cost; replace with measured token planning if this heuristic proves inadequate.
  const targetBytes = Math.min(512 * 1024, Math.max(64 * 1024, options.contextWindow * 4));
  let scopes;
  try { scopes = resumeSession ? [["."]] : previousMetadata?.scopes || await repositoryScopes(repository, targetBytes, Math.max(1, options.maxToolCalls - 5)); }
  catch (error) { console.error(error.message); return EXIT.arguments; }
  let outcome;
  const partials = [], passFailures = [], initialPasses = scopes.length;
  if (scopes.length === 1) {
    outcome = await launchPi(repository, argsFor(sessionDir, `Perform the ${options.command} review now. The trusted review skill is already in your system prompt; do not search for or reread it. Return only its complete Markdown report.`, resumeSession), { ...env, NIGHTWATCH_SCOPES: JSON.stringify(scopes[0]) });
  } else {
    const passesDir = join(runDir, "passes");
    try { await containedDirectory(repository, passesDir); }
    catch { console.error("unable to create the scoped-pass directory"); return EXIT.arguments; }
    const followedUp = new Set();
    for (let index = 0; index < scopes.length; index++) {
      const number = String(index + 1).padStart(3, "0"), reportPath = join(passesDir, `${number}.md`), scope = scopes[index];
      let report = await readFile(reportPath, "utf8").catch(() => "");
      if (!validateReport(report, options.command)) {
        const passSession = join(sessionDir, `pass-${number}`);
        await mkdir(passSession, { recursive: true });
        const prompt = `Review only scoped pass ${index + 1} of ${scopes.length}: ${scope.join(", ")}. Investigate this scope thoroughly, note cross-scope questions without leaving the scope, and return only a complete Markdown ${options.command} report. Under Unreviewed Areas, name every unreviewed or partially reviewed path using its full repository-relative path in backticks. Use AUDIT INCOMPLETE because final repository-wide synthesis happens later.`;
        const pass = await launchPi(repository, argsFor(passSession, prompt), { ...env, NIGHTWATCH_SCOPES: JSON.stringify(scope) });
        report = finalAssistantText(pass.raw) || "";
        if (pass.code === 0 && validateReport(report, options.command)) await writeFile(reportPath, report.trim() + "\n", { mode: 0o600 });
        else { const passExhausted = contextExhausted(pass.raw); passFailures.push(index + 1); await writeFile(join(passesDir, `${number}.diagnostic.log`), `AUDIT INCOMPLETE${passExhausted ? ": CONTEXT EXHAUSTED" : ""}\n\n${pass.stderr}\n${pass.raw}`, { mode: 0o600 }); }
        if (pass.interruptedBy) { outcome = pass; break; }
      }
      if (validateReport(report, options.command)) {
        partials.push({ scope, report });
        if (index < initialPasses) {
          const followup = unreviewedPaths(report, scope).filter(path => !followedUp.has(path));
          if (followup.length) { followup.forEach(path => followedUp.add(path)); scopes.push(followup); }
        }
      }
    }
    if (!outcome) {
      const synthesisDir = join(runDir, "synthesis"), synthesisLimit = Math.max(16_000, options.contextWindow);
      await containedDirectory(repository, synthesisDir);
      let documents = partials.map((partial, index) => `## Scoped report ${index + 1}: ${partial.scope.join(", ")}\n\n${partial.report}`);
      if (passFailures.length) documents.push(`## Failed scoped passes\n${passFailures.join(", ")} produced no valid partial report. Preserve this gap and mark the final audit AUDIT INCOMPLETE.`);
      const pack = inputs => {
        const pieces = inputs.flatMap(input => Array.from({ length: Math.ceil(input.length / synthesisLimit) || 1 }, (_, index) => input.slice(index * synthesisLimit, (index + 1) * synthesisLimit)));
        const batches = [];
        for (const piece of pieces) {
          const current = batches.at(-1);
          if (current && current.length + piece.length + 5 <= synthesisLimit) batches[batches.length - 1] += `\n\n---\n\n${piece}`;
          else batches.push(piece);
        }
        return batches;
      };
      for (let level = 1; !outcome; level++) {
        const batches = pack(documents), next = [], finalLevel = batches.length === 1;
        for (let index = 0; index < batches.length; index++) {
          const id = `${String(level).padStart(2, "0")}-${String(index + 1).padStart(3, "0")}`;
          const inputPath = join(synthesisDir, `${id}.input.md`), reportPath = join(synthesisDir, `${id}.md`), synthesisSession = join(sessionDir, `synthesis-${id}`);
          await writeFile(inputPath, batches[index], { mode: 0o600 }); await mkdir(synthesisSession, { recursive: true });
          const prompt = finalLevel ? `Synthesize the final repository-wide ${options.command} report now. Deduplicate and renumber findings sequentially, challenge important claims, verify only what is necessary, and return only the complete Markdown report.` : `Merge this batch of scoped ${options.command} reports into one concise intermediate Markdown report. Deduplicate and challenge findings, preserve coverage gaps, use AUDIT INCOMPLETE, and stay under 12000 characters.`;
          const synthesisEnv = { ...env, NIGHTWATCH_SYNTHESIS_INPUT: inputPath, NIGHTWATCH_MAX_TOOL_CALLS: String(Math.min(12, options.maxToolCalls)) };
          const merged = await launchPi(repository, argsFor(synthesisSession, prompt), synthesisEnv), report = finalAssistantText(merged.raw) || "";
          if (finalLevel) { outcome = merged; break; }
          if (merged.code === 0 && validateReport(report, options.command)) { await writeFile(reportPath, report.trim() + "\n", { mode: 0o600 }); next.push(report); }
          else { await writeFile(join(synthesisDir, `${id}.diagnostic.log`), `AUDIT INCOMPLETE\n\n${merged.stderr}\n${merged.raw}`, { mode: 0o600 }); next.push("An intermediate synthesis batch failed. Preserve an AUDIT INCOMPLETE status and report synthesis coverage as unreviewed."); }
          if (merged.interruptedBy) { outcome = merged; break; }
        }
        documents = next;
      }
    }
  }
  const { code, raw, stderr, interruptedBy } = outcome;
  const finalText = finalAssistantText(raw);
  const valid = code === 0 && validateReport(finalText, options.command) && (!passFailures.length || hasIncompleteStatus(finalText));
  const exhausted = !valid && contextExhausted(raw);
  const metadata = { version: "0.1.0", runId: runDir.split(sep).at(-1), mode: options.command, profile: options.profile, repository, model: options.model, baseUrl: options.baseUrl, contextWindow: options.contextWindow, maxToolCalls: options.maxToolCalls, scopes, completedPasses: partials.length, followupPasses: Math.max(0, scopes.length - initialPasses), failedPasses: passFailures, git, resumed: Boolean(options.resume), startedAt: originalStart, endedAt: new Date().toISOString(), exitCode: code, status: valid ? "complete" : exhausted ? "context-exhausted" : code === 0 ? "malformed" : "pi-failure" };
  await writeFile(join(runDir, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
  if (!valid) {
    await writeFile(join(runDir, "diagnostic.log"), `AUDIT INCOMPLETE${exhausted ? ": CONTEXT EXHAUSTED" : ""}\n\n${stderr}\n${raw}`, { mode: 0o600 });
    console.error(exhausted ? `context exhausted before a valid report; diagnostics preserved in ${runDir}` : code !== 0 ? `Pi/model failed (exit ${code}); diagnostics preserved in ${runDir}` : `malformed report; diagnostics preserved in ${runDir}`);
    return code !== 0 ? EXIT.pi : EXIT.malformed;
  }
  const temporary = `${output}.${runId}.tmp`;
  await writeFile(temporary, finalText.trim() + "\n", { flag: "wx" });
  await rename(temporary, output);
  console.log(output);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
