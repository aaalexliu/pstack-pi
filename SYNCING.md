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

## Change a Pi adaptation without moving the pin

1. Edit the matching file under `sync/replacements/`, or edit the ordered transform in `sync/manifest.json` for a small change.
2. Update `ADAPTATIONS.md` when the reason or replacement scope changes.
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
