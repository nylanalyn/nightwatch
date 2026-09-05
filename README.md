# Nightwatch

Nightwatch runs long, read-only repository reviews with a local model through [Pi](https://github.com/earendil-works/pi-mono). It gives the model only bounded repository list, read, and search tools, then validates and publishes a Markdown report.

## Requirements

- Linux
- Node.js 20 or newer
- Pi 0.85
- `rg` and Git
- A loopback OpenAI-compatible model endpoint

No Node dependencies are required.

## Setup

Run directly:

```bash
node bin/nightwatch.js --help
```

Or make `nightwatch` available on your `PATH`:

```bash
npm link
```

## Usage

```text
nightwatch <mode> <path>
  --base-url <loopback-url>
  --model <id>
  [--api-key-env <name>]
  [--context-window <tokens>]
  [--profile <generic|irc-bot|web-app|simulation>]
  [--output <path>]
  [--fresh|--resume]
```

Modes:

- `security` — trust boundaries, attacker-controlled input, authorization, secrets, command execution, and unsafe defaults.
- `maintainability` — duplication, unnecessary complexity, fragile assumptions, dependencies, and testability.
- `consistency` — unjustified differences across analogous features and commands.
- `plan` — implementation compared with documented project intent.
- `ux` — discoverability, setup, help, errors, terminology, and accessibility.
- `ideas` — grounded, proportionate product opportunities.
- `balance` — progression, incentives, pacing, dominant choices, and dead ends.
- `adversary` — constructive challenges to unnecessary product and system complexity.
- `general` — broader review across correctness, security, maintainability, consistency, documentation, UX, and project intent.

Example:

```bash
nightwatch security ~/code/project \
  --base-url http://127.0.0.1:8080/v1 \
  --model Qwen3.8-27B \
  --context-window 64000
```

### llama.cpp

Start an OpenAI-compatible local server:

```bash
llama serve \
  -hf ggml-org/Qwen3.8-27B-GGUF:Q4_K_M \
  --host 127.0.0.1 \
  --port 8080 \
  -c 64000 \
  -ngl 99
```

Reduce `-ngl` if the model does not fit in VRAM.

## Options

- `--base-url` is required and accepts only `localhost`, `127.0.0.1`, or `::1`. A loopback proxy may still route requests remotely; Nightwatch cannot verify its upstream.
- `--model` is required. Nightwatch never falls back to another model or provider.
- `--api-key-env` names an environment variable containing the endpoint credential. Secrets are never passed as command-line arguments.
- `--context-window` defaults to `65536`.
- `--profile` adds trusted project-type priorities and defaults to `generic`.
- `--output` defaults to `NIGHTWATCH_REPORT.md` inside the reviewed repository.
- `--fresh` permits replacing an existing report.
- `--resume` continues the newest failed run for the selected mode using Pi's native session. It refuses if the Git commit or working-tree state changed. It cannot be combined with `--fresh`.

## Output

A successful run atomically writes `NIGHTWATCH_REPORT.md`. Run state is retained under:

```text
.nightwatch/runs/<run-id>/
```

Successful runs keep compact metadata and Pi's session JSONL. Failed or malformed runs additionally keep `diagnostic.log` beginning with `AUDIT INCOMPLETE`. Source files are never modified by the audit tools.

Exit codes:

| Code | Meaning |
| ---: | --- |
| 0 | Valid report published |
| 2 | Invalid arguments or unsafe path |
| 3 | Report already exists |
| 4 | Pi or model failure |
| 5 | Malformed report output |

## Development

```bash
npm test
```

See [PLAN.md](PLAN.md) for architecture, threat model, and deferred work.
