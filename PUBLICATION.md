# Repository publication readiness

Reviewed September 30, 2026. No repository has been created or pushed by this preparation. A public playtest URL does **not** require public source code: Render can read an authorized private GitHub repository.

GitHub's authenticated user endpoint returned **KareemAl1** during this preparation. This was a read-only identity check; no credentials were changed or printed. Recheck before a later publication if the signed-in account might have changed.

## What belongs in the repository

Keep the application source, local artwork, tests, documentation, `.node-version`, `render.yaml`, `package.json`, and `package-lock.json`. Keep `package.json` marked `private`; this prevents accidental npm publication and does not prevent GitHub or Render use. `.env.example` contains sample configuration only. The application does not load `.env` files automatically; set runtime variables in the shell or hosting platform.

The repository's `.gitignore` excludes dependencies, runtime environment files, npm credentials/configuration, common private-key files, logs, process IDs, browser/test output, coverage, and local editor/OS files. `.env.example` is explicitly allowed. Screenshots and reports under `artifacts/` remain local; reports, logs, and browser state can contain private game data.

Ignoring a path does not remove it from existing Git history. Always review staged paths before the first push; do not use `git add -f` for excluded files.

## Audit evidence and limits

The initial publication audit inspected all 26 tracked paths and all three existing commits (56 text-file versions). It found no tracked runtime-secret or local-output paths, and no matches for the credential patterns checked: common cloud access keys, GitHub tokens, private-key headers, service tokens, Slack tokens, embedded URL credentials, and literal secret assignments. The working directory's existing ignored files were confined to dependencies and `artifacts/`. Representative environment, key, log, profile, and test-output paths were confirmed ignored; `.env.example` remains publishable.

This was a targeted local scan, not a guarantee that arbitrary secrets cannot exist. Generated binary artwork was not scanned as text. Credential stores and GitHub token values were neither read nor copied into project files. Repeat the staged-change review after further edits, and review GitHub's secret-scanning results if available for the chosen repository.

## When publication is authorized

1. Confirm the active GitHub account through `gh api user --jq .login`; it must return `KareemAl1`. Authentication status is checked separately from this file. Do not paste access tokens into chat or project configuration.
2. Choose the repository name and visibility. Private source is sufficient for the friend playtest. Choosing a public repository does not automatically grant an open-source license; select a license separately if that is intended.
3. Run the tests, review `git status --short` and `git diff --cached --stat`, and commit the intended files. Confirm excluded local artifacts are absent from the staged set.
4. Create/link the repository and push only after publication is authorized. Link Render to the exact tested branch; the local milestone branch is `codex/alibi`, which need not be the eventual default branch.
5. Follow [DEPLOYMENT.md](DEPLOYMENT.md) after approving the hosting account access and estimated cost. GitHub publication and a paid Render deployment are separate actions. Neither has been performed by this preparation.

The [future mobile plan](FUTURE-MOBILE.md) remains architectural guidance for later work; publication needs no mobile project, app-store account, or mobile credentials.
