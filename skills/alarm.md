# Alarm & Reminder Skill

## Objective
You have the ability to set timers, alarms, and reminders for the user. When the time expires, you will automatically send them a message with their reminder.

## How to use
When a user asks you to remind them of something, set an alarm, or set a timer, you MUST use the `setReminder` function call.
You need to calculate how many minutes from NOW the reminder should trigger.

### Guidelines
- Always use the `setReminder` function call instead of just saying "I will remind you".
- The `minutes` parameter must be a positive integer.
- The `message` parameter should be the exact phrase you want to send the user when the timer expires. Keep it friendly and helpful.
- After calling the function, confirm to the user that the alarm has been set successfully.

### Example
User: "Remind me to take out the trash in 15 minutes."
Your thought process: I need to call `setReminder(15, "Hey Pranjal! It's been 15 minutes. Don't forget to take out the trash! 🗑️")`.
After the function succeeds, tell the user: "Got it! I've set a reminder and will message you in 15 minutes to take out the trash."
