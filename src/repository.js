import { spawn } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const MAX_BYTES = 64 * 1024;
const MAX_LINES = 1000;

export async function safePath(root, requested) {
  if (typeof requested !== "string" || !requested || requested.includes("\0")) throw new Error("invalid path");
  const absolute = resolve(root, requested);
  if (absolute !== root && !absolute.startsWith(root + sep)) throw new Error("path escapes repository");
  const actual = await realpath(absolute);
  if (actual !== root && !actual.startsWith(root + sep)) throw new Error("symlink escapes repository");
  const rel = relative(root, actual).replaceAll(sep, "/");
  if (rel === ".git" || rel.startsWith(".git/") || rel === ".nightwatch" || rel.startsWith(".nightwatch/") || /(^|\/)NIGHTWATCH_REPORT(?:[^/]*)\.md$/i.test(rel)) throw new Error("path is excluded");
  if (process.env.NIGHTWATCH_OUTPUT && actual === resolve(process.env.NIGHTWATCH_OUTPUT)) throw new Error("path is excluded");
  if (!(await lstat(actual)).isFile()) throw new Error("path is not a regular file");
  return actual;
}

export async function readRepositoryFile(root, requested, maxBytes = MAX_BYTES) {
  const path = await safePath(root, requested);
  const file = await open(path, "r");
  try { const buffer = Buffer.alloc(Math.min(maxBytes, MAX_BYTES)); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead).toString("utf8") + (bytesRead === buffer.length ? "\n[output truncated]" : ""); }
  finally { await file.close(); }
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
