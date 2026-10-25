# QA plan: card #N - <feature name>

Copy this file to `docs/qa/<N>-<short-name>.md` and fill it in.

- **Card:** https://github.com/secretJod/AqSpace/issues/N
- **PR:** <link>
- **Tester:** <your name>
- **Date:** YYYY-MM-DD
- **Tested on:** <computer + browser, phone + browser>

## Before you start
- [ ] <setup step, e.g. Docker Desktop is running>

## Steps

Mark exactly one box per step. If it fails, fill in "What I saw".

### 1. <short name>
**Do:** <what to click or type>
**Expect:** <what you should see>
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 2. <short name>
**Do:**
**Expect:**
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

(Cover: the happy path, edge cases, mobile, and errors such as a missing key or no network.)

## Result
- Steps passed: __ / __
- [ ] **PASS** -> `QA_APPROVED=1 scripts/board.sh move N Done`
- [ ] **FAIL** -> bug comment on the card, then `scripts/board.sh move N "In Progress"`

---

## Bug report format (paste into a card comment)

```
**Bug:** <one line, e.g. "PDF button does nothing on iPhone">
**Plan step:** <e.g. step 9 in docs/qa/1-docker-tunnel.md>
**Where:** <device, browser, localhost or tunnel link>

**Steps to reproduce**
1.
2.
3.

**Expected:** <what should happen>
**Actual:** <what happened, error text copied word for word>
**How often:** always / sometimes (x out of y tries)
**Screenshot / logs:** <attach image; paste relevant lines of `docker compose logs`>
```

Remember: no API keys in screenshots or logs.
