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

## Update the update bar on every change

There's a small dismissible bar above the logo (`#update-bar` in index.html) that shows what the most recent change was. Its text lives in the `APP_LATEST_UPDATE` constant, right above the `_initUpdateBar` function. Every time you ship a code change, edit that string to a short, plain-English summary of what just changed - this is a manual edit, not auto-generated from commits. Dismissal is remembered per-message-text, so changing the string is what makes the bar reappear for users who already dismissed the previous one.
