# Repository publication readiness

Reviewed October 6, 2026 for the explicitly requested Claude handoff. The separate private repository is [KareemAl1/alibi](https://github.com/KareemAl1/alibi), configured as `origin`, with continuation branch `codex/alibi`. A public playtest URL does **not** require public source code: Render can read an authorized private GitHub repository. The game has not been deployed.

GitHub's authenticated user endpoint returned **KareemAl1** again on October 6. No credentials were changed or printed. Recheck before a later push if the signed-in account might have changed.

## What belongs in the repository

Keep the application source, local artwork, tests, documentation, `.node-version`, `render.yaml`, `package.json`, and `package-lock.json`. Keep `package.json` marked `private`; this prevents accidental npm publication and does not prevent GitHub or Render use. `.env.example` contains sample configuration only. The application does not load `.env` files automatically; set runtime variables in the shell or hosting platform.

The repository's `.gitignore` excludes dependencies, runtime environment files, npm credentials/configuration, common private-key files, logs, process IDs, browser/test output, coverage, and local editor/OS files. `.env.example` is explicitly allowed. Screenshots and reports under `artifacts/` remain local; reports, logs, and browser state can contain private game data.

Ignoring a path does not remove it from existing Git history. Always review staged paths before the first push; do not use `git add -f` for excluded files.

## Audit evidence and limits

The October 6 pre-push audit inspected 28 tracked paths and all four pre-handoff commits (110 text-file snapshots). It found no tracked runtime-secret or local-output paths, and no matches for the credential patterns checked: common cloud access keys, GitHub tokens, private-key headers, service tokens, Slack tokens, embedded URL credentials, JWTs and literal secret assignments. The working directory's existing ignored files were confined to dependencies and `artifacts/`. Representative environment, key, log, profile, and test-output paths were confirmed ignored; `.env.example` remains publishable. The earlier September 30 audit covered 26 tracked paths and three commits.

This was a targeted local scan, not a guarantee that arbitrary secrets cannot exist. Generated binary artwork was not scanned as text. Credential stores and GitHub token values were neither read nor copied into project files. Repeat the staged-change review after further edits, and review GitHub's secret-scanning results if available for the chosen repository.

## Before subsequent pushes or deployment

1. Confirm the active GitHub account through `gh api user --jq .login`; it must return `KareemAl1`. Authentication status is checked separately from this file. Do not paste access tokens into chat or project configuration.
2. Keep `KareemAl1/alibi` private unless the user explicitly requests a visibility change. Private source is sufficient for the friend playtest. No open-source license has been selected.
3. Run the tests, review `git status --short` and `git diff --cached --stat`, and commit the intended files. Confirm excluded local artifacts are absent from the staged set.
4. Push the intended work to `origin` on `codex/alibi`; do not force-push unrelated history. Link any later Render service to the exact tested branch.
5. Follow [DEPLOYMENT.md](DEPLOYMENT.md) only after the user's hosting decision and approval of account access and estimated cost. Private GitHub publication and a paid Render deployment are separate actions; hosting is still unperformed.

The [future mobile plan](FUTURE-MOBILE.md) remains architectural guidance for later work; publication needs no mobile project, app-store account, or mobile credentials.
