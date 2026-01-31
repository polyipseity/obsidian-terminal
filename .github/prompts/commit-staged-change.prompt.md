---
name: commit-staged-change
description: Produce a commit message for the currently staged changes and commit by default.
argument-hint: Optional extras (e.g., ticket=ABC-123). To skip committing, pass `commitNow=no`.
agent: agent
---

# Commit Staged Change

When run, perform the task using exactly two shell commands: one to read the staged patch and one to create the commit (unless `commitNow=no`).

1. Command 1 — read the staged changes
    - Run exactly one compound command that prints the staged file list and the full staged patch. Example:

        ```shell
        git diff --cached --name-status --no-color && git --no-pager diff --cached --staged --patch --no-color
        ```

    - Present the exact command you will run; the IDE will request approval and execute it. Do not pause the chat waiting for manual approval. The agent MUST NOT solicit approval from the user directly — the IDE handles approvals. If Command 1 is not executed (no output), produce a best-effort commit message from available context and stop.
2. Compose the commit message
    - Inspect Command 1 output and repository conventions (CONTRIBUTING.md, `.github/`, `package.json`, `commitlint`, `.husky`, `CHANGELOG.md`, etc.) and produce a final commit message with:
        - a short subject (~50 chars),
        - optional body wrapped at ~72 chars with bullet points, and
        - footer (BREAKING CHANGE / Refs / Ticket) including `${input:extra}` if provided.
    - If conventions conflict, prefer tooling-enforced rules. If unsure, ask one concise clarifying question; otherwise default to Conventional Commits.
3. Command 2 — create the commit
    - If `${input:commitNow}` is `no`, do not run Command 2; only present the message.
    - Otherwise, present the exact Command 2 you will run; the IDE will request approval and execute it. The agent MUST NOT ask the user to grant approval itself. Command 2 must be a single compound command that creates the commit from stdin and prints the new SHA. Example:

        ```shell
        git commit --file - <<'MSG'
        <full commit message>
        MSG
        && git rev-parse HEAD
        ```

    - Construct Command 2 appropriate for the current shell (PowerShell here-strings vs POSIX heredoc). If Command 2 runs, capture exit status and new HEAD SHA.
    - If Command 2 fails due to shell quoting/heredoc syntax, the agent MAY retry up to 3 corrected forms (presenting each revised command for the IDE to run). For other failures (git hooks, refs, permissions), report the error and do not modify the index.
    - If Command 2 is not executed, report that no commit was performed.
    - User-suggested message edits: if the user provides an alternative commit message after Command 1 but before Command 2 runs, the agent should incorporate the edits, present the updated full message and the exact Command 2 for the IDE to execute, and repeat until Command 2 runs successfully (unless `commitNow=no`, in which case only present updated messages).
4. Output (must follow):
    - 1–2 line summary: staged files and detected convention
    - Commit message block labelled `Commit message` (header/body/footer)
    - If Command 2 ran: `Commit result` with exit status and new commit SHA
    - 1–3 line justification why this message fits the change

Rules:

- Do not run any other shell commands beyond the two approved commands.
- Do not run `git add` / `git reset` or otherwise change the index.
- If the user denies approval for Command 1, still propose a best-effort commit message using available non-executed context.

Inputs:

- `${input:extra}` — optional extra text to include in footer
- `${input:commitNow}` — `no` to skip committing; default is to commit

End of prompt.
