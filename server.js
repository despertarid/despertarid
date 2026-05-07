// ============================================
// DESPERTAR ID™ — Backend Principal
// Stack: Node.js + Express
// Servicios: Anthropic AI + ElevenLabs + PayPal + Resend
// ============================================

import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { generateHypnosisAudio } from './hypnosis.js';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Clientes de servicios ───────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 });

const resendApiKey = process.env.RESEND_API_KEY || 'missing_key';
if (!process.env.RESEND_API_KEY) {
  console.warn('ADVERTENCIA: Falta RESEND_API_KEY — el envío de emails fallará.');
}
const resend = new Resend(resendApiKey);

const s3Client = (() => {
  const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_REGION: region } = process.env;
  if (!accessKeyId || !secretAccessKey || !region) return null;
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
})();

// ─── Middleware ──────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Frontend ────────────────────────────────
app.get('/',               (req, res) => res.sendFile(join(__dirname, 'index.html')));
app.get('/gracias',        (req, res) => res.sendFile(join(__dirname, 'index.html')));
app.get('/en',             (req, res) => res.sendFile(join(__dirname, 'index-en.html')));
app.get('/en/gracias',     (req, res) => res.sendFile(join(__dirname, 'index-en.html')));
app.get('/en/cancelado',   (req, res) => res.sendFile(join(__dirname, 'index-en.html')));
app.get('/audio/:filename', (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
  res.sendFile(join(__dirname, 'audio', filename));
});
app.get('/cancelado',      (req, res) => res.sendFile(join(__dirname, 'index.html')));

// ─── Almacenamiento temporal de órdenes ─────
// En producción: reemplazar con Firebase o Supabase
const orders = new Map();

const FIELD_LIMITS = {
  name: 100, email: 254,
  q1: 500, q2: 500, q3: 500, q3vision: 500,
  qtime: 300, qbelief: 300, qbelieforigin: 300
};

const orderCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en 15 minutos.' }
});

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================
// PASO 1: Recibir formulario y crear orden
// ============================================
app.post('/api/order/create', orderCreateLimiter, async (req, res) => {
  const { name, email, clientGender, gender, language, q1, q2, qtime, qbelief, qbelieforigin, q3, q3vision } = req.body;

  if (!name || !email || !clientGender || !gender || !q1 || !q2 || !qtime || !qbelief || !qbelieforigin || !q3 || !q3vision) {
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'El campo email no tiene un formato válido.' });
  }

  if (!['male', 'female'].includes(gender)) {
    return res.status(400).json({ error: 'El campo gender debe ser "male" o "female".' });
  }

  if (!['male', 'female'].includes(clientGender)) {
    return res.status(400).json({ error: 'El campo clientGender debe ser "male" o "female".' });
  }

  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    if (req.body[field]?.length > max) {
      return res.status(400).json({ error: `El campo "${field}" excede el máximo de ${max} caracteres.` });
    }
  }

  const orderId = crypto.randomUUID();
  const lang    = language === 'en' ? 'en' : 'es';

  // Obtener link de PayPal primero — si falla, no se crea la orden huérfana
  const paypalLink = await createPayPalOrder(orderId, lang);

  orders.set(orderId, {
    id: orderId,
    name,
    email,
    clientGender,
    gender,
    language: lang,
    q1, q2, qtime, qbelief, qbelieforigin, q3, q3vision,
    status: 'pending_payment',
    createdAt: new Date().toISOString()
  });

  res.json({
    orderId,
    paypalLink,
    message: 'Orden creada. Redirige al usuario a paypalLink para completar el pago.'
  });
});

// ============================================
// PASO 2: Webhook de PayPal — pago confirmado
// ============================================
app.post('/api/paypal/webhook', async (req, res) => {
  // Verificar que la notificación es legítima de PayPal
  const isValid = await verifyPayPalWebhook(req);
  if (!isValid) {
    return res.status(401).json({ error: 'Webhook inválido.' });
  }

  const event = req.body;

  // Solo procesar capturas completadas (dinero realmente cobrado)
  if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED') {
    return res.json({ received: true });
  }

  const orderId = event.resource?.custom_id;
  const order = orders.get(orderId);

  if (!order) {
    return res.status(404).json({ error: 'Orden no encontrada.' });
  }

  if (order.status !== 'pending_payment') {
    return res.json({ message: 'Orden ya procesada.' });
  }

  // Marcar como pagado e iniciar generación
  order.status = 'generating';
  orders.set(orderId, order);

  // Responder a PayPal inmediatamente
  res.json({ received: true });

  // Generar hipnosis en background (no bloquea la respuesta)
  processHypnosis(order).catch(err => {
    console.error('Error generando hipnosis:', err);
    order.status = 'error';
    orders.set(orderId, order);
    sendErrorEmail(resend, { name: order.name, email: order.email, orderId, language: order.language })
      .catch(e => console.error('Error enviando email de fallo:', e));
  });
});

