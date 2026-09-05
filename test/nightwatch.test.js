import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { assistantText, containedDirectory, parseArgs, validateReport } from "../bin/nightwatch.js";
import { readRepositoryFile, runRg, safePath } from "../src/repository.js";

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
  assert.throws(() => parseArgs(["security", ".", "--model", "m", "--base-url", "http://localhost/v1", "--fresh", "--resume"]), /cannot be combined/);
});

test("report validation checks structure and unique findings", () => {
  assert.equal(validateReport(validReport), true);
  assert.equal(validateReport(validReport.replace("## Summary", "## Notes")), false);
  const finding = `### NW-001 — Test\nSeverity: LOW\nConfidence: HIGH\nAffected Files: a\nEvidence: e\nSuggested Action: s\nVerification: v\n`;
  assert.equal(validateReport(validReport.replace("No supported findings.", finding + finding)), false);
  assert.equal(assistantText(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [null] } })), "");
  assert.equal(assistantText(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "text" } })), undefined);
});

test("wrapper write directories reject symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nightwatch-write-")), outside = await mkdtemp(join(tmpdir(), "nightwatch-outside-"));
  await symlink(outside, join(root, ".nightwatch"));
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
  assert.match(await runRg(root, ["token", "."], undefined, 40, 2), /truncated/);
  await assert.rejects(runRg(root, ["[", "."]), /regex|error|unclosed/i);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runRg(root, ["token", "."], controller.signal), /cancelled/);
});

function runCli(args, env) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve("bin/nightwatch.js"), ...args], { env: { ...process.env, ...env } });
    let stdout = "", stderr = ""; child.stdout.on("data", x => stdout += x); child.stderr.on("data", x => stderr += x);
    child.on("error", reject); child.on("close", code => done({ code, stdout, stderr }));
  });
}

test("CLI locks Pi down, publishes valid output, and enforces fresh", async () => {
  const root = await fixture(), fake = join(root, "fake-pi"), captured = join(root, "args.json");
  const event = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: validReport }] } });
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "$CAPTURE"\nprintf '%s\\n' '${event}'\n`); await chmod(fake, 0o755);
  const args = ["security", root, "--base-url", "http://127.0.0.1:4000/v1", "--model", "local"];
  let result = await runCli(args, { NIGHTWATCH_PI: fake, CAPTURE: captured }); assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(join(root, "NIGHTWATCH_REPORT.md"), "utf8"), validReport);
  const piArgs = (await readFile(captured, "utf8")).trim().split("\n");
  for (const flag of ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-builtin-tools", "--no-approve"]) assert.ok(piArgs.includes(flag), flag);
  assert.deepEqual(piArgs.slice(piArgs.indexOf("--thinking"), piArgs.indexOf("--thinking") + 2), ["--thinking", "medium"]);
  result = await runCli(args, { NIGHTWATCH_PI: fake, CAPTURE: captured }); assert.equal(result.code, 3);
  result = await runCli([...args, "--fresh"], { NIGHTWATCH_PI: fake, CAPTURE: captured }); assert.equal(result.code, 0, result.stderr);
});

test("malformed output and Pi failure do not publish", async () => {
  const root = await fixture(), fake = join(root, "fake-pi");
  await writeFile(fake, "#!/bin/sh\necho not-json\n"); await chmod(fake, 0o755);
  const args = ["security", root, "--base-url", "http://localhost:4000/v1", "--model", "local"];
  let result = await runCli(args, { NIGHTWATCH_PI: fake }); assert.equal(result.code, 5); await assert.rejects(readFile(join(root, "NIGHTWATCH_REPORT.md")));
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
