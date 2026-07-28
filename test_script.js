const url = "https://script.google.com/macros/s/AKfycbyDXes8zx05BOfguQXG3TKrVxwOJthXBYEHU5-lqzCDzrrMws2f_FCwXeDfEZFXTfyENQ/exec";

async function test() {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: "ping" }),
            redirect: 'follow'
        });
        
        const text = await res.text();
        console.log("Status:", res.status);
        console.log("Response text start:", text.substring(0, 100));
        
        try {
            const json = JSON.parse(text);
            console.log("Valid JSON parsed!");
        } catch(e) {
            console.log("Failed to parse JSON (Probably HTML returned).");
        }
    } catch (e) {
        console.error("Error:", e);
    }
}
test();