// ============================================
// PASO 3: Generar hipnosis + audio + enviar
// ============================================
async function processHypnosis(order) {
  const { id, name, email, clientGender, gender, language, q1, q2, qtime, qbelief, qbelieforigin, q3, q3vision } = order;

  console.log(`[${id}] Iniciando generación para ${email}`);

  // 3a. Generar guion con Claude
  console.log(`[${id}] Generando guion con IA...`);
  const script = await generateScript(anthropic, { name, clientGender, q1, q2, qtime, qbelief, qbelieforigin, q3, q3vision }, language);

  // 3b. Convertir guion a audio con ElevenLabs
  console.log(`[${id}] Convirtiendo a audio con ElevenLabs...`);
  const audioBuffer = await generateHypnosisAudio(script, gender);

  // 3c. Subir audio a S3
  console.log(`[${id}] Subiendo audio a S3...`);
  const s3Url = await uploadToS3(audioBuffer, name);
  if (s3Url) {
    order.s3Url = s3Url;
    orders.set(id, order);
    console.log(`[${id}] Audio disponible en S3: ${s3Url}`);
  }

  // 3d. Enviar email con el audio adjunto
  console.log(`[${id}] Enviando email a ${email}...`);
  await sendDeliveryEmail(resend, { name, email, audioBuffer, orderId: id, s3Url, language });

  // Marcar como completado
  order.status = 'delivered';
  order.deliveredAt = new Date().toISOString();
  orders.set(id, order);

  console.log(`[${id}] Entregado exitosamente a ${email}`);
}

