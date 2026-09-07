import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import auditExtension from "../src/audit-extension.js";
import { assistantText, containedDirectory, contextExhausted, loadConfig, parseArgs, validateReport } from "../bin/nightwatch.js";
import { checkJavaScriptSyntax, detectRepositoryTooling, readRepositoryFile, readRepositoryLines, repositoryScopes, runRg, safePath } from "../src/repository.js";

const validReport = `# Nightwatch Security Report
## Run Status
COMPLETE
## Summary
Nothing found.
## Findings
No supported findings.
## Rejected Hypotheses
None.
## Unreviewed Areas
None.
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nightwatch-test-"));
  await writeFile(join(root, "app.js"), "const token = input;\n".repeat(200));
  await mkdir(join(root, ".git")); await writeFile(join(root, ".git", "secret"), "x");
  await mkdir(join(root, ".nightwatch")); await writeFile(join(root, ".nightwatch", "state"), "x");
  return root;
}

test("arguments require a model and loopback endpoint", () => {
  assert.throws(() => parseArgs(["security", ".", "--model", "m"]), /base-url/);
  assert.throws(() => parseArgs(["security", ".", "--model", "m", "--base-url", "https://example.com/v1"]), /loopback/);
  assert.equal(parseArgs(["security", ".", "--model", "m", "--base-url", "http://[::1]:4000/v1"]).model, "m");
  assert.equal(parseArgs(["maintainability", ".", "--model", "m", "--base-url", "http://localhost/v1"]).command, "maintainability");
  assert.equal(parseArgs(["general", ".", "--model", "m", "--base-url", "http://localhost/v1"]).command, "general");
  for (const mode of ["consistency", "plan", "ux", "ideas", "balance", "adversary"]) assert.equal(parseArgs([mode, ".", "--model", "m", "--base-url", "http://localhost/v1"]).command, mode);
  assert.equal(parseArgs(["general", ".", "--model", "m", "--base-url", "http://localhost/v1"]).profile, "generic");
  assert.equal(parseArgs(["security", ".", "--model", "m", "--base-url", "http://localhost/v1", "--profile", "web-app"]).profile, "web-app");
  assert.throws(() => parseArgs(["security", ".", "--model", "m", "--base-url", "http://localhost/v1", "--profile", "unknown"]), /unknown profile/);
  assert.throws(() => parseArgs(["security", ".", "--model", "m", "--base-url", "http://localhost/v1", "--fresh", "--resume"]), /cannot be combined/);
  assert.equal(parseArgs(["security", ".", "--model", "m", "--base-url", "http://localhost/v1", "--max-tool-calls", "12"]).maxToolCalls, 12);
  assert.throws(() => parseArgs(["security", ".", "--model", "m", "--base-url", "http://localhost/v1", "--max-tool-calls", "0"]), /max-tool-calls/);
});

test("project configuration is strict and CLI values win", async () => {
  const root = await fixture(), path = join(root, ".nightwatch", "config.json");
  await writeFile(path, JSON.stringify({ baseUrl: "http://localhost:4000/v1", model: "configured", contextWindow: 32000 }));
  const config = await loadConfig(root);
  assert.equal(parseArgs(["security", root], config).model, "configured");
  assert.equal(parseArgs(["security", root, "--model", "cli"], config).model, "cli");
  await writeFile(path, JSON.stringify({ apiKey: "secret" }));
  await assert.rejects(loadConfig(root), /unknown configuration key/);
  await writeFile(path, "not json");
  await assert.rejects(loadConfig(root), /invalid/);
});

test("report validation checks structure and unique findings", () => {
  assert.equal(validateReport(validReport), true);
  assert.equal(validateReport(validReport.replace("## Summary", "## Notes")), false);
  const finding = `### NW-001 — Test\nSeverity: LOW\nConfidence: HIGH\nAffected Files: a\nEvidence: e\nSuggested Action: s\nVerification: v\n`;
  assert.equal(validateReport(validReport.replace("No supported findings.", finding + finding)), false);
  assert.equal(assistantText(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [null] } })), "");
  assert.equal(assistantText(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "text" } })), undefined);
  const ux = validReport.replace("Security", "UX").replace("No supported findings.", "### UX-001 — Help\nSeverity: LOW\nConfidence: HIGH\nAffected Files: README.md\nEvidence: e\nSuggested Action: s\nVerification: v");
  assert.equal(validateReport(ux, "ux"), true);
  assert.equal(contextExhausted(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "length" } })), true);
  assert.equal(contextExhausted(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } })), false);
});

test("wrapper write directories reject symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nightwatch-write-")), outside = await mkdtemp(join(tmpdir(), "nightwatch-outside-"));
  await writeFile(join(outside, "config.json"), "{}");
  await symlink(outside, join(root, ".nightwatch"));
  await assert.rejects(loadConfig(root), /symlink/);
  await assert.rejects(containedDirectory(root, join(root, ".nightwatch", "runs", "id")), /symlink/);
  await symlink(outside, join(root, "linked"));
  await assert.rejects(containedDirectory(root, join(root, "linked")), /symlink/);
});

