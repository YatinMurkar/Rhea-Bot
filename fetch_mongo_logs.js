const { MongoClient } = require('mongodb');
const uri = "mongodb+srv://whatsappbot:He4h8VWjDIX6NbpK@cluster0.mltus6w.mongodb.net/whatsapp_bot?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    const db = client.db('whatsapp_bot');
    const chatHistory = db.collection('chat_history');
    const docs = await chatHistory.find({}).sort({ timestamp: -1 }).limit(10).toArray();
    console.log("LAST 10 MESSAGES:");
    for (const d of docs.reverse()) {
        console.log(`[${new Date(d.timestamp).toISOString()}] ${d.role} (${d.remoteJid}): ${d.content}`);
    }
  } finally {
    await client.close();
  }
}

run().catch(console.dir);
