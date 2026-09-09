import { execFile, spawn } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const MAX_BYTES = 64 * 1024;
const MAX_LINES = 1000;
const executeFile = promisify(execFile);

export async function safePath(root, requested, scopes) {
  if (typeof requested !== "string" || !requested || requested.includes("\0")) throw new Error("invalid path");
  const absolute = resolve(root, requested);
  if (absolute !== root && !absolute.startsWith(root + sep)) throw new Error("path escapes repository");
  const actual = await realpath(absolute);
  if (actual !== root && !actual.startsWith(root + sep)) throw new Error("symlink escapes repository");
  const rel = relative(root, actual).replaceAll(sep, "/");
  if (rel === ".git" || rel.startsWith(".git/") || rel === ".nightwatch" || rel.startsWith(".nightwatch/") || /(^|\/)NIGHTWATCH_REPORT(?:[^/]*)\.md$/i.test(rel)) throw new Error("path is excluded");
  if (process.env.NIGHTWATCH_OUTPUT && actual === resolve(process.env.NIGHTWATCH_OUTPUT)) throw new Error("path is excluded");
  if (!(await lstat(actual)).isFile()) throw new Error("path is not a regular file");
  if (scopes?.length && !scopes.some(scope => rel === scope || rel.startsWith(`${scope}/`))) throw new Error("path is outside the current review scope");
  return actual;
}

export async function readRepositoryFile(root, requested, maxBytes = MAX_BYTES) {
  const path = await safePath(root, requested);
  const file = await open(path, "r");
  try { const buffer = Buffer.alloc(Math.min(maxBytes, MAX_BYTES)); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead).toString("utf8") + (bytesRead === buffer.length ? "\n[output truncated]" : ""); }
  finally { await file.close(); }
}

export async function readRepositoryLines(root, requested, startLine = 1, lineCount = 200, signal, scopes) {
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > MAX_LINES) throw new Error("invalid line range");
  const path = await safePath(root, requested, scopes), file = await open(path, "r"), scan = Buffer.alloc(64 * 1024);
  let position = 0, line = 1;
  try {
    while (line < startLine) {
      if (signal?.aborted) throw new Error("cancelled");
      const { bytesRead } = await file.read(scan, 0, scan.length, position);
      if (!bytesRead) return "";
      for (let i = 0; i < bytesRead; i++) if (scan[i] === 10 && ++line === startLine) { position += i + 1; break; }
      if (line < startLine) position += bytesRead;
    }
    if (signal?.aborted) throw new Error("cancelled");
    const output = Buffer.alloc(MAX_BYTES), { bytesRead } = await file.read(output, 0, output.length, position);
    let end = bytesRead, lines = 0;
    for (let i = 0; i < bytesRead; i++) if (output[i] === 10 && ++lines === lineCount) { end = i + 1; break; }
    const truncated = end < bytesRead || bytesRead === output.length;
    return output.subarray(0, end).toString("utf8") + (truncated ? "\n[range truncated]" : "");
  } finally { await file.close(); }
}

export async function detectRepositoryTooling(root, signal, targets = ["."]) {
  const files = await runRg(root, ["--files", "--hidden", ...rgExclusions, "-g", "package.json", "-g", "*.js", "-g", "*.mjs", "-g", "*.cjs", "-g", "pyproject.toml", "-g", "*.py", "-g", "Cargo.toml", "-g", "go.mod", "-g", "*.sh", "-g", "Dockerfile", "-g", "docker-compose.y*ml", "--", ...targets], signal);
  const lines = files.split("\n");
  const detected = [
    [/package\.json$|\.(?:[cm]?js)$/i, "JavaScript: detected; node syntax check available for .js, .mjs, and .cjs files"],
    [/pyproject\.toml$|\.py$/i, "Python: detected; no approved analyzer available"],
    [/(?:^|\/)Cargo\.toml$/i, "Rust: detected; no approved analyzer available"],
    [/(?:^|\/)go\.mod$/i, "Go: detected; no approved analyzer available"],
    [/\.sh$/i, "Shell: detected; no approved analyzer available"],
    [/(?:^|\/)(?:Dockerfile|docker-compose\.ya?ml)$/i, "Containers: detected; no approved analyzer available"]
  ].filter(([pattern]) => lines.some(file => pattern.test(file))).map(([, message]) => message);
  return detected.join("\n") || "No supported language or tooling markers detected.";
}

export async function checkJavaScriptSyntax(root, requested, signal, scopes) {
  const path = await safePath(root, requested, scopes);
  if (![".js", ".mjs", ".cjs"].includes(extname(path).toLowerCase())) throw new Error("node syntax check requires a .js, .mjs, or .cjs file");
  const shown = relative(root, path).replaceAll(sep, "/");
  try {
    await executeFile(process.execPath, ["--check", path], { cwd: root, env: { PATH: process.env.PATH || "/usr/bin:/bin" }, signal, timeout: 30_000, maxBuffer: MAX_BYTES });
    return `PASS: ${shown}`;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("cancelled");
    if (error.killed) throw new Error("node syntax check timed out");
    const output = `${error.stdout || ""}${error.stderr || ""}`.replaceAll(path, shown).trim();
    if (typeof error.code === "number") return `FAIL: ${shown}\n${output || `node exited ${error.code}`}`;
    throw error;
  }
}

export async function repositoryScopes(root, targetBytes, maxFiles = 50) {
  const listing = await runRg(root, ["--files", "--hidden", ...rgExclusions], undefined, 4 * 1024 * 1024, 100_000);
  if (listing.endsWith("[output truncated]")) throw new Error("repository file list exceeds the supported limit");
  const files = [];
  for (const path of listing.trim().split("\n").filter(Boolean).sort()) files.push({ path, size: (await lstat(await safePath(root, path))).size });
  if (!files.length) return [["."]];
  const scopes = [];
  for (const file of files) {
    const current = scopes.at(-1);
    if (current && current.paths.length < maxFiles && current.size + file.size <= targetBytes) { current.paths.push(file.path); current.size += file.size; }
    else scopes.push({ paths: [file.path], size: file.size });
  }
  return scopes.map(scope => scope.paths);
}

export function runRg(root, args, signal, maxBytes = MAX_BYTES, maxLines = MAX_LINES) {
  return new Promise((done, reject) => {
    const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "", lines = 0, truncated = false;
    const stop = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", stop, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(); }, 30_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      for (const line of chunk.split(/(?<=\n)/)) { if (Buffer.byteLength(output + line) > maxBytes || lines >= maxLines) { truncated = true; stop(); break; } output += line; if (line.endsWith("\n")) lines++; }
    });
    child.stderr.on("data", chunk => { if (errors.length < 4096) errors += chunk; });
    child.once("error", reject);
    child.once("close", code => { clearTimeout(timer); signal?.removeEventListener("abort", stop); if (signal?.aborted) return reject(new Error("cancelled")); if (timedOut) return reject(new Error("rg timed out")); if (code === null && !truncated) return reject(new Error("rg terminated")); if (![0, 1, null].includes(code)) return reject(new Error(errors.trim() || `rg exited ${code}`)); done(output + (truncated ? "\n[output truncated]" : "")); });
  });
}

export const rgExclusions = ["-g", "!.git/**", "-g", "!.nightwatch/**", "-g", "!NIGHTWATCH_REPORT*.md"];