// ============================================
// Generador de guion con Claude (ES + EN)
// ============================================
async function generateScript(client, { name, clientGender, q1, q2, qtime, qbelief, qbelieforigin, q3, q3vision }, language = 'es') {
  const isEn     = language === 'en';
  const genLabel = isEn
    ? (clientGender === 'female' ? 'Female'   : 'Male')
    : (clientGender === 'female' ? 'Femenino' : 'Masculino');
  const prompt = isEn ? `You are the creator of identity hypnosis for the Despertar ID™ method. Write a deeply personalized hypnosis script in English following the exact six-phase structure detailed below.

CLIENT DATA:
- Name: ${name}
- Client gender: ${genLabel}
- What they want to change: ${q1}
- How they feel now: ${q2}
- How long they've been carrying this: ${qtime}
- Limiting phrase they repeat: ${qbelief}
- When they started believing it: ${qbelieforigin}
- Who they want to be / what they want to achieve: ${q3}
- How they see the version that already overcame this: ${q3vision}

GLOBAL STYLE RULES:
- American English. Clear, warm, and direct.
- Simple language. No jargon or complex words.
- Short sentences. Maximum 15 words per sentence.
- Pauses with ellipsis ... Never write "pause" or use brackets.
- Write ONLY the script. No phase titles, no notes, no explanations.
- Each idea on its own line or with a line break.
- Gender concordance: use ${clientGender === 'female' ? 'she/her forms and feminine adjectives' : 'he/him forms and masculine adjectives'} consistently throughout.

════════════════════════════════════════
EXACT SCRIPT STRUCTURE
════════════════════════════════════════

PHASE 0 — CONSCIOUS INTRODUCTION (maximum 2 minutes)

Begin by naming exactly what the client wrote as what they want to change: "${q1}"
Use their own words or very close to them. Name the pain, not the solution.
Explain this is not a meditation. It is an identity hypnosis.
Name the limiting belief exactly: "${qbelief}"
Announce the new identity using: "${q3vision}"

Instructions, each on its own line:
Find a place without interruptions.
Use headphones.
Listen for 21 consecutive days.

Invite them to close their eyes.

PHASE 1 — INDUCTION

Breathing block (exact text, three full cycles):

Breathe in deeply... feel the air fill your lungs... and exhale slowly... let go of everything you carried today...
Breathe in again... deeper this time... and as you exhale... feel your body soften...
One more time... breathe in calm... hold for a moment... and breathe out tension...

Body relaxation block (exact text):

Release your shoulders... loosen your jaw... gently open your hands... and relax the space between your eyebrows...

Imaginary box block (exact text):

Imagine a box in front of you... inside that box goes everything that happened today... the conversations... the worries... the pending tasks... all of it inside... close it... leave it outside... this space... is yours...

Countdown from five to one (exact text):

Five... feel your body sink a little deeper...
Four... each breath takes you further in...
Three... your critical mind rests... what you hear now arrives directly...
Two... deeper... calmer... more you...
One... here you are... ready...

PHASE 2 — REFRAMING THE MOMENT

Tell them today they are not meditating. They are doing the most important work that exists. Changing what they believe about themselves.

Introduce the belief: "${qbelief}" Name it directly.

Exact text:

Notice how that belief shows up on its own…
Without you calling it…
Without you choosing it…
That's because it was installed so deep it became automatic…
Today we see it together…
And what you can see, you can change…

Dismantle the belief using what they answered about when it started: "${qbelieforigin}"
They weren't born with it. They learned it. They inherited it. It was installed without their permission. They can uninstall it.

SPECIAL RULE: If qbelieforigin contains "child" or "always been there", this phase must be longer and more tender. First validate the deep pain without rushing. Then dismantle. Never the other way around.

PHASE 3 — IDENTITY MIRROR VISUALIZATION

Two versions of the listener in the same room. Both are them. Completely different.

The first: the one they know today. The one carrying "${qbelief}". Look at it with compassion. No judgment. No shame. Tell it: thank you for bringing me this far.

The second: build it with: "${q3vision}"
Describe how they stand, how they breathe, their posture, how they walk, how they speak. Always peace. Not arrogance. Peace.

Breathing affirmation. Repeat the new belief five times. Inhale the belief. Exhale what doesn't belong.

Exact text:

Place one hand on your chest…
Feel the warmth of your own hand…
What you feel there is real…
And this version you just saw is real too…
Every time you place your hand here over the next 21 days…
your mind will remember what you felt in this moment…
You don't have to do anything else…
Just breathe…
And remember…

PHASE 4 — IDENTITY AFFIRMATIONS

Exact opening text:

Now hear these words as if they were yours…
Because they are…
Every one of them…

Affirmations always start with: I am the kind of person who.
Never in the future. Always in the present.
Between eight and twelve distinct affirmations.
Each developed in four to eight lines.
Built around the pain "${q1}" and the new identity "${q3vision}".
Intersperse guided breaths every two or three affirmations.
Include a re-engagement cue every three or four minutes.

PHASE 5 — PURPOSE AND ANTICIPATORY GRATITUDE

Permission line before talking about impact on others.
Question 1: what becomes possible when you no longer have this block.
Question 2: who else is freed when you free yourself.
Anticipatory gratitude for what is already moving.

Four breathing pairs. Always end with:
Breathe in who you really are…
Breathe out who they told you to be…

PHASE 6 — CLOSING, ANCHORING AND CALL TO ACTION

Emotional close without rushing. The subconscious changes with repetition, not with intensity. That's why 21 consecutive days.
Future story: you'll look back and smile for having started today.

Call to action. Same voice, same rhythm. Exact text:

When you complete these 21 days… don't let it slip…
Join our community and turn this change into your new normal… surrounded by people who also chose to evolve…
And when you're ready… create your next hypnosis and transform another area of your life…

Final close. Exact text:

You're not waiting to become that person…
You're remembering that you already are…

Sealing sensation. Exact text:

And every time you take a deep breath today…
this activates again…
You don't need to remember it…
Your body already knows…

Absolute close. Exact text:

Open your eyes when you're ready…
Slowly…
Calmly…
And carry with you what you found here…
Because it's already yours…
It always was…` : `Eres el creador de hipnosis de identidad del método Despertar ID™. Escribe un guion de hipnosis profundamente personalizado siguiendo la estructura de seis fases exacta que se detalla abajo.

DATOS DEL CLIENTE:
- Nombre: ${name}
- Género del cliente: ${genLabel}
- Qué quiere cambiar: ${q1}
- Cómo se siente ahora: ${q2}
- Tiempo cargando esto: ${qtime}
- Frase limitante que se repite: ${qbelief}
- Cuándo empezó a creer eso: ${qbelieforigin}
- Quién quiere ser / qué quiere lograr: ${q3}
- Cómo se ve la versión que ya superó esto: ${q3vision}

REGLAS GLOBALES DE ESTILO:
- Español latino. Sin anglicismos.
- Lenguaje simple, cálido y directo.
- Frases cortas. Máximo 15 palabras por frase.
- Pausas con puntos suspensivos ... Nunca escribas "pausa" ni uses corchetes.
- Escribe SOLO el guion. Sin títulos de fase, sin notas, sin explicaciones.
- Cada idea en su propia línea o con salto de línea.
- Concordancia de género: el cliente es ${genLabel}. Todas las palabras con concordancia de género deben estar en ${clientGender === 'female' ? 'femenino' : 'masculino'} sin excepción en todas las fases. Palabras que cambian: tranquilo→tranquila, listo→lista, solo→sola, relajado→relajada, abierto→abierta, dispuesto→dispuesta, cansado→cansada, atrapado→atrapada, frustrado→frustrada, preparado→preparada, bienvenido→bienvenida, conectado→conectada, rodeado→rodeada. ${clientGender === 'female' ? 'Usa siempre la forma femenina de estas palabras.' : 'Usa siempre la forma masculina de estas palabras.'}

════════════════════════════════════════
ESTRUCTURA EXACTA DEL GUION
════════════════════════════════════════

FASE 0 — INTRODUCCIÓN CONSCIENTE (máximo 2 minutos)

Comienza nombrando exactamente lo que el cliente escribió como qué quiere cambiar: "${q1}"
Usa sus propias palabras o muy cerca. Nombra el dolor, no la solución.
Explica que esto no es una meditación. Es una hipnosis de identidad.
Nombra la creencia limitante exacta: "${qbelief}"
Anuncia la identidad nueva usando: "${q3vision}"

Instrucciones, cada una en su propia línea:
Busca un lugar sin interrupciones.
Usa audífonos.
Escúchala 21 días seguidos.

Invita a cerrar los ojos.

FASE 1 — INDUCCIÓN

Bloque de respiración (texto exacto, tres ciclos completos):

Inhala profundo... siente el aire llenar tus pulmones... y exhala despacio... suelta todo lo que cargaste hoy...
Inhala de nuevo... más profundo esta vez... y al exhalar... siente cómo tu cuerpo se ablanda...
Una vez más... inhala calma... retén un momento... y exhala tensión...

Bloque de relajación corporal (texto exacto):

Suelta los hombros... afloja la mandíbula... abre suavemente las manos... y relaja el espacio entre tus cejas...

Bloque de la caja imaginaria (texto exacto):

Imagina una caja frente a ti... dentro de esa caja va todo lo que pasó hoy... las conversaciones... las preocupaciones... las tareas pendientes... todo adentro... ciérrala... déjala afuera... este espacio... es tuyo...

Cuenta regresiva del cinco al uno (texto exacto):

Cinco... siente cómo tu cuerpo se hunde un poco más...
Cuatro... cada respiración te lleva más adentro...
Tres... tu mente crítica descansa... lo que escuches ahora llega directo...
Dos... más adentro... más tranquilo... más tú...
Uno... aquí estás... listo...

FASE 2 — REENCUADRE DEL MOMENTO

Dile que hoy no está meditando. Está haciendo el trabajo más importante que existe. Cambiar lo que cree sobre sí mismo.

Introduce la creencia: "${qbelief}" Nómbrala directamente.

Texto exacto:

Nota cómo esa creencia aparece sola…
Sin que tú la llames…
Sin que tú la elijas…
Eso es porque fue instalada tan profundo que se volvió automática…
Hoy la vemos juntos…
Y lo que puedes ver, puedes cambiar…

Desmonta la creencia usando lo que respondió sobre cuándo empezó: "${qbelieforigin}"
No nació con ella. La aprendió. La heredó. La instalaron sin su permiso. Puede desinstalarla.

REGLA ESPECIAL: Si qbelieforigin contiene "niño" o "siempre ha estado ahí", esta fase debe ser más larga y más tierna. Primero valida el dolor profundo sin prisa. Luego desmonta. Nunca al revés.

FASE 3 — VISUALIZACIÓN DEL ESPEJO DE IDENTIDAD

Dos versiones del oyente en el mismo cuarto. Las dos son él. Completamente distintas.

La primera: la que conoce hoy. La que carga "${qbelief}". Mírala con compasión. Sin juicio. Sin vergüenza. Dile: gracias por traerme hasta aquí.

La segunda: constrúyela con: "${q3vision}"
Describe cómo se para, cómo respira, su postura, cómo camina, cómo habla. Siempre paz. No arrogancia. Paz.

Afirmación de respiración. Repite la creencia nueva cinco veces. Inhala la creencia. Exhala lo que no pertenece.

Texto exacto:

Pon una mano en tu pecho…
Siente el calor de tu propia mano…
Eso que sientes ahí es real…
Y esta versión que acabas de ver también lo es…
Cada vez que pongas tu mano aquí durante los próximos 21 días…
tu mente va a recordar lo que sentiste en este momento…
No tienes que hacer nada más…
Solo respirar…
Y recordar…

FASE 4 — AFIRMACIONES DE IDENTIDAD

Texto exacto de apertura:

Ahora escucha estas palabras como si fueran tuyas…
Porque lo son…
Cada una…

Las afirmaciones siempre empiezan con: Soy la clase de persona que.
Nunca en futuro. Siempre en presente.
Entre ocho y doce afirmaciones distintas.
Cada una desarrollada en cuatro a ocho líneas.
Construidas alrededor del dolor "${q1}" y la identidad nueva "${q3vision}".
Intercala respiraciones guiadas cada dos o tres afirmaciones.
Incluye un reenganche de atención cada tres o cuatro minutos.

FASE 5 — PROPÓSITO Y GRATITUD ANTICIPATORIA

Línea de permiso antes de hablar de impacto en otros.
Pregunta 1: qué se vuelve posible cuando ya no tienes este bloqueo.
Pregunta 2: quién más se libera cuando tú te liberas.
Gratitud anticipatoria por lo que ya se está moviendo.

Cuatro pares de respiración. Termina siempre con:
Inhala quién eres de verdad…
Exhala quién te dijeron que debías ser…

FASE 6 — CIERRE, ANCLAJE Y LLAMADO A LA ACCIÓN

Cierre emocional sin prisa. El subconsciente cambia con repetición, no con intensidad. Por eso 21 días seguidos.
Historia hacia el futuro: vas a mirar atrás y sonreír por haber empezado hoy.

Llamado a la acción. Misma voz, mismo ritmo. Texto exacto:

Cuando completes estos 21 días… no lo dejes caer…
Únete a nuestra comunidad y convierte este cambio en tu nueva normalidad… rodeado de personas que también eligieron evolucionar…
Y cuando estés listo… crea tu siguiente hipnosis y transforma otra área de tu vida…

Cierre final. Texto exacto:

No estás esperando convertirte en esa persona…
Estás recordando que ya lo eres…

Sensación de sellado. Texto exacto:

Y cada vez que respires profundo hoy…
esto se activa de nuevo…
No necesitas recordarlo…
Tu cuerpo ya lo sabe…

Cierre absoluto. Texto exacto:

Abre los ojos cuando estés listo…
Despacio…
Con calma…
Y lleva contigo lo que encontraste aquí…
Porque ya es tuyo…
Siempre lo fue…`;

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 6000,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

// ============================================
// Subir audio a S3
// ============================================
async function uploadToS3(audioBuffer, name) {
  const bucket = process.env.AWS_BUCKET_NAME;
  if (!s3Client || !bucket) {
    console.warn('S3 no configurado — se omite subida a S3.');
    return null;
  }

  const safeName = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const date     = new Date().toISOString().slice(0, 10);
  const filename = `hipnosis-${safeName}-${date}.mp3`;

  await s3Client.send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         filename,
    Body:        audioBuffer,
    ContentType: 'audio/mpeg'
  }));

  // URL firmada con 7 días de expiración (no requiere bucket público)
  const signedUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: bucket, Key: filename }),
    { expiresIn: 60 * 60 * 24 * 7 }
  );

  return signedUrl;
}

