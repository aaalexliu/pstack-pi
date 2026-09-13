# Prototype

Use this playbook when a runnable probe can settle an implementation choice.

1. Write the decision and two or three plausible options. Use `/skill:architect` to define the shapes and `/skill:arena` when separate candidates need equal trials.
2. Choose the smallest probe that exposes the difference. Keep it outside production code when possible.
3. Define the observed result that would favor each option before running it.
4. Run competing probes in parallel only when they do not share writes.
5. Compare the results, choose one option, and record the evidence.
6. Delete throwaway probes. Keep only a test or tool that will prevent a future regression.

Read `../../principle-prove-it-works/SKILL.md` and `../../principle-experience-first/SKILL.md` when the choice affects users.
