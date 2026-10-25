# GitHub board setup (done by the user, one time)

Everything stays inside the repo: the `gh` binary goes in `.tools/` and its login in `.gh-config/`. Both are gitignored and removed by `scripts/nuke.sh`. Always run gh through `./scripts/gh.sh`.

## 1. Download the GitHub CLI into the repo (no brew)
1. Open https://github.com/cli/cli/releases/latest and download **`gh_<version>_macOS_arm64.zip`**.
2. Unzip it and move the folder so the binary is at `.tools/gh/bin/gh`:
   ```bash
   cd /Users/karanupadhyay/WorkSpace/AQspace
   mkdir -p .tools
   unzip ~/Downloads/gh_*_macOS_arm64.zip -d .tools
   mv .tools/gh_*_macOS_arm64 .tools/gh
   ./scripts/gh.sh --version
   ```
   If macOS blocks it ("cannot be opened"), run `xattr -d com.apple.quarantine .tools/gh/bin/gh`.

## 2. Log in (stored in .gh-config/, not your home folder)
```bash
./scripts/gh.sh auth login -h github.com -p https -w -s project,repo,read:org
```
Choose **Login with a web browser** and enter the code it shows.

## 3. Create the board
```bash
./scripts/gh.sh project create --owner secretJod --title "AQspace Board"
./scripts/gh.sh project list --owner secretJod        # note the project NUMBER
./scripts/gh.sh project link <NUMBER> --owner secretJod --repo secretJod/AqSpace
```
Then in the browser (github.com/users/secretJod/projects/<NUMBER>), change the **Status** field options to:
`Backlog, Todo, In Progress, In Review, QA, Done`.

## 4. Tell Claude "GitHub is connected, project number N"
Claude will then:
- create the labels (`role:*`, `type:*`, `priority:*`),
- move the cards from `docs/BOARD.md` into issues on the board,
- save the project number in `.claude/rules/team.md` so every agent uses it.