// ============================================
// Envío de email con Resend
// ============================================
async function sendDeliveryEmail(resendClient, { name, email, audioBuffer, orderId, s3Url, language }) {
  const isEn     = language === 'en';
  const safeName = escapeHtml(name);
  const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;
  // Sin S3: adjuntar siempre (es el único canal de entrega).
  // Con S3: adjuntar solo si el archivo es pequeño (evita rechazos de email).
  const includeAttachment = !s3Url || audioBuffer.length <= MAX_ATTACHMENT_BYTES;
  const downloadLabel = isEn ? 'Download my hypnosis' : 'Descargar mi hipnosis';
  const downloadButton = s3Url
    ? `<div style="text-align:center;margin:28px 0;">
        <a href="${s3Url}" style="display:inline-block;background:#FFCC00;color:#1a1a1a;font-family:Georgia,serif;font-size:15px;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none;">
          ${downloadLabel}
        </a>
      </div>`
    : '';

  const subject = isEn
    ? `${name}, this was created just for you`
    : `${name}, esto fue creado solo para ti`;

  const html = isEn ? `
      <div style="font-family: Georgia, serif; max-width: 520px; margin: 0 auto; color: #1a1a1a; line-height: 1.8;">
        <h1 style="font-size: 22px; font-weight: 400; margin-bottom: 20px;">${safeName}, your hypnosis is ready.</h1>
        <p style="color: #333; font-size: 15px; margin-bottom: 20px;">I created it based exactly on what you shared with me.</p>
        <p style="color: #333; font-size: 15px; margin-bottom: 8px;"><strong>Before you press play, read this:</strong></p>
        <p style="color: #555; font-size: 15px; margin-bottom: 20px;">
          Listen in a place without interruptions.<br>
          Use headphones if you can.<br>
          The first few days you may not feel anything dramatic. That's normal. The change happens beneath what you can see. Trust the process.<br>
          Listen for 21 consecutive days. Not 20. Not 15. 21.
        </p>
        ${downloadButton}
        <p style="color: #555; font-size: 15px; margin-bottom: 20px;">
          ${includeAttachment ? 'Your hypnosis is also attached to this email as an MP3 file.<br>It\'s yours forever.' : 'Your download link is valid for 7 days.'}
        </p>
        <p style="color: #555; font-size: 15px; margin-bottom: 32px;">
          When you start to notice the change, there's a next step waiting for you.<br>
          But for now, just press play.
        </p>
        <p style="color: #333; font-size: 15px;">With intention,<br><strong>Despertar ID</strong></p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
        <p style="font-size: 12px; color: #999;">Despertar ID™ · Order #${orderId.slice(0, 8).toUpperCase()}</p>
      </div>
    ` : `
      <div style="font-family: Georgia, serif; max-width: 520px; margin: 0 auto; color: #1a1a1a; line-height: 1.8;">
        <h1 style="font-size: 22px; font-weight: 400; margin-bottom: 20px;">${safeName}, tu hipnosis está lista.</h1>
        <p style="color: #333; font-size: 15px; margin-bottom: 20px;">La creé basándome exactamente en lo que me compartiste.</p>
        <p style="color: #333; font-size: 15px; margin-bottom: 8px;"><strong>Antes de darle play, lee esto:</strong></p>
        <p style="color: #555; font-size: 15px; margin-bottom: 20px;">
          Escúchala en un lugar sin interrupciones.<br>
          Usa audífonos si puedes.<br>
          Los primeros días puedes no sentir nada dramático. Eso es normal. El cambio ocurre por debajo de lo que puedes ver. Confía en el proceso.<br>
          Escúchala 21 días seguidos. No 20. No 15. 21.
        </p>
        ${downloadButton}
        <p style="color: #555; font-size: 15px; margin-bottom: 20px;">
          ${includeAttachment ? 'Tu hipnosis también está adjunta a este correo como archivo MP3.<br>Es tuya para siempre.' : 'El enlace de descarga es válido por 7 días.'}
        </p>
        <p style="color: #555; font-size: 15px; margin-bottom: 32px;">
          Cuando empieces a notar el cambio, hay un siguiente paso esperándote.<br>
          Pero por ahora, solo dale play.
        </p>
        <p style="color: #333; font-size: 15px;">Con intención,<br><strong>Despertar ID</strong></p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
        <p style="font-size: 12px; color: #999;">Despertar ID™ · Orden #${orderId.slice(0, 8).toUpperCase()}</p>
      </div>
    `;

  const attachments = includeAttachment
    ? [{ filename: `hypnosis-${name.toLowerCase().replace(/\s+/g, '-')}.mp3`, content: audioBuffer.toString('base64'), contentType: 'audio/mpeg' }]
    : [];

  await resendClient.emails.send({ from: 'Despertar ID™ <hipnosis@qrise.co>', to: email, subject, html, attachments });
}

