---
name: to-spec
description: Write a spec (PRD) for graph-execution in docs/prd/<name>.md with a Mermaid diagram of the workflow, then ask the user to read it and approve it or ask for changes. Use when the user wants a spec, PRD or plan for graph-execution, or before to-tasks when there is no spec yet.
---

# To Spec

Write a spec (PRD) that `to-tasks` can break into tasks and that graph-execution's agents, reviewer and tester read during the run. The spec is the contract for the whole run: agents work unattended, so everything a human would have to decide must be decided here.

## Process

### 1. Gather

- Read what the user gives you: the tickets, the issue (fetch it with its comments if you get a number, URL or path), and the conversation so far.
- Explore the codebase enough to be concrete: the files and modules the change touches, the existing patterns, the commands that build and test it. Check CLAUDE.md, AGENTS.md and any ADRs in `docs/adr/`.
- Ask the user now every question that would otherwise need a human during the run: scope, behaviour in edge cases, names, messages, what is out of scope. Bake the answers into the spec.

### 2. Write `docs/prd/<name>.md`

- Use a short kebab-case `<name>` (`export-csv`, `login-rate-limit`). Create `docs/prd/` if it is missing. Never write inside `docs/prd/done/`: that folder holds finished specs.
- Save early and in a few steps (a first outline, then each section) rather than all at the end: graph-manager shows the file live next to the terminal while you write it.
- Use these sections, in this order:
  1. **Problem**: what is wrong or missing today, for whom.
  2. **Goals**: a numbered list, each with its ticket key when there is one.
  3. **A Mermaid diagram** of the workflow or main flow, in a ```` ```mermaid ```` block. Pick the kind that explains the change best: `flowchart`, `sequenceDiagram` or `stateDiagram-v2`. Keep node labels short, quote labels that contain special characters (`A["Save (draft)"]`), and use no HTML other than `<br/>`. Check that it parses (balanced brackets and quotes, one statement per line, valid arrows).
  4. **Decisions**: a table with the columns *Decision* and *Why*.
  5. **Non-goals**: what this change deliberately does not do.
  6. **User stories**: "As a …, I …".
  7. **Requirements**: concrete files, commands, messages, API shapes, data formats, grouped by area.
  8. **Acceptance criteria**: observable checks as checkboxes (`- [ ] …`): status codes, UI text, files, command output.

### 3. Ask for review

- When the spec is done, tell the user its path and ask them to read it (in graph-manager it is already open beside the terminal; elsewhere, in any Markdown viewer) and to approve it or say what to change.
- Apply the changes to the file and ask again.
- Do not continue until the user approves.

### 4. Next

- Once the spec is approved, offer to break it into tasks with the `to-tasks` skill, then to start the run with the `run-graph` skill.
- When the result is turned into a PR with graph-manager's **Create PR**, the spec moves to `docs/prd/done/<name>.md` in that commit. Outside graph-manager, move it there yourself in the PR.
