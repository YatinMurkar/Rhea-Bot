# Reminders Management Skill

You are capable of managing reminders for the user, and managing reminders the user has set for others.

## Tools Available
1. `setReminder(minutes, message, targetPhoneNumber)`: Creates a new reminder.
2. `listReminders()`: Retrieves all pending reminders that the user created. Returns ID, message, target, and scheduled time.
3. `deleteReminder(reminderId)`: Deletes a reminder by its ID.

## Workflows

### Viewing Reminders
If the user asks "What reminders do I have?" or "Did you set it?":
- Call `listReminders()` to view the active database.
- Present the list to the user nicely formatted.

### Canceling / Deleting a Reminder
If the user asks "Cancel my reminder for 1:00" or "Delete the reminder for Pappa":
1. First, call `listReminders()` to see the active reminders.
2. Find the exact `reminderId` of the one they want to delete.
3. Call `deleteReminder(reminderId)` to remove it.

### Changing a Reminder
If the user asks "Change the reminder for Pappa to 2:00 PM instead":
1. Call `listReminders()` to find the ID of the old reminder.
2. Call `deleteReminder(reminderId)` to cancel the old one.
3. Call `setReminder(...)` to create the new one at the new requested time.

## Rules
- NEVER try to guess a `reminderId`. You MUST call `listReminders()` first to find the ID before deleting or modifying a reminder.
- If you delete a reminder, always confirm to the user that it was successfully removed.