test("reads reject traversal, escapes, special and excluded files", async () => {
  const root = await fixture(), outside = join(root, "..", `outside-${Date.now()}`);
  await writeFile(outside, "secret"); await symlink(outside, join(root, "escape")); await symlink("/dev/null", join(root, "device"));
  await writeFile(join(root, "NIGHTWATCH_REPORT-old.md"), "report");
  await assert.rejects(safePath(root, "../" + outside.split("/").at(-1)), /escapes/);
  await assert.rejects(safePath(root, outside), /escapes/);
  await assert.rejects(safePath(root, "escape"), /symlink escapes/);
  await assert.rejects(safePath(root, "device"), /symlink escapes|regular/);
  for (const path of [".git/secret", ".nightwatch/state", "NIGHTWATCH_REPORT-old.md"]) await assert.rejects(safePath(root, path), /excluded/);
});

test("read/search limits, cancellation, and subprocess errors work", async () => {
  const root = await fixture();
  assert.match(await readRepositoryFile(root, "app.js", 20), /truncated/);
  await writeFile(join(root, "lines.txt"), "one\ntwo\nthree\nfour\n");
  assert.equal(await readRepositoryLines(root, "lines.txt", 2, 2), "two\nthree\n\n[range truncated]");
  await assert.rejects(readRepositoryLines(root, "lines.txt", 0, 2), /invalid line range/);
  const readController = new AbortController(); readController.abort();
  await assert.rejects(readRepositoryLines(root, "lines.txt", 2, 2, readController.signal), /cancelled/);
  assert.match(await runRg(root, ["token", "."], undefined, 40, 2), /truncated/);
  await assert.rejects(runRg(root, ["[", "."]), /regex|error|unclosed/i);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runRg(root, ["token", "."], controller.signal), /cancelled/);
});

test("tool budget disables tools and requests the final report", async () => {
  const root = await fixture(), registered = new Map(), previous = {};
  for (const key of ["NIGHTWATCH_REPOSITORY", "NIGHTWATCH_MODE", "NIGHTWATCH_PROFILE", "NIGHTWATCH_MAX_TOOL_CALLS"]) previous[key] = process.env[key];
  Object.assign(process.env, { NIGHTWATCH_REPOSITORY: root, NIGHTWATCH_MODE: "security", NIGHTWATCH_PROFILE: "generic", NIGHTWATCH_MAX_TOOL_CALLS: "1" });
  let active, message;
  const pi = { on() {}, registerProvider() {}, registerTool(tool) { registered.set(tool.name, tool); }, setActiveTools(value) { active = value; }, sendUserMessage(value, options) { message = { value, options }; } };
  try { auditExtension(pi); await registered.get("list_repository").execute("id", {}, undefined); }
  finally { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; }
  assert.deepEqual(active, []);
  assert.match(message.value, /BUDGET REACHED/);
  assert.equal(message.options.deliverAs, "steer");
});

test("large repositories are divided into bounded path scopes", async () => {
  const root = await fixture();
  await mkdir(join(root, "alpha")); await mkdir(join(root, "beta"));
  await writeFile(join(root, "alpha", "large.txt"), Buffer.alloc(200_000));
  await writeFile(join(root, "beta", "large.txt"), Buffer.alloc(200_000));
  const scopes = await repositoryScopes(root, 250_000);
  assert.ok(scopes.length >= 2);
  assert.ok(scopes.flat().includes("alpha")); assert.ok(scopes.flat().includes("beta"));
});

test("tooling detection and JavaScript syntax checks are constrained", async () => {
  const root = await fixture();
  assert.match(await detectRepositoryTooling(root), /JavaScript: detected/);
  await writeFile(join(root, "app.js"), "const token = input;\n");
  assert.equal(await checkJavaScriptSyntax(root, "app.js"), "PASS: app.js");
  await writeFile(join(root, "broken.js"), "const = ;\n");
  assert.match(await checkJavaScriptSyntax(root, "broken.js"), /^FAIL: broken\.js/);
  await assert.rejects(checkJavaScriptSyntax(root, ".git/secret"), /excluded/);
  await assert.rejects(checkJavaScriptSyntax(root, "../outside.js"), /escapes/);
  await writeFile(join(root, "notes.txt"), "text\n");
  await assert.rejects(checkJavaScriptSyntax(root, "notes.txt"), /requires/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(checkJavaScriptSyntax(root, "app.js", controller.signal), /cancelled/);
});

function runCli(args, env) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve("bin/nightwatch.js"), ...args], { env: { ...process.env, ...env } });
    let stdout = "", stderr = ""; child.stdout.on("data", x => stdout += x); child.stderr.on("data", x => stderr += x);
    child.on("error", reject); child.on("close", code => done({ code, stdout, stderr }));
  });
}