// ============================================
// Email de error al usuario
// ============================================
async function sendErrorEmail(resendClient, { name, email, orderId, language }) {
  const isEn     = language === 'en';
  const safeName = escapeHtml(name);
  await resendClient.emails.send({
    from: 'Despertar ID™ <hipnosis@qrise.co>',
    to: email,
    subject: isEn ? 'We had a problem with your order' : 'Tuvimos un problema con tu orden',
    html: isEn ? `
      <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#1a1a1a;line-height:1.8;">
        <h1 style="font-size:22px;font-weight:400;margin-bottom:20px;">${safeName}, something went wrong.</h1>
        <p style="color:#333;font-size:15px;margin-bottom:20px;">
          We had a technical problem generating your hypnosis.<br>
          Your payment is safe. We'll fix this manually and send it to you as soon as possible.
        </p>
        <p style="color:#333;font-size:15px;">
          If you don't hear from us within 24 hours, reply to this email and we'll take care of it immediately.
        </p>
        <p style="color:#333;font-size:15px;margin-top:32px;">With intention,<br><strong>Despertar ID</strong></p>
        <hr style="border:none;border-top:1px solid #eee;margin:32px 0;">
        <p style="font-size:12px;color:#999;">Despertar ID™ · Order #${orderId.slice(0, 8).toUpperCase()}</p>
      </div>
    ` : `
      <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#1a1a1a;line-height:1.8;">
        <h1 style="font-size:22px;font-weight:400;margin-bottom:20px;">${safeName}, algo salió mal.</h1>
        <p style="color:#333;font-size:15px;margin-bottom:20px;">
          Tuvimos un problema técnico generando tu hipnosis.<br>
          Tu pago está seguro. Lo vamos a resolver manualmente y te lo enviamos lo antes posible.
        </p>
        <p style="color:#333;font-size:15px;">
          Si no tienes noticias en 24 horas, responde este correo y lo atendemos de inmediato.
        </p>
        <p style="color:#333;font-size:15px;margin-top:32px;">Con intención,<br><strong>Despertar ID</strong></p>
        <hr style="border:none;border-top:1px solid #eee;margin:32px 0;">
        <p style="font-size:12px;color:#999;">Despertar ID™ · Orden #${orderId.slice(0, 8).toUpperCase()}</p>
      </div>
    `
  });
}

