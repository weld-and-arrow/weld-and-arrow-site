# Task Worktree To Main Process

When starting a Codex implementation task, create a task branch up front and
record the `main` commit it starts from.

This repo prefers linear history. Reconcile task branches with `main` by
rebasing, not by merging `main` into the task branch.

Do not commit-and-rebase-main, or merge-and-remove-worktrees, unless the user
has explicitly approved that phase.

## Workflow

```python
def task_worktree_to_main():
    # Start
    base = run("git rev-parse main")
    run("git switch -c codex/<task-name>")  # if not already on a task branch

    implement_task()

    run("lake build")
    run_optional('rg -n "sorry|admit|axiom" <new-or-touched-lean-files>')
    run_optional("#print axioms <important_new_theorem>")

    ask_user("Commit completed task?")
    if approved:
        run("git status --short")
        run("git add <all changes>")
        run('git commit -m "<task summary>\n\n<terse description of intent and approach>"') # the commit description should include whatever the change itself can't say - motivation, design decisions, etc. from the plan, as well as decisions at implementation time. Basically, any extra info the code itself couldn't state.
    else:
        stop()

    # Reconcile with main
    while main_moved_since(base):
        show("git log --oneline $base..main")
        show("git diff --stat $base..main")

        run("git rebase main")

        # - resolve textual conflicts
        # - keep the task's intended semantics unless main has changed the relevant conventio. Feel free to git blame and review the commit message and commit diff for the new main commits.
        # - run `git add <resolved files>`
        # - run `git rebase --continue`
        # - repeat until rebase completes

        semantic_sanity_check(base)

        run("lake build")
        run_optional('rg -n "sorry|admit|axiom" <new-or-touched-lean-files>')
        run_optional("#print axioms <important_new_theorem>")

        if working_tree_has_changes():
            ask_user("Commit post-rebase semantic adaptations?")
            if approved:
                run("git status --short")
                run("git add <all changes>")
                run('git commit -m "Adapt <task-name> to current main"')
            else:
                stop()

        base = run("git rev-parse main")

    # Final merge approval
    ask_user("Final review and merge into main?")
    if not approved:
        stop()

    # Check again immediately before touching main.
    if main_moved_since(base):
        goto_reconcile_with_main()

    # Merge into real main worktree.
    run("cd <main-worktree>")
    run("git status --short")  # stop if not clean
    run("git switch main")
    run("git merge --ff-only <task-branch>")

    run("lake build")

    run("git push") # Approval of merge-into-main is also automatically an approval for git push to origin iff the final git merge went cleanly, even when unrelated commits will be pushed too.

    # Cleanup after main verifies cleanly. The Codex process may keep the task
    # worktree locked, so detach it before deleting the branch and make physical
    # worktree removal best-effort.
    run("git -C <task-worktree-path> status --short")  # stop if not clean
    run("git -C <task-worktree-path> switch --detach <task-branch>")
    run("cd <main-worktree>")
    run("git branch -d <task-branch>")
    run("git branch --list <task-branch>")  # must print nothing
    run_optional("git worktree remove <task-worktree-path>")
    run_optional("git worktree prune")
```

## Semantic Sanity Check

After rebasing onto a moved `main`, do a semantic sanity check, not just a
conflict check:

- Read the commits from `main` that were incorporated:
  ```powershell
  git log --oneline $base..main
  git diff --stat $base..main
  ```
- Inspect touched files that overlap conceptually with this task.
- Look for naming, namespace, theorem-shape, import, prose-register, or API
  convention changes.
- Apply any implications from `main` to the current work too.
  Example: if `main` renamed a convention, reword or rename the task code
  accordingly.
- Search for stale terms if relevant:
  ```powershell
  rg "OldName|old_phrase|old_namespace"
  ```

## Notes

- Do a `git pull` first
- Use `git merge --ff-only <task-branch>` when merging into `main`; this keeps
  history linear and refuses to create a merge commit.
- During rebase, conflict resolutions become part of the rebased commits.
- If the rebase reveals additional semantic work beyond conflict resolution,
  make a separate post-rebase adaptation commit after user approval.
- Do not remove a worktree while the shell is inside it.
- Before deleting a task branch, detach its worktree at the task branch's tip.
  Delete and verify the branch before attempting to remove the worktree, because
  the active Codex process may keep the worktree locked.
- Use `git -c core.editor=true rebase --continue` so VS Code editor isn't atempted
- Commit messages must contain real hard line breaks, not merely visual wrapping. Use a one-line subject no longer than 75 columns, followed by a blank line. Hard-wrap body paragraphs at 75 columns in the stored commit message. Do not supply the body as one long git commit -m argument. Verify the final message before committing.
- If the user responds "k" or "K", that means they pre-grant approval for every subsequent step of the AGENTS.md workflow, unless unexpected information surfaces, in which case rescinded - pause activity to raise the new information.
- The task worktree may remain at C:/Users/alicl/.codex/worktrees/ while it is
  locked by the Codex process. That is acceptable only after its task branch has
  been detached, deleted, and verified absent. If so, don't acknowledge the
  remaining worktree; raise anything else genuinely important or print "DONE".
- You are permitted to git push to https://github.com/weld-and-arrow/weld-and-arrow and https://github.com/weld-and-arrow/weld-and-arrow-site
