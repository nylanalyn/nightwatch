#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT = { arguments: 2, exists: 3, pi: 4, malformed: 5 };
const here = dirname(fileURLToPath(import.meta.url));
const modes = new Set(["security", "maintainability", "general"]);
const usage = `usage: nightwatch <security|maintainability|general> <path> --base-url <loopback-url> --model <id>
  [--api-key-env <name>] [--context-window <tokens>] [--output <path>] [--fresh]`;

export function parseArgs(argv) {
  if (!modes.has(argv[0]) || !argv[1] || argv[1].startsWith("-")) throw new Error(usage);
  const out = { command: argv[0], path: argv[1], fresh: false, contextWindow: 65536, output: "NIGHTWATCH_REPORT.md" };
  const valued = new Map([["--base-url", "baseUrl"], ["--model", "model"], ["--api-key-env", "apiKeyEnv"], ["--context-window", "contextWindow"], ["--output", "output"]]);
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--fresh") { out.fresh = true; continue; }
    const key = valued.get(argv[i]);
    if (!key || !argv[i + 1]) throw new Error(`invalid argument: ${argv[i]}\n${usage}`);
    out[key] = argv[++i];
  }
  if (!out.baseUrl || !out.model) throw new Error(`--base-url and --model are required\n${usage}`);
  const url = new URL(out.baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--base-url must use http or https");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error("--base-url must be loopback");
  out.contextWindow = Number(out.contextWindow);
  if (!Number.isSafeInteger(out.contextWindow) || out.contextWindow < 1024) throw new Error("--context-window must be an integer of at least 1024");
  if (out.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(out.apiKeyEnv)) throw new Error("invalid --api-key-env name");
  return out;
}

export function assistantText(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type !== "message_end" || event.message?.role !== "assistant") return;
  if (!Array.isArray(event.message.content)) return;
  return event.message.content.filter(x => x?.type === "text" && typeof x.text === "string").map(x => x.text).join("");
}

export function validateReport(text, mode = "security") {
  const required = ["Run Status", "Summary", "Findings", "Rejected Hypotheses", "Unreviewed Areas"];
  if (!text?.trim() || !new RegExp(`^# +Nightwatch ${mode[0].toUpperCase() + mode.slice(1)} Report\\s*$`, "im").test(text) || required.some(h => !new RegExp(`^#{1,6} +${h}\\s*$`, "im").test(text))) return false;
  const ids = [...text.matchAll(/^#{1,6} +(NW-\d{3})\b/gm)].map(m => m[1]);
  if (new Set(ids).size !== ids.length) return false;
  const sections = text.split(/^#{1,6} +(?=NW-\d{3}\b)/gm).slice(1);
  return sections.every(s => ["Evidence", "Affected Files", "Severity", "Confidence", "Suggested Action", "Verification"].every(k => new RegExp(`(?:^|\\n)(?:#{1,6} +|\\*\\*)?${k}`, "i").test(s)));
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

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(error.message); return EXIT.arguments; }
  let repository;
  try { repository = await realpath(resolve(options.path)); if (!(await stat(repository)).isDirectory()) throw new Error(); }
  catch { console.error("repository path must be an existing directory"); return EXIT.arguments; }
  const output = resolve(repository, options.output);
  if (output === repository) { console.error("--output must name a file inside the repository"); return EXIT.arguments; }
  try { await containedDirectory(repository, dirname(output)); }
  catch { console.error("--output must be inside the repository and may not traverse symlinks"); return EXIT.arguments; }
  try { await access(output, constants.F_OK); if (!options.fresh) { console.error(`${output} already exists; use --fresh to replace it`); return EXIT.exists; } }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const runDir = join(repository, ".nightwatch", "runs", runId);
  const agentDir = join(runDir, "agent");
  const sessionDir = join(runDir, "session");
  try { await containedDirectory(repository, sessionDir); await mkdir(agentDir); }
  catch { console.error(".nightwatch must be a real directory inside the repository"); return EXIT.arguments; }
  const extension = resolve(here, "../src/audit-extension.js");
  const skill = resolve(here, `../skills/${options.command}/SKILL.md`);
  const piArgs = ["--mode", "json", "--print", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-builtin-tools", "--no-approve", "--extension", extension, "--skill", skill, "--tools", "list_repository,read_repository_file,search_repository", "--session-dir", sessionDir, "--model", `nightwatch-local/${options.model}`, "--thinking", "medium", "--", `Perform the ${options.command} review now. The trusted review skill is already in your system prompt; do not search for or reread it. Return only its complete Markdown report.`];
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, NIGHTWATCH_REPOSITORY: repository, NIGHTWATCH_MODE: options.command, NIGHTWATCH_BASE_URL: options.baseUrl, NIGHTWATCH_MODEL: options.model, NIGHTWATCH_CONTEXT_WINDOW: String(options.contextWindow), NIGHTWATCH_OUTPUT: output };
  if (options.apiKeyEnv) {
    if (!process.env[options.apiKeyEnv]) { console.error(`credential environment variable ${options.apiKeyEnv} is not set`); return EXIT.arguments; }
    env.NIGHTWATCH_API_KEY = process.env[options.apiKeyEnv];
  }
  const child = spawn(process.env.NIGHTWATCH_PI || "pi", piArgs, { cwd: repository, env, stdio: ["ignore", "pipe", "pipe"] });
  let interruptedBy;
  const collect = async stream => { let value = ""; stream.setEncoding("utf8"); for await (const chunk of stream) value += chunk; return value; };
  const stdout = collect(child.stdout), errors = collect(child.stderr);
  const interrupted = signal => { interruptedBy = signal; child.kill("SIGTERM"); };
  process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
  let spawnError = "";
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); }).catch(error => { spawnError = error.message; return -1; });
  process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted);
  const raw = await stdout;
  let stderr = await errors;
  stderr += spawnError;
  if (interruptedBy) stderr += `\nAUDIT INCOMPLETE: interrupted by ${interruptedBy}\n`;
  let finalText;
  // Parse once after completion so chunk boundaries and the final unterminated line are harmless.
  for (const line of raw.split("\n")) finalText = assistantText(line) ?? finalText;
  const metadata = { version: "0.1.0", runId, mode: options.command, repository, model: options.model, baseUrl: options.baseUrl, contextWindow: options.contextWindow, startedAt: runId.slice(0, 24), endedAt: new Date().toISOString(), exitCode: code };
  await writeFile(join(runDir, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
  if (code !== 0 || !validateReport(finalText, options.command)) {
    await writeFile(join(runDir, "diagnostic.log"), `AUDIT INCOMPLETE\n\n${stderr}\n${raw}`, { mode: 0o600 });
    console.error(code !== 0 ? `Pi/model failed (exit ${code}); diagnostics preserved in ${runDir}` : `malformed report; diagnostics preserved in ${runDir}`);
    return code !== 0 ? EXIT.pi : EXIT.malformed;
  }
  const temporary = `${output}.${runId}.tmp`;
  await writeFile(temporary, finalText.trim() + "\n", { flag: "wx" });
  await rename(temporary, output);
  console.log(output);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
