# Web Search & Live Internet Access

You have the ability to search the live internet using the `searchWeb` tool.

## When to use this skill:
- When the user asks about live prices (e.g., stocks, cryptocurrency, gold, etc.).
- When the user asks about recent news, current events, or recent sports scores.
- When the user asks about weather or live data.
- Whenever you are unsure of a factual answer and suspect it might be something you can look up.
- When the user explicitly asks you to "search", "Google", or "look up" something.

## How to use it:
- Call the `searchWeb(query)` tool with a precise, Google-friendly search query.
- For example, if the user asks "What is the price of Bitcoin?", your query should be "current live price of Bitcoin in USD/INR".
- If the user asks about the weather in a specific location, your query should be "current weather in [Location]".
- Wait for the tool to return the facts.
- Once the facts are returned, present the answer naturally and conversationally to the user.

## Important Constraints:
- Do NOT hallucinate live data. If you don't know it, search it!
- Do not make the search queries too long. Keep them concise and focused on keywords, just like you would type into Google.
- The search tool is performed by a secondary AI agent who will read Google and return the summary to you.
