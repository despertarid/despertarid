// ============================================
// DESPERTAR ID™ — Módulo ElevenLabs
// Convierte el guion de hipnosis a audio MP3
// ============================================

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

/**
 * Convierte un guion de texto a audio MP3 usando ElevenLabs.
 * @param {string} script - El guion completo generado por Claude
 * @returns {Buffer} - Buffer del archivo MP3
 */
export async function generateHypnosisAudio(script) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID; // Tu voz personalizada

  if (!apiKey || !voiceId) {
    throw new Error('Faltan ELEVENLABS_API_KEY o ELEVENLABS_VOICE_ID en las variables de entorno.');
  }

  // ElevenLabs tiene límite de ~5000 caracteres por request
  // Si el guion es largo, lo dividimos en fragmentos
  const chunks = splitScript(script, 4500);
  const audioBuffers = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`  [ElevenLabs] Procesando fragmento ${i + 1}/${chunks.length}...`);
    const buffer = await convertChunkToAudio(chunks[i], voiceId, apiKey);
    audioBuffers.push(buffer);
  }

  // Concatenar todos los fragmentos en un solo MP3
  return Buffer.concat(audioBuffers);
}

/**
 * Convierte un fragmento de texto a audio
 */
async function convertChunkToAudio(text, voiceId, apiKey) {
  const response = await fetch(`${ELEVENLABS_API_URL}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2', // Mejor calidad para español
      voice_settings: {
        stability: 0.75,        // Más alto = voz más consistente y calmada
        similarity_boost: 0.85, // Más alto = más parecida a tu voz original
        style: 0.20,            // Expresividad moderada para hipnosis
        use_speaker_boost: true
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs error ${response.status}: ${error}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Divide el guion en fragmentos respetando oraciones completas
 */
function splitScript(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let current = '';
  const sentences = text.split(/(?<=[.!?])\s+/);

  for (const sentence of sentences) {
    if ((current + sentence).length > maxLength) {
      if (current) chunks.push(current.trim());
      current = sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }

  if (current) chunks.push(current.trim());
  return chunks;
}
