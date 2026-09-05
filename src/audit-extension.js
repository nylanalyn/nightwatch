import { readRepositoryFile, rgExclusions, runRg } from "./repository.js";
import { readFileSync } from "node:fs";

const text = description => ({ type: "string", description });
const result = value => ({ content: [{ type: "text", text: value || "(no results)" }], details: {} });

export default function (pi) {
  const root = process.env.NIGHTWATCH_REPOSITORY;
  if (!root) throw new Error("NIGHTWATCH_REPOSITORY is required");
  const skill = readFileSync(new URL(`../skills/${process.env.NIGHTWATCH_MODE}/SKILL.md`, import.meta.url), "utf8");
  pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${skill}` }));
  pi.registerProvider("nightwatch-local", {
    baseUrl: process.env.NIGHTWATCH_BASE_URL,
    apiKey: process.env.NIGHTWATCH_API_KEY || "not-required",
    api: "openai-completions",
    models: [{ id: process.env.NIGHTWATCH_MODEL, name: process.env.NIGHTWATCH_MODEL, reasoning: true, thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: Number(process.env.NIGHTWATCH_CONTEXT_WINDOW), maxTokens: Math.min(32768, Math.floor(Number(process.env.NIGHTWATCH_CONTEXT_WINDOW) / 2)), compat: { thinkingFormat: "qwen-chat-template", thinkingTokenBudgetField: "thinking_budget_tokens" } }]
  });
  pi.registerTool({ name: "list_repository", label: "List repository", description: "List repository files. Excludes Nightwatch state and Git internals.", parameters: { type: "object", properties: {}, additionalProperties: false }, async execute(_id, _params, signal) { return result(await runRg(root, ["--files", "--hidden", ...rgExclusions], signal)); } });
  pi.registerTool({ name: "read_repository_file", label: "Read repository file", description: "Read at most 64 KiB from a repository-relative regular file.", parameters: { type: "object", properties: { path: text("Repository-relative file path") }, required: ["path"], additionalProperties: false }, async execute(_id, params) { return result(await readRepositoryFile(root, params.path)); } });
  pi.registerTool({ name: "search_repository", label: "Search repository", description: "Search repository text with a bounded ripgrep regular expression.", parameters: { type: "object", properties: { pattern: text("ripgrep regular expression") }, required: ["pattern"], additionalProperties: false }, async execute(_id, params, signal) { return result(await runRg(root, ["--line-number", "--hidden", "--color", "never", ...rgExclusions, "--", params.pattern, "."], signal)); } });
}