// ============================================
// Helper: obtener access token de PayPal
// ============================================
async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret   = process.env.PAYPAL_SECRET;
  const baseUrl  = process.env.PAYPAL_ENV === 'production'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) throw new Error(`PayPal auth error ${res.status}: ${await res.text()}`);

  const { access_token } = await res.json();
  if (!access_token) throw new Error('PayPal no devolvió access_token.');
  return access_token;
}

// ============================================
// Crear orden en PayPal
// ============================================
async function createPayPalOrder(orderId, language = 'es') {
  const baseUrl = process.env.PAYPAL_ENV === 'production'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  const access_token = await getPayPalAccessToken();

  const orderRes = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id: orderId,
        amount: { currency_code: 'USD', value: language === 'en' ? '57.00' : '27.00' },
        description: 'Hipnosis personalizada — Despertar ID™'
      }],
      application_context: {
        return_url: `${process.env.FRONTEND_URL}${language === 'en' ? '/en/gracias' : '/gracias'}`,
        cancel_url: `${process.env.FRONTEND_URL}${language === 'en' ? '/en/cancelado' : '/cancelado'}`
      }
    })
  });

  const orderData = await orderRes.json();
  if (!orderRes.ok) throw new Error(`PayPal order error ${orderRes.status}: ${JSON.stringify(orderData)}`);

  const approvalLink = orderData.links?.find(l => l.rel === 'approve')?.href;
  if (!approvalLink) throw new Error('PayPal no devolvió el enlace de aprobación.');
  return approvalLink;
}