test("help prints the implemented interface", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
});

test("CLI locks Pi down, publishes valid output, and enforces fresh", async () => {
  const root = await fixture(), fake = join(root, "fake-pi"), captured = join(root, "args.json");
  const event = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: validReport }] } });
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "$CAPTURE"\nprintf '%s\\n' '${event}'\n`); await chmod(fake, 0o755);
  await writeFile(join(root, ".nightwatch", "config.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:4000/v1", model: "local" }));
  const args = ["security", root];
  let result = await runCli(args, { NIGHTWATCH_PI: fake, CAPTURE: captured }); assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(join(root, "NIGHTWATCH_REPORT.md"), "utf8"), validReport);
  const piArgs = (await readFile(captured, "utf8")).trim().split("\n");
  for (const flag of ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-builtin-tools", "--no-approve"]) assert.ok(piArgs.includes(flag), flag);
  assert.equal(piArgs[piArgs.indexOf("--tools") + 1], "list_repository,read_repository_file,search_repository,detect_repository_tooling,check_javascript_syntax");
  assert.equal(piArgs[piArgs.indexOf("--model") + 1], "nightwatch-local/local");
  assert.deepEqual(piArgs.slice(piArgs.indexOf("--thinking"), piArgs.indexOf("--thinking") + 2), ["--thinking", "medium"]);
  result = await runCli(args, { NIGHTWATCH_PI: fake, CAPTURE: captured }); assert.equal(result.code, 3);
  result = await runCli([...args, "--fresh"], { NIGHTWATCH_PI: fake, CAPTURE: captured }); assert.equal(result.code, 0, result.stderr);
});

test("CLI reviews large scopes in fresh sessions before synthesis", async () => {
  const root = await fixture(), fake = join(root, "fake-pi");
  await mkdir(join(root, "alpha")); await mkdir(join(root, "beta"));
  await writeFile(join(root, "alpha", "large.txt"), Buffer.alloc(400_000));
  await writeFile(join(root, "beta", "large.txt"), Buffer.alloc(400_000));
  const event = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: validReport }] } });
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' '${event}'\n`); await chmod(fake, 0o755);
  const result = await runCli(["security", root, "--base-url", "http://localhost:4000/v1", "--model", "local", "--context-window", "1024"], { NIGHTWATCH_PI: fake });
  assert.equal(result.code, 0, result.stderr);
  const run = (await readdir(join(root, ".nightwatch", "runs")))[0];
  assert.ok((await readdir(join(root, ".nightwatch", "runs", run, "passes"))).filter(file => file.endsWith(".md")).length >= 2);
  assert.ok((await readdir(join(root, ".nightwatch", "runs", run, "session"))).some(name => name.startsWith("synthesis-")));
});

test("malformed output and Pi failure do not publish", async () => {
  const root = await fixture(), fake = join(root, "fake-pi");
  await writeFile(fake, "#!/bin/sh\necho not-json\n"); await chmod(fake, 0o755);
  const args = ["security", root, "--base-url", "http://localhost:4000/v1", "--model", "local"];
  let result = await runCli(args, { NIGHTWATCH_PI: fake }); assert.equal(result.code, 5); await assert.rejects(readFile(join(root, "NIGHTWATCH_REPORT.md")));
  await writeFile(fake, `#!/bin/sh\necho '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "There" }], stopReason: "length" } })}'\n`);
  result = await runCli(args, { NIGHTWATCH_PI: fake }); assert.equal(result.code, 5);
  const statuses = await Promise.all((await readdir(join(root, ".nightwatch", "runs"))).map(async run => JSON.parse(await readFile(join(root, ".nightwatch", "runs", run, "metadata.json"), "utf8")).status));
  assert.ok(statuses.includes("context-exhausted"));
  await writeFile(fake, "#!/bin/sh\nexit 9\n"); result = await runCli(args, { NIGHTWATCH_PI: fake }); assert.equal(result.code, 4);
});

test("resume reuses Pi's failed session", async () => {
  const root = await fixture(), fake = join(root, "fake-pi"), captured = join(root, "args"), run = join(root, ".nightwatch", "runs", "2026-test"), session = join(run, "session", "audit.jsonl");
  await mkdir(join(run, "agent"), { recursive: true }); await mkdir(join(run, "session")); await writeFile(session, "{}\n");
  await writeFile(join(run, "metadata.json"), JSON.stringify({ mode: "security", status: "malformed", git: { commit: null, dirty: null } }));
  const event = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: validReport }] } });
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "$CAPTURE"\nprintf '%s\\n' '${event}'\n`); await chmod(fake, 0o755);
  const result = await runCli(["security", root, "--base-url", "http://localhost:4000/v1", "--model", "local", "--resume"], { NIGHTWATCH_PI: fake, CAPTURE: captured });
  assert.equal(result.code, 0, result.stderr);
  const args = (await readFile(captured, "utf8")).trim().split("\n");
  assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), ["--session", session]);
});
