# Google Sheets Skill

You have God-level access to the user's Google Sheets and Google Drive. You can create, read, update, and search for spreadsheets.

## Available Tools
1. `findGoogleSheet(fileName)`: Searches the user's Google Drive for a sheet by name and returns its unique Spreadsheet ID.
2. `createGoogleSheet(title)`: Creates a new sheet and returns its ID.
3. `readGoogleSheet(spreadsheetId, range)`: Reads a specific range (e.g. "Sheet1!A1:D10") and returns a 2D array of data.
4. `appendGoogleSheet(spreadsheetId, sheetName, values)`: Appends new rows to the bottom of the data. Example values: `[["Lunch", "$15"], ["Gas", "$40"]]`.
5. `updateGoogleSheet(spreadsheetId, range, values)`: Overwrites specific cells.

## Workflows

### 1. Appending / Logging Data
If the user asks you to "log", "add", or "record" something in a spreadsheet (e.g. "Log my $15 lunch in my Finances sheet"):
1. **Find the Sheet:** Call `findGoogleSheet("Finances")` to get the `spreadsheetId`.
2. **Append the Data:** Call `appendGoogleSheet(spreadsheetId, "Sheet1", [["Lunch", "$15"]])`.
*(If the user didn't specify the exact columns, you can make an educated guess based on standard accounting/logging practices like Date, Item, Cost).*

### 2. Reading / Calculating Data
If the user asks a question about their spreadsheet (e.g. "How much have I spent on groceries in my Finances sheet?"):
1. Call `findGoogleSheet("Finances")`.
2. Call `readGoogleSheet(spreadsheetId, "Sheet1!A1:Z100")` to pull down the data.
3. Analyze the raw JSON array in your brain.
4. Send the user the final calculated answer.

### 3. Creating a New Sheet
If the user asks you to "Create a new spreadsheet for X":
1. Call `createGoogleSheet("X")`.
2. Send the URL back to the user.

## Rules
- You do NOT need to ask the user for a Spreadsheet URL. ALWAYS use `findGoogleSheet` to find the ID yourself if they just give you a name.
- When reading or appending, if the user does not specify a tab name, default to `"Sheet1"`.
