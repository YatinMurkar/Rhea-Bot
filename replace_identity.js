const fs = require('fs');

let content = fs.readFileSync('index.ts', 'utf8');

const replacements = [
  // Portfolio prompts
  [/built by Yatin Murkar/g, `built by Pranjal Murkar`],
  [/You are NOT Yatin\. You are Yatin's AI creation\./g, `You are NOT Pranjal. You are Pranjal's AI creation.`],
  [/Always refer to Yatin in the THIRD PERSON: "Yatin built\.\.\.", "He worked on\.\.\.", "His project\.\.\."/g, `Always refer to Pranjal in the THIRD PERSON: "Pranjal built...", "She worked on...", "Her project..."`],
  [/NEVER say "I built" or "My project" as if you are Yatin\. You are Rhea, presenting Yatin's portfolio\./g, `NEVER say "I built" or "My project" as if you are Pranjal. You are Rhea, presenting Pranjal's portfolio.`],
  [/I was built by Yatin/g, `I was built by Pranjal`],
  [/I'm Rhea, Yatin's AI avatar/g, `I'm Rhea, Pranjal's AI avatar`],
  [/contact Yatin directly/g, `contact Pranjal directly`],
  [/knows Yatin's work inside out/g, `knows Pranjal's work inside out`],
  [/reach out to Yatin directly/g, `reach out to Pranjal directly`],
  [/send visitor details to Yatin/g, `send visitor details to Pranjal`],
  [/send chat summary to Yatin/g, `send chat summary to Pranjal`],
  
  // Morning Briefing
  [/Good Morning, Yatin!/g, `Good Morning, Pranjal!`],
  
  // System Prompts & VIP Logic
  [/Pranjal \(Yatin's Girlfriend \/ Future Wife\)/g, `Yatin (Pranjal's Boyfriend / Future Husband)`],
  [/Yatin & Pranjal \(VIP Group/g, `Pranjal & Yatin (VIP Group`],
  [/female AI avatar of Yatin/g, `female AI avatar of Pranjal`],
  [/act on behalf of Yatin/g, `act on behalf of Pranjal`],
  [/talking directly to Yatin right now/g, `talking directly to Pranjal right now`],
  [/Yatin's 3 most important people are Mamma, Pappa, and his girlfriend Pranjal\./g, `Pranjal's 3 most important people are Mamma, Pappa, and her boyfriend Yatin.`],
  [/When Yatin asks you/g, `When Pranjal asks you`],
  [/- Yatin \(Admin\/You\)/g, `- Pranjal (Admin/You)`],
  [/This is Yatin's inner VIP circle/g, `This is Pranjal's inner VIP circle`],
  [/access to Yatin's personal data/g, `access to Pranjal's personal data`],
  [/Yatin's female Virtual Assistant/g, `Pranjal's female Virtual Assistant`],
  [/talking to someone who is NOT Yatin/g, `talking to someone who is NOT Pranjal`],
  
  // Tools
  [/message or voice note to Yatin/g, `message or voice note to Pranjal`],
  [/deliver a message specifically to Yatin/g, `deliver a message specifically to Pranjal`],
  [/script to deliver to Yatin/g, `script to deliver to Pranjal`],
  
  // Comments
  [/\/\/ Yatin direct LID fallback/g, `// Pranjal direct LID fallback`],
  [/\/\/ Yatin/g, `// Pranjal`]
];

for (const [pattern, replacement] of replacements) {
  content = content.replace(pattern, replacement);
}

fs.writeFileSync('index.ts', content, 'utf8');
console.log('Replacements completed.');
