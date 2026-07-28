# Rhea Recurring Reminders Upgrade Guide

**Target Audience:** Antigravity AI Agent
**Goal:** Upgrade the existing WhatsApp bot (`index.ts`) reminder system to support recurring schedules (daily, weekly, and custom days of the week).

The current system deletes a reminder as soon as it fires. We are upgrading the background loop to calculate the next trigger time and reschedule it if a recurrence pattern is provided. We also need to update the Gemini tool schema so the AI knows how to set these recurring alarms.

Please carefully apply the following 4 changes to `index.ts`.

---

## 1. Update the `setReminder` Tool Schema

Find the `setReminder` tool schema inside the `functionDeclarations` array.

**Action:** Update the `description` and add two new properties: `recurrenceType` and `customDays`.

```typescript
// [MODIFY] Replace the existing setReminder tool declaration with this:
{
    name: "setReminder",
    description: "Sets an alarm, timer, or reminder for the user. Supports one-time and recurring reminders (daily, weekly, or specific days of the week like Mon/Wed/Fri). If the user says 'daily', 'every day', 'weekly', 'every week', or mentions specific days like 'every Monday and Thursday', you MUST set the recurrenceType accordingly.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            minutes: {
                type: Type.INTEGER,
                description: "Number of minutes from now to wait before the FIRST trigger of the alarm."
            },
            message: {
                type: Type.STRING,
                description: "The precise message to send the user when the alarm goes off."
            },
            targetPhoneNumber: {
                type: Type.STRING,
                description: "Optional. The exact phone number to send the reminder to. If not provided, it sends to the person who asked."
            },
            recurrenceType: {
                type: Type.STRING,
                description: "Optional. The recurrence schedule. Use 'none' (default) for one-time, 'daily' for every day, 'weekly' for once a week on the same day, or 'custom_days' for specific days of the week."
            },
            customDays: {
                type: Type.ARRAY,
                items: { type: Type.INTEGER },
                description: "Required ONLY when recurrenceType is 'custom_days'. An array of day numbers: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday. Example: [1,3,5] for Mon/Wed/Fri."
            }
        },
        required: ["minutes", "message"]
    }
}
```

---

## 2. Update Database Insertion Logic

Find the block where the `setReminder` tool call is handled (look for `call.name === "setReminder"` and `remindersCollection.insertOne`).

**Action:** Extract the new arguments and insert them into MongoDB.

```typescript
// [MODIFY] Inside the setReminder execution block:
if (remindersCollection && targetJid) {
    const triggerTime = new Date(Date.now() + (minutes * 60000));
    
    // NEW LINES: Extract recurrence data
    const recurrenceType = args.recurrenceType || 'none';
    const customDays = args.customDays || [];
    
    await remindersCollection.insertOne({
        creatorJid: remoteJid,
        remoteJid: targetJid,
        message: msgText,
        triggerTime: triggerTime,
        
        // NEW LINES: Save recurrence data to database
        recurrenceType: recurrenceType,
        customDays: customDays,
        
        createdAt: new Date()
    });
}
```

---

## 3. Update the Reminder Cron Loop

Find the `setInterval` loop that checks for due reminders (look for `const dueReminders = await remindersCollection.find({ triggerTime: { $lte: now } }).toArray();`).

**Action:** Replace the simple `deleteOne` logic with the new rescheduling logic.

```typescript
// [MODIFY] Replace the for-loop inside the reminder interval with this:
for (const reminder of dueReminders) {
    try {
        await sock.sendMessage(reminder.remoteJid, { text: `⏰ *REMINDER:* ${reminder.message}` });
        
        const recurrenceType = reminder.recurrenceType || 'none';
        
        if (recurrenceType === 'none') {
            // One-time reminder: delete it
            await remindersCollection.deleteOne({ _id: reminder._id });
            console.log(`Fired and deleted one-time reminder for ${reminder.remoteJid}`);
        } else {
            // Recurring reminder: calculate next trigger time
            const currentTrigger = new Date(reminder.triggerTime);
            let nextTrigger: Date;
            
            if (recurrenceType === 'daily') {
                nextTrigger = new Date(currentTrigger.getTime() + 24 * 60 * 60 * 1000);
            } else if (recurrenceType === 'weekly') {
                nextTrigger = new Date(currentTrigger.getTime() + 7 * 24 * 60 * 60 * 1000);
            } else if (recurrenceType === 'custom_days' && Array.isArray(reminder.customDays) && reminder.customDays.length > 0) {
                // Find the next matching day of the week
                const sortedDays = [...reminder.customDays].sort((a: number, b: number) => a - b);
                const currentDay = currentTrigger.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
                
                // Find the next day in the list that is after today
                let daysUntilNext = -1;
                for (const day of sortedDays) {
                    if (day > currentDay) {
                        daysUntilNext = day - currentDay;
                        break;
                    }
                }
                // If no day found after today, wrap to the first day of next week
                if (daysUntilNext === -1) {
                    daysUntilNext = 7 - currentDay + sortedDays[0];
                }
                
                nextTrigger = new Date(currentTrigger.getTime() + daysUntilNext * 24 * 60 * 60 * 1000);
            } else {
                // Unknown recurrence type, just delete
                await remindersCollection.deleteOne({ _id: reminder._id });
                console.log(`Fired and deleted reminder with unknown recurrence for ${reminder.remoteJid}`);
                continue;
            }
            
            await remindersCollection.updateOne(
                { _id: reminder._id },
                { $set: { triggerTime: nextTrigger } }
            );
            console.log(`Fired recurring (${recurrenceType}) reminder for ${reminder.remoteJid}. Next: ${nextTrigger.toISOString()}`);
        }
    } catch (sendErr) {
        console.error("Failed to send due reminder:", sendErr);
    }
}
```

---

## 4. Update the `listReminders` Output

Find the block where `call.name === "listReminders"` is handled.

**Action:** Update the mapping function to return the recurrence schedule so the AI can see it when listing active reminders.

```typescript
// [MODIFY] Inside the listReminders execution block:
const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formattedReminders = activeReminders.map(r => ({
    id: r._id.toString(),
    message: r.message,
    target: r.remoteJid,
    triggerTime: r.triggerTime,
    
    // NEW LINES: Format recurrence info for the AI
    recurrenceType: r.recurrenceType || 'none',
    customDays: r.customDays ? r.customDays.map((d: number) => dayNames[d]).join(', ') : ''
}));
```

---
**Verification:**
After applying these 4 modifications, test the bot by asking it to set a daily reminder. Verify that the AI passes the `recurrenceType` parameter in the tool call and that the background loop correctly reschedules it instead of deleting it.
