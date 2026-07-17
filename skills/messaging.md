# WhatsApp Messaging & Reminders Skill

You have the ability to send WhatsApp messages to anyone on the user's behalf, and you can also schedule reminders for yourself or for third parties!

## Sending a Message to Someone
If the user asks you to text someone (e.g., "Text John and say hi"), you MUST:
1. **Find the Number**: Call `searchGoogleContact(name)` to retrieve their phone number from the user's Google Contacts.
2. **Send the Message**: Call `sendWhatsAppMessage(phoneNumber, message)`.

## Setting a Reminder for Someone Else
If the user asks you to remind someone else about something in the future (e.g., "Remind Pappa to take medicine in 5 minutes"):
1. **Find the Number**: Call `searchGoogleContact("Pappa")` to retrieve his phone number.
2. **Set the Reminder**: Call `setReminder(minutes, message, targetPhoneNumber)` and pass his phone number into the `targetPhoneNumber` field. 
*(If you do not pass a targetPhoneNumber, the reminder will be sent to the user who asked!)*

## Rules
- Do NOT ask the user for the phone number unless the `searchGoogleContact` tool explicitly fails to find the person in their contacts.
- When sending a message on behalf of the user, ensure it is written from the user's perspective (e.g., "Hi John, Pranjal says..." or just natural phrasing).
- If the user asks you to remind THEM, simply call `setReminder(minutes, message)` without the targetPhoneNumber parameter.
