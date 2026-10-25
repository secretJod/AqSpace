# Repo-local storage

Everything this app creates must live inside this repo, so deleting the folder frees all space with no residue elsewhere.

- Never add named Docker volumes; bind-mount under `./.data/` (Postgres is at `./.data/pgdata`).
- No global installs (`npm i -g`, brew, pip --user). Install into the repo; npm cache is `.npm-cache/` via `.npmrc`.
- Any new data, cache, or state dir goes under a gitignored repo path and must be cleaned by `scripts/nuke.sh`.
- `.env` is not on GitHub; warn before any deletion of the repo.
- Don't write to Claude's global memory or `~/.claude`; project context belongs in this `.claude/` folder.
