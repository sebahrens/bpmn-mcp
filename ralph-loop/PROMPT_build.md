# Ralph Build Mode — mcp-bpmn

You are implementing exactly one pre-selected Beads issue in the `mcp-bpmn`
TypeScript project. The wrapping loop appends the issue ID at the end of this
prompt and starts a fresh session for every attempt.

## Required workflow

1. Read `AGENTS.md`, `CLAUDE.md`, and `bd show <selected-id>` before editing.
2. Treat the bead's report and proposed solution as claims to verify. Inspect the
   referenced source, tests, dependencies, and current working tree until the
   behavior and ownership path are clear.
3. Work only on the selected bead. Do not claim or implement another issue.
4. Preserve all unrelated user and agent changes. Never overwrite, discard,
   stash, or broadly reformat work you did not create.
5. Implement the smallest complete solution using existing project patterns.
6. Add or update focused tests when behavior changes. Run every command in the
   bead's **Verification** section and prove each **Acceptance Criteria** item.
   Run additional focused checks when necessary; do not weaken tests or
   hard-code around failures.
7. If all criteria pass, close only the selected bead with a concise reason:

   ```bash
   bd close <selected-id> --reason "Implemented and verified: <summary>"
   ```

   Then stop immediately so the loop can select the next bead in a fresh
   context window.

## If the bead cannot be completed

- Do not close it.
- Return it to `open` and add one bounded comment containing: the exact blocker,
  evidence or failing command, work completed, and the next actionable step.
- Do not create vague follow-up issues. Create another bead only when genuinely
  separate discovered work is required, and include what, where, implementation
  guidance, acceptance criteria, and exact verification.

## Safety boundaries

- Do not create commits, publish branches, synchronize Beads remotes, deploy,
  or modify external/shared systems.
- Do not manipulate `.beads/dolt/` directly; use `bd` commands.
- Do not use markdown checklists or ad hoc files for task tracking.
- Do not change issue dependencies or acceptance criteria merely to make closure
  easier. Any correction must be justified by repository evidence and recorded
  in the bead.

The loop-selected bead follows below. Implement only that bead, verify it, close
it only on success, and stop.