// ============================================
// Verificación de webhook PayPal (API oficial)
// ============================================
async function verifyPayPalWebhook(req) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    console.warn('PAYPAL_WEBHOOK_ID no configurado — verificación omitida en dev.');
    return true;
  }

  const transmissionId   = req.headers['paypal-transmission-id'];
  const transmissionTime = req.headers['paypal-transmission-time'];
  const certUrl          = req.headers['paypal-cert-url'];
  const authAlgo         = req.headers['paypal-auth-algo'];
  const transmissionSig  = req.headers['paypal-transmission-sig'];

  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    return false;
  }

  const baseUrl = process.env.PAYPAL_ENV === 'production'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  const accessToken = await getPayPalAccessToken();

  const verifyRes = await fetch(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      auth_algo:         authAlgo,
      cert_url:          certUrl,
      transmission_id:   transmissionId,
      transmission_sig:  transmissionSig,
      transmission_time: transmissionTime,
      webhook_id:        webhookId,
      webhook_event:     req.body
    })
  });

  const { verification_status } = await verifyRes.json();
  return verification_status === 'SUCCESS';
}

// ============================================
// Endpoint de estado (para el frontend)
// ============================================
app.get('/api/order/:id/status', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'No encontrada.' });
  res.json({ status: order.status, deliveredAt: order.deliveredAt || null });
});

