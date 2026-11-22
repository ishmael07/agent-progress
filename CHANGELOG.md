# Changelog

## 1.1.1

- **Cleaner rows.** Each running agent's step now sits on its own line under its bar ("Step 3 of 5", then the step), so nothing is crammed onto one line.

## 1.1.0

- **Cleaner look.** A table built from simple two-line cards, with each agent's step and time on one line.
- **Better time left.** "Time left" shows after an agent finishes its first step, and counts down at the agent's own pace. Before that you see how long it has been running.
- **Earlier agents fold away.** Finished agents from earlier batches collapse under "Earlier" in the table.
- **Done notice.** A short notice when all agents in a batch finish, plus an optional system notification.
- **Settings.** Turn the step lists, the Haiku summaries, the bars above the prompt and the notification on or off in `/config`.
- **Click the summary line** above the prompt to open the table.
- **`/progress` works mid-reply.** It runs the moment you type it, even while Claude is busy, and shows the live bars right in the chat as well as opening the table.
- **On/off switch.** `/progress off` stops the bars from popping up on their own (remembered across sessions); `/progress on` or `/progress toggle` brings them back.
- **Timestamps.** Finished agents show when they finished, an open row shows when it started and finished, and "Earlier" groups past batches under the time they ran.
- **Labels.** Every bar says which agent it is: its name or kind (like Explore), else Agent 1, Agent 2… in the order they started.
- **Matches your terminal.** The table sits on your terminal's own background, so it follows your theme.

## 1.0.0

- First release: a live bar for each agent above the prompt, the `/progress` table, plain-language steps, click-to-open details, and `/progress explain`.
