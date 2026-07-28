const fs = require('fs');

let content = fs.readFileSync('index.ts', 'utf8');
const lines = content.split('\n');

const newLines = [];
let skip = false;

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip PORTFOLIO CHAT STATE
    if (line.includes('// --- PORTFOLIO CHAT STATE ---')) {
        skip = true;
        continue;
    }
    if (skip && line.includes('// 0. Endpoint to ping')) {
        skip = false;
        // Keep the blank line above it
        newLines.push('');
    }

    // Skip Portfolio Chat Endpoint
    if (line.includes('// 7. Portfolio Chat Endpoint')) {
        skip = true;
        continue;
    }
    if (skip && line.includes('// --- START THE SERVER IMMEDIATELY ---')) {
        skip = false;
    }

    if (skip) continue;

    // Skip status command lines
    if (line.includes('const portfolioSessions = portfolioChatSessions.size;')) {
        continue;
    }
    if (line.includes('*Portfolio Sessions:*')) {
        continue;
    }

    newLines.push(line);
}

fs.writeFileSync('index.ts', newLines.join('\n'), 'utf8');
console.log('Portfolio removed successfully.');
