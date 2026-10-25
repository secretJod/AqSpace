# How QA works on AQspace

You are the QA tester. Developers build a feature, then move its card to the **QA** column. Your job is to try it like a real user and decide whether it is good enough. You are the only person who can move a card to **Done**.

The board is GitHub Project #2 ("AQspace Board"). Each card is a GitHub issue.

## The loop, step by step

1. **Pick a card.** List the board and look for cards in the **QA** column:
   ```bash
   scripts/board.sh list
   ```
   Open the card (`scripts/gh.sh issue view N --repo secretJod/AqSpace`) and read its "How to test" section and the linked PR.

2. **Find the test plan.** Every card in QA should have a plan at `docs/qa/<card number>-<short-name>.md` (example: `docs/qa/1-docker-tunnel.md`). If there is none, ask the qa-guide agent to write one, or copy `docs/qa/TEMPLATE.md` and fill it in yourself.

3. **Follow the plan in order.** Each step says what to do and what you should see. Tick `[x] Pass` or `[x] Fail`. If something is a fail, write down what you actually saw and take a screenshot. Don't skip steps; if a step can't be done (for example, you have no phone handy), mark it **Blocked** and say why.

4. **Record the result on the card.** Post a comment with a short summary:
   ```bash
   scripts/gh.sh issue comment N --repo secretJod/AqSpace --body "QA result: PASS (12/12 steps). Tested on macOS + iPhone Safari."
   ```

5. **Move the card.**
   - **Everything passed** -> move it to Done:
     ```bash
     QA_APPROVED=1 scripts/board.sh move N Done
     ```
     (The `QA_APPROVED=1` part is your signature. Agents are not allowed to use it.)
   - **Something failed** -> post a bug comment (use the bug report format in `TEMPLATE.md`), then send it back:
     ```bash
     scripts/board.sh move N "In Progress"
     ```
     The card's owner fixes it and moves it back to QA. Then you test again, starting from the top of the plan.

## Tips for a beginner tester

- **Pass means "works as the plan says", not "works most of the time".** If it failed once, write it down, even if it worked when you tried again.
- **One bug per comment.** It makes fixing and re-testing easier.
- **Say exactly what you did.** "Clicked Import, pasted this link: ..." beats "import is broken".
- **Copy error text word for word**, from the screen or from `docker compose logs`.
- **Never paste API keys** (Groq key, Google secrets) into a comment or screenshot. Blur them.
- Not sure if something is a bug? Write it down as a "question" in your comment. The owner can decide.

## Files here

| File | What |
|---|---|
| `README.md` | This guide |
| `TEMPLATE.md` | Blank test plan + bug report format to copy |
| `1-docker-tunnel.md` | Plan for card #1: Docker one-command start + Cloudflare tunnel |
