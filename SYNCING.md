# Syncing Cursor pstack

The generated skills and agents come from the pinned Cursor source recorded in `sync/upstream.lock.json`. The current pin is commit `f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d`, tree `6d4e9d1140f70c483e5617c405baa5bb5654e211` under `pstack/`.

The repository keeps four layers separate:

- `vendor/cursor-pstack/` is the exact offline source snapshot.
- `sync/manifest.json` classifies every upstream file as `copy`, `transform`, `replace`, or `omit`.
- `sync/replacements/` contains reviewed full-file Pi adaptations. `ADAPTATIONS.md` explains each one.
- `skills/` and `agents/` are generated outputs. Do not edit them directly.

## Check or regenerate the current pin

These commands use the offline snapshot and need no upstream checkout:

```sh
npm run sync:check
npm run sync
npm run sync:check
npm run check:content
```

`sync:check` is read-only. `sync` writes only managed generated content. Neither command changes package metadata or docs.

## Prefer deterministic edits over rewrites

Routine sync never calls an LLM. The importer applies reviewed bytes and exact literal transforms. Choose the smallest rule that changes only host mechanics:

1. Copy compatible content, including references and principle skills.
2. Use ordered `find` / `replace` / `count` transforms for commands, paths, unsupported frontmatter, or a bounded runtime block. Each rule requires the exact upstream blob and occurrence count. Unmatched or repeated anchors fail closed; there is no fuzzy matching.
3. Keep full replacements only where ownership changes throughout the workflow, such as parent-only external searches or cloud coordination becoming bounded local tasks. Compare the full source and preserve its behavioral contracts before relocking.

Interrogate is the worked example in `sync/manifest.json`: only its reviewer-launch section and one verification clause change. Its other sections stay verbatim upstream. Do not turn a full rewrite into one giant transform; that hides the same loss under another name.

Do not globally delete lines containing `Cursor`, `Task`, or `readonly`. Those words may name real services, protocol fields, review authors, or ordinary code. Renaming `Task` alone cannot make nested delegation or secret-request cards work in Pi. Review those runtime boundaries once, encode the narrow change, then let the deterministic importer repeat it.

Before accepting an adaptation, compare it directly:

```sh
git diff --no-index -- vendor/cursor-pstack/skills/interrogate/SKILL.md skills/interrogate/SKILL.md
node --test tests/content/fidelity.test.mjs
```

`git diff --no-index` returns 1 when differences exist. Inspect each changed block for lost triggers, scope, evidence, approval gates, outputs, and failure handling. The fidelity tests cover reviewed critical clauses, not arbitrary semantic equivalence. New upstream behavior still needs review when its pinned blob changes; routine regeneration does not.

## Change a Pi adaptation without moving the pin

1. Edit the matching file under `sync/replacements/`, or edit the ordered transform in `sync/manifest.json` for a small change.
2. Update `ADAPTATIONS.md` when the reason or replacement scope changes. Extend `tests/content/fidelity.test.mjs` for any new behavioral contract; do not remove a failing expectation merely to accept a shorter rewrite.
3. Review the generated diff before relocking. If active output membership changes, update the explicit `pi.skills` and `files` arrays in `package.json`.
4. Relock and regenerate:

   ```sh
   npm run sync:relock
   npm run sync
   npm run sync:check
   npm run check:content
   ```

`sync:relock` can accept reviewed adaptation bytes. It cannot accept drift in the pinned source snapshot.

## Move to a new upstream commit

1. Fetch the Cursor repository in a separate checkout. Do not replace `vendor/cursor-pstack/` by hand.
2. Compare the old and candidate commits under `pstack/`:

   ```sh
   git -C ../pstack-cursor-source diff --name-status \
     f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d..<candidate-commit> -- pstack
   ```

3. Review every changed source file against its manifest disposition:
   - `copy`: confirm the new bytes work in Pi unchanged.
   - `transform`: update `expectedBlob` and transform preimages only after reviewing the changed source.
   - `replace`: compare the new source with the reviewed Pi replacement, update `expectedBlob`, and update the replacement and `ADAPTATIONS.md` when the upstream behavior should carry over.
   - `omit`: confirm the reason still applies.
4. Add a disposition for every new upstream file and remove entries only for files deleted upstream. The importer rejects incomplete or hidden coverage.
5. Import atomically, passing the repository checkout, full commit, project root, manifest, and replacement root:

   ```sh
   node scripts/sync-upstream.mjs import \
     ../pstack-cursor-source \
     <full-candidate-commit> \
     . \
     sync/manifest.json \
     .
   ```

6. Inspect changes to `vendor/cursor-pstack/`, `sync/upstream.lock.json`, generated files, and every replacement affected by the upstream diff. If active output membership changed, update the explicit `pi.skills` and `files` arrays in `package.json`.
7. Run the cheap checks:

   ```sh
   npm run sync:check
   npm run check:content
   npm run typecheck
   ```

8. Run focused workflow tests, then follow `RELEASING.md`. Run the full suite once on the final tree.

## Failure and recovery

Sync operations use a project lock and stage writes before promotion. A failed operation rolls back managed roots. If rollback or cleanup itself fails, the tool preserves the lock and prints the manual recovery path. Do not delete an unfamiliar lock or relock around source drift. Inspect the reported state first.
