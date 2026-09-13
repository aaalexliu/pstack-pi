# Git release procedure

This package ships through Git only. Do not publish it to npm.

## Release gate

1. Start from a clean `main` that matches `origin/main`.
2. Install the locked development dependencies with `npm ci`.
3. Run the cheap gates while editing:

   ```sh
   npm run typecheck
   npm run sync:check
   npm run check:content
   ```

4. Run focused tests for each changed subsystem. Do not rerun the full process-cleanup suite after every prose or manifest edit.
5. Run `npm run check` once against the final tree. This is the release gate. It includes the slower real-process cleanup and packed real-Pi tests.
6. Check the exact package contents:

   ```sh
   npm pack --dry-run --json --ignore-scripts
   git diff --check
   git status --short
   ```

7. Push `main`, then record its full commit:

   ```sh
   git push origin main
   git rev-parse HEAD
   ```

The tested commit is the release identity. A failed gate does not produce a release.

## Install the tested commit

Replace `<full-commit-sha>` with the 40-character commit from the release gate:

```sh
pi install git:github.com/aaalexliu/pstack-pi@<full-commit-sha>
pi list
```

A pinned Git ref does not advance during `pi update --extensions`. Install the new commit explicitly when upgrading:

```sh
pi install git:github.com/aaalexliu/pstack-pi@<new-full-commit-sha>
```

Remove it with:

```sh
pi remove git:github.com/aaalexliu/pstack-pi
```

## Tags and GitHub releases

Do not create a tag or GitHub release as part of routine delivery. Both are separate release actions and need explicit user confirmation. If confirmed, tag only the commit that passed the release gate. Do not move or replace a published tag.

Do not add npm publishing metadata, lifecycle scripts, generated changelog entries, or release automation that can publish without an explicit action.