// ============================================
// Admin — página de órdenes (protegida con HTTP Basic Auth)
// ============================================
function checkAdminAuth(req, res) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).send('Panel admin no configurado (falta ADMIN_PASSWORD).');
    return false;
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Despertar ID Admin"');
    res.status(401).send('Autenticación requerida.');
    return false;
  }

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
  const password = decoded.split(':').slice(1).join(':'); // soporta ":" en la contraseña

  if (password !== adminPassword) {
    res.set('WWW-Authenticate', 'Basic realm="Despertar ID Admin"');
    res.status(401).send('No autorizado.');
    return false;
  }

  return true;
}

app.get('/admin', (req, res) => {
  if (!checkAdminAuth(req, res)) return;

  const rows = [...orders.values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(o => {
      const download = o.s3Url
        ? `<a href="${o.s3Url}" target="_blank" style="color:#b8860b;">Descargar</a>`
        : '—';
      const statusColors = { pending_payment: '#888', generating: '#d4a017', delivered: '#2e7d32', error: '#c62828' };
      const color = statusColors[o.status] || '#333';
      return `<tr>
        <td>${escapeHtml(o.name)}</td>
        <td>${escapeHtml(o.email)}</td>
        <td>${new Date(o.createdAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</td>
        <td style="color:${color};font-weight:600;">${escapeHtml(o.status)}</td>
        <td>${download}</td>
        <td style="font-size:11px;color:#999;">${o.id.slice(0, 8).toUpperCase()}</td>
      </tr>`;
    }).join('');

  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin — Despertar ID™</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #1a1a1a; }
    header { background: #1a1a1a; color: #FFCC00; padding: 16px 32px; font-size: 20px; font-weight: 700; letter-spacing: 1px; }
    main { padding: 32px; }
    h2 { font-size: 16px; color: #555; margin-bottom: 20px; font-weight: 400; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
    th { background: #1a1a1a; color: #FFCC00; padding: 12px 16px; text-align: left; font-size: 13px; font-weight: 600; letter-spacing: .5px; }
    td { padding: 12px 16px; font-size: 14px; border-bottom: 1px solid #f0f0f0; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafafa; }
    .empty { text-align: center; padding: 48px; color: #999; }
  </style>
</head>
<body>
  <header>Despertar ID™ — Admin</header>
  <main>
    <h2>${orders.size} órdenes en memoria</h2>
    <table>
      <thead><tr><th>Nombre</th><th>Email</th><th>Fecha</th><th>Estado</th><th>Descarga</th><th>ID</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="empty">Sin órdenes aún.</td></tr>'}</tbody>
    </table>
  </main>
</body>
</html>`);
});

app.get('/admin/api/orders', (req, res) => {
  if (!checkAdminAuth(req, res)) return;
  const data = [...orders.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(data);
});

// ─── Iniciar servidor ────────────────────────
app.listen(PORT, () => {
  console.log(`Despertar ID™ backend corriendo en puerto ${PORT}`);
});
