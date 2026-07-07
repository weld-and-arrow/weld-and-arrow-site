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
        run('git commit -m "<task summary> <terse description of intent and approach>"')
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

    run("git push") # Approval of merge-into-main is also automatically an approval for git push to origin iff the final git merge went cleanly.

    # Cleanup only after main verifies cleanly.
    run("cd <main-worktree>")
    run("git worktree remove <task-worktree-path>")
    run("git branch -d <task-branch>")
    run("git worktree prune")
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

- Use `git merge --ff-only <task-branch>` when merging into `main`; this keeps
  history linear and refuses to create a merge commit.
- During rebase, conflict resolutions become part of the rebased commits.
- If the rebase reveals additional semantic work beyond conflict resolution,
  make a separate post-rebase adaptation commit after user approval.
- Do not remove a worktree while the shell is inside it.
- Remove the task worktree before deleting its branch.
- Use `git -c core.editor=true rebase --continue` so VS Code editor isn't atempted
- If the user responds "k" or "K", that means they pre-grant approval for every subsequent step of the AGENTS.md workflow, unless unexpected information surfaces, in which case rescinded - pause activity to raise the new information.
- Don't worry that the task worktree is still present at C:/Users/alicl/.codex/worktrees/ afterwards, it's locked by the process. If you reach that, don't acknowledge it, raise anything else that's genuinely important or print "DONE".
