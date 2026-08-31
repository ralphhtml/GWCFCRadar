# GWCFCRadar Project

## Always include at the end of every message

End every response with the live site link on its own line:

🌐 **Live site:** https://ralphhtml.github.io/GWCFCRadar/

## Teaching mode - explain every change

The user wants to learn coding through this project. After every code change, explain:

1. **What** was changed (which file, which part)
2. **Why** it was needed (what problem it solves)
3. **How** it works (the key concept in plain English - no assumed knowledge)

Keep explanations concise but clear. Use analogies where helpful. Treat it like teaching a smart person who is new to code, not like writing docs for a developer.

## No em dashes, ever

Never use the em dash character (Unicode U+2014) anywhere in this repo: not in UI text, popups, code comments, commit messages, or any file. Use a regular hyphen (-), a comma, a colon, or split into two sentences instead.

## Add a changelog entry on every change

The old update bar is gone. The site now has a changelog modal: the `APP_CHANGELOG` array in index.html (right above the `_clMarkSeen` function). Every time you ship a code change, add a NEW entry at the TOP of that array (newest first), shaped like the ones already there:

- `id`: a stable unique string, `'YYYY-MM-DD-x'` where x is a letter that increments within the day (a, b, c...)
- `date`: the human date, like `'Aug 31, 2026'`
- `text`: a short, plain-English summary of what just changed - written by hand, not generated from commits

The modal opens itself once for returning visitors whenever the newest id is one they have not seen, and the full history is always available from the Updates button in the account panel. Never edit or reuse an old entry's id: the "have you seen this" check compares the newest id to the one saved in localStorage, so a fresh id is what makes the modal appear.
