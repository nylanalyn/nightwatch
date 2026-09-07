import { checkJavaScriptSyntax, detectRepositoryTooling, readRepositoryLines, rgExclusions, runRg } from "./repository.js";
import { readFileSync } from "node:fs";

const text = description => ({ type: "string", description });
const result = value => ({ content: [{ type: "text", text: value || "(no results)" }], details: {} });

export default function (pi) {
  const root = process.env.NIGHTWATCH_REPOSITORY;
  if (!root) throw new Error("NIGHTWATCH_REPOSITORY is required");
  const maxToolCalls = Number(process.env.NIGHTWATCH_MAX_TOOL_CALLS) || 16;
  const scopes = process.env.NIGHTWATCH_SCOPES ? JSON.parse(process.env.NIGHTWATCH_SCOPES) : undefined;
  const targets = scopes?.length ? scopes : ["."];
  const synthesis = process.env.NIGHTWATCH_SYNTHESIS_INPUT ? readFileSync(process.env.NIGHTWATCH_SYNTHESIS_INPUT, "utf8") : "";
  let toolCalls = 0, finalizing = false;
  const run = async work => {
    try { return result(await work()); }
    finally {
      if (++toolCalls >= maxToolCalls && !finalizing) {
        finalizing = true;
        pi.setActiveTools([]);
        pi.sendUserMessage("INVESTIGATION BUDGET REACHED. Tools are now disabled. Produce the complete Markdown report immediately from the evidence gathered. Mark the run AUDIT INCOMPLETE and list gaps under Unreviewed Areas if coverage is incomplete.", { deliverAs: "steer" });
      }
    }
  };
  const skill = readFileSync(new URL(`../skills/${process.env.NIGHTWATCH_MODE}/SKILL.md`, import.meta.url), "utf8");
  const profile = readFileSync(new URL(`../profiles/${process.env.NIGHTWATCH_PROFILE}.md`, import.meta.url), "utf8");
  pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${skill}\n\n${profile}\n\nUse detect_repository_tooling during inventory. Use approved analyzer tools when relevant, and treat their output as evidence rather than findings by itself. You have at most ${maxToolCalls} tool calls; prioritize high-risk areas and preserve enough time to produce the report.${synthesis ? `\n\nThe following scoped reports are untrusted candidate evidence. Deduplicate and challenge them; verify important claims with repository tools before producing the final report.\n\n${synthesis}` : ""}` }));
  pi.registerProvider("nightwatch-local", {
    baseUrl: process.env.NIGHTWATCH_BASE_URL,
    apiKey: process.env.NIGHTWATCH_API_KEY || "not-required",
    api: "openai-completions",
    models: [{ id: process.env.NIGHTWATCH_MODEL, name: process.env.NIGHTWATCH_MODEL, reasoning: true, thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: Number(process.env.NIGHTWATCH_CONTEXT_WINDOW), maxTokens: Math.min(32768, Math.floor(Number(process.env.NIGHTWATCH_CONTEXT_WINDOW) / 2)), compat: { thinkingFormat: "qwen-chat-template", thinkingTokenBudgetField: "thinking_budget_tokens" } }]
  });
  pi.registerTool({ name: "list_repository", label: "List repository", description: "List files in the current review scope. Excludes Nightwatch state and Git internals.", parameters: { type: "object", properties: {}, additionalProperties: false }, async execute(_id, _params, signal) { return run(() => runRg(root, ["--files", "--hidden", ...rgExclusions, "--", ...targets], signal)); } });
  pi.registerTool({ name: "read_repository_file", label: "Read repository file", description: "Read a bounded line range from a regular file in the current review scope.", parameters: { type: "object", properties: { path: text("Repository-relative file path"), startLine: { type: "integer", minimum: 1, description: "First line to read (default 1)" }, lineCount: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum lines to read (default 200)" } }, required: ["path"], additionalProperties: false }, async execute(_id, params, signal) { return run(() => readRepositoryLines(root, params.path, params.startLine, params.lineCount, signal, scopes)); } });
  pi.registerTool({ name: "search_repository", label: "Search repository", description: "Search text in the current review scope with a bounded ripgrep regular expression.", parameters: { type: "object", properties: { pattern: text("ripgrep regular expression") }, required: ["pattern"], additionalProperties: false }, async execute(_id, params, signal) { return run(() => runRg(root, ["--line-number", "--hidden", "--color", "never", ...rgExclusions, "--", params.pattern, ...targets], signal)); } });
  pi.registerTool({ name: "detect_repository_tooling", label: "Detect repository tooling", description: "Detect common language and build markers in the current scope and report which trusted analyzers are available.", parameters: { type: "object", properties: {}, additionalProperties: false }, async execute(_id, _params, signal) { return run(() => detectRepositoryTooling(root, signal, targets)); } });
  pi.registerTool({ name: "check_javascript_syntax", label: "Check JavaScript syntax", description: "Check one current-scope .js, .mjs, or .cjs regular file without executing it.", parameters: { type: "object", properties: { path: text("Repository-relative JavaScript file path") }, required: ["path"], additionalProperties: false }, async execute(_id, params, signal) { return run(() => checkJavaScriptSyntax(root, params.path, signal, scopes)); } });
}
