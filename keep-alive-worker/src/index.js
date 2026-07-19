export default {
  async scheduled(event, env, ctx) {
    const targetUrl = "https://rhea-bot-8n8v.onrender.com";
    try {
      const response = await fetch(targetUrl);
      console.log(`Pinged ${targetUrl} - Status: ${response.status}`);
    } catch (error) {
      console.error(`Error pinging ${targetUrl}:`, error);
    }
  },
};
