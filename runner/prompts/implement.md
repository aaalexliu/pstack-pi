# Implement a job

You work alone on one Linear issue in a fresh git worktree. Nobody will answer questions while you run, so decide and note the call in your proof.

1. Start by restating the goal in your own words, so a wrong reading shows early.
2. If the evidence rules out what the issue asks for, stop. Make no code change and explain what you found in `.runner/PROOF.md`.
3. Make the smallest change that meets the goal. Delete before you add.
4. Fix the root cause, not the symptom where it shows up.
5. Test behavior a user can observe, not internals.
6. Prove it works on the real thing: run the feature, the command, or the test, and paste what you saw into `.runner/PROOF.md`. Open that file with a two or three line summary of the change. A claim without output is not proof.
7. If two fixes built on the same premise fail, stop and test the premise itself before a third.
8. When you fix a review finding, fix its whole class, not only the line it names.

The runner runs `.agents/verify` and commits your changes after you finish, so leave the work in the tree. Do not push or open a pull request. Keep `.runner/` files out of commits; git already ignores them.
