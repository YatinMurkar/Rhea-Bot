import axios from "axios";

export interface GenerateVoiceNoteOptions {
    text: string;
    /**
     * Google Cloud TTS Voice Name.
     * Examples: 'en-US-Journey-D' (Male), 'en-US-Journey-F' (Female, softer)
     */
    voiceName?: string;
    languageCode?: string;
    audioEncoding?: "OGG_OPUS" | "MP3";
}

/**
 * Generates an OGG_OPUS audio buffer directly from Google Cloud TTS using Axios.
 * This completely avoids the memory overhead of the massive Google Cloud SDK.
 */
export async function generateVoiceNote(options: GenerateVoiceNoteOptions): Promise<Buffer> {
    const apiKey = process.env.GOOGLE_TTS_API_KEY;
    if (!apiKey) {
        throw new Error("GOOGLE_TTS_API_KEY environment variable is not set.");
    }

    const url = `https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=${apiKey}`;

    const payload = {
        input: { text: options.text },
        voice: {
            languageCode: options.languageCode || "ar-XA",
            name: options.voiceName || "ar-XA-Chirp3-HD-Kore" // Default to female Chirp3 HD
        },
        audioConfig: {
            audioEncoding: options.audioEncoding || "OGG_OPUS" 
        }
    };

    try {
        const response = await axios.post(url, payload, {
            headers: {
                "Content-Type": "application/json; charset=utf-8"
            }
        });

        // Google returns base64 encoded audio content
        const base64Audio = response.data.audioContent;
        return Buffer.from(base64Audio, "base64");
    } catch (error: any) {
        console.error("Google Cloud TTS Error:", error.response?.data || error.message);
        throw new Error("Failed to generate voice note.");
    }
}
