// ============================================
// DESPERTAR ID™ — Módulo ElevenLabs + Mezcla binaural
// Convierte el guion a voz y lo mezcla con ondas binaurales
// ============================================

import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFile, unlink, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';
const BINAURAL_PATH      = join(__dirname, 'binaural.mp3');

/**
 * Convierte un guion a audio MP3 y lo mezcla con las ondas binaurales.
 * La voz suena clara encima de las ondas al 10% de volumen.
 * El resultado tiene la misma duración que la hipnosis.
 * @param {string} script
 * @returns {Buffer} MP3 final mezclado
 */
export async function generateHypnosisAudio(script) {
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    throw new Error('Faltan ELEVENLABS_API_KEY o ELEVENLABS_VOICE_ID en las variables de entorno.');
  }

  const chunks       = splitScript(script, 4500);
  const audioBuffers = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`  [ElevenLabs] Procesando fragmento ${i + 1}/${chunks.length}...`);
    const buffer = await convertChunkToAudio(chunks[i], voiceId, apiKey);
    audioBuffers.push(buffer);
  }

  const voiceBuffer = Buffer.concat(audioBuffers);
  console.log('  [ffmpeg] Mezclando voz con ondas binaurales...');
  const mixedBuffer = await mixWithBinaural(voiceBuffer);
  return mixedBuffer;
}

/**
 * Mezcla el audio de voz con binaural.mp3.
 * - Voz a volumen completo (1.0)
 * - Binaural al 10% (0.1), recortado a la duración de la voz
 */
function mixWithBinaural(voiceBuffer) {
  return new Promise(async (resolve, reject) => {
    const id        = randomUUID();
    const voicePath = join(tmpdir(), `voice-${id}.mp3`);
    const outPath   = join(tmpdir(), `mixed-${id}.mp3`);

    try {
      await writeFile(voicePath, voiceBuffer);

      ffmpeg()
        .input(voicePath)
        .input(BINAURAL_PATH)
        .complexFilter([
          // Ajustar volumen de la voz (sin cambio) y el binaural al 10%
          '[0:a]volume=1.0[voice]',
          '[1:a]volume=0.1[binaural]',
          // Mezclar ambos; duración = la más corta (la voz manda)
          '[voice][binaural]amix=inputs=2:duration=shortest[out]'
        ])
        .outputOptions(['-map [out]', '-c:a libmp3lame', '-q:a 2'])
        .output(outPath)
        .on('end', async () => {
          try {
            const result = await readFile(outPath);
            resolve(result);
          } catch (e) {
            reject(e);
          } finally {
            unlink(voicePath).catch(() => {});
            unlink(outPath).catch(() => {});
          }
        })
        .on('error', async (err) => {
          unlink(voicePath).catch(() => {});
          unlink(outPath).catch(() => {});
          reject(err);
        })
        .run();
    } catch (err) {
      unlink(voicePath).catch(() => {});
      reject(err);
    }
  });
}

/**
 * Convierte un fragmento de texto a audio con ElevenLabs
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
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.75,
        similarity_boost: 0.85,
        style: 0.20,
        use_speaker_boost: true,
        speed: 0.70
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

  const chunks    = [];
  let   current   = '';
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
