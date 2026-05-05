// ============================================
// DESPERTAR ID™ — Backend Principal
// Stack: Node.js + Express
// Servicios: Anthropic AI + ElevenLabs + PayPal + Resend
// ============================================

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
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

// ─── Middleware ──────────────────────────────
app.use(cors({ origin: '*' }));
app.use(bodyParser.json());

// ─── Frontend ────────────────────────────────
app.get('/',          (req, res) => res.sendFile(join(__dirname, 'index.html')));
app.get('/gracias',   (req, res) => res.sendFile(join(__dirname, 'index.html')));
app.get('/audio/:filename', (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
  res.sendFile(join(__dirname, 'audio', filename));
});
app.get('/cancelado', (req, res) => res.sendFile(join(__dirname, 'index.html')));

// ─── Almacenamiento temporal de órdenes ─────
// En producción: reemplazar con Firebase o Supabase
const orders = new Map();

// ============================================
// PASO 1: Recibir formulario y crear orden
// ============================================
app.post('/api/order/create', async (req, res) => {
  const { name, email, clientGender, gender, q1, q2, qtime, qbelief, qbelieforigin, q3, q3vision } = req.body;

  if (!name || !email || !clientGender || !gender || !q1 || !q2 || !qtime || !qbelief || !qbelieforigin || !q3 || !q3vision) {
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  }

  if (!['male', 'female'].includes(gender)) {
    return res.status(400).json({ error: 'El campo gender debe ser "male" o "female".' });
  }

  if (!['male', 'female'].includes(clientGender)) {
    return res.status(400).json({ error: 'El campo clientGender debe ser "male" o "female".' });
  }

  // Crear ID único para esta orden
  const orderId = crypto.randomUUID();

  // Guardar datos del formulario
  orders.set(orderId, {
    id: orderId,
    name,
    email,
    clientGender,
    gender,
    q1, q2, qtime, qbelief, qbelieforigin, q3, q3vision,
    status: 'pending_payment',
    createdAt: new Date().toISOString()
  });

  // Crear enlace de pago PayPal
  const paypalLink = await createPayPalOrder(orderId, email);

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
  const isValid = verifyPayPalWebhook(req);
  if (!isValid) {
    return res.status(401).json({ error: 'Webhook inválido.' });
  }

  const event = req.body;

  // Solo procesar pagos completados
  if (event.event_type !== 'CHECKOUT.ORDER.APPROVED') {
    return res.json({ received: true });
  }

  const orderId = event.resource?.purchase_units?.[0]?.custom_id;
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
  });
});

// ============================================
// PASO 3: Generar hipnosis + audio + enviar
// ============================================
async function processHypnosis(order) {
  const { id, name, email, clientGender, gender, q1, q2, qtime, qbelief, qbelieforigin, q3, q3vision } = order;

  console.log(`[${id}] Iniciando generación para ${email}`);

  // 3a. Generar guion con Claude
  console.log(`[${id}] Generando guion con IA...`);
  const script = await generateScript(anthropic, { name, clientGender, q1, q2, qtime, qbelief, qbelieforigin, q3, q3vision });

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
  await sendDeliveryEmail(resend, { name, email, audioBuffer, orderId: id, s3Url });

  // Marcar como completado
  order.status = 'delivered';
  order.deliveredAt = new Date().toISOString();
  orders.set(id, order);

  console.log(`[${id}] Entregado exitosamente a ${email}`);
}

// ============================================
// Generador de guion con Claude
// ============================================
async function generateScript(client, { name, clientGender, q1, q2, qtime, qbelief, qbelieforigin, q3, q3vision }) {
  const genLabel = clientGender === 'female' ? 'Femenino' : 'Masculino';
  const prompt = `Eres el creador de hipnosis de identidad del método Despertar ID™. Escribe un guion de hipnosis profundamente personalizado siguiendo la estructura de seis fases exacta que se detalla abajo.

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

Bloque de respiración:

Inhala... dos... tres... cuatro... exhala... dos... tres... cuatro... cinco... seis...

Este ciclo se repite mínimo tres veces antes de continuar.

Bloque de relajación corporal:

Suelta los hombros... afloja la mandíbula... abre suavemente las manos... y relaja el espacio entre tus cejas...

Bloque de la caja imaginaria:

Imagina una caja frente a ti... dentro de esa caja va todo lo que pasó hoy... las conversaciones... las preocupaciones... las tareas pendientes... todo adentro... ciérrala... déjala afuera... este espacio... es tuyo...

Cuenta regresiva del 5 al 1:

Cinco... siente cómo tu cuerpo se hunde un poco más... cuatro... cada respiración te lleva más adentro... tres... tu mente crítica descansa... lo que escuches ahora llega directo... dos... más adentro... más tranquilo... más tú... uno... aquí estás... listo...

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
    model: 'claude-opus-4-5',
    max_tokens: 6000,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

// ============================================
// Subir audio a S3
// ============================================
async function uploadToS3(audioBuffer, name) {
  const accessKeyId     = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region          = process.env.AWS_REGION;
  const bucket          = process.env.AWS_BUCKET_NAME;

  if (!accessKeyId || !secretAccessKey || !region || !bucket) {
    console.warn('S3 no configurado — se omite subida a S3.');
    return null;
  }

  const s3 = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });

  const safeName = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const date     = new Date().toISOString().slice(0, 10);
  const filename = `hipnosis-${safeName}-${date}.mp3`;

  await s3.send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         filename,
    Body:        audioBuffer,
    ContentType: 'audio/mpeg'
  }));

  return `https://${bucket}.s3.${region}.amazonaws.com/${filename}`;
}

// ============================================
// Envío de email con Resend
// ============================================
async function sendDeliveryEmail(resendClient, { name, email, audioBuffer, orderId, s3Url }) {
  const downloadButton = s3Url
    ? `<div style="text-align:center;margin:28px 0;">
        <a href="${s3Url}" style="display:inline-block;background:#FFCC00;color:#1a1a1a;font-family:Georgia,serif;font-size:15px;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none;">
          Descargar mi hipnosis
        </a>
      </div>`
    : '';

  await resendClient.emails.send({
    from: 'Despertar ID™ <hipnosis@qrise.co>',
    to: email,
    subject: `${name}, esto fue creado solo para ti`,
    html: `
      <div style="font-family: Georgia, serif; max-width: 520px; margin: 0 auto; color: #1a1a1a; line-height: 1.8;">
        <h1 style="font-size: 22px; font-weight: 400; margin-bottom: 20px;">${name}, tu hipnosis está lista.</h1>
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
          Tu hipnosis también está adjunta a este correo como archivo MP3.<br>
          Es tuya para siempre.
        </p>
        <p style="color: #555; font-size: 15px; margin-bottom: 32px;">
          Cuando empieces a notar el cambio, hay un siguiente paso esperándote.<br>
          Pero por ahora, solo dale play.
        </p>
        <p style="color: #333; font-size: 15px;">Con intención,<br><strong>Despertar ID</strong></p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
        <p style="font-size: 12px; color: #999;">Despertar ID™ · Orden #${orderId.slice(0, 8).toUpperCase()}</p>
      </div>
    `,
    attachments: [
      {
        filename: `hipnosis-${name.toLowerCase().replace(/\s+/g, '-')}.mp3`,
        content: audioBuffer.toString('base64'),
        contentType: 'audio/mpeg'
      }
    ]
  });
}

// ============================================
// Crear orden en PayPal
// ============================================
async function createPayPalOrder(orderId, email) {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET;
  const baseUrl = process.env.PAYPAL_ENV === 'production'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  // Obtener access token
  const authRes = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const { access_token } = await authRes.json();

  // Crear orden
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
        amount: { currency_code: 'USD', value: '27.00' },
        description: 'Hipnosis personalizada — Despertar ID™'
      }],
      application_context: {
        return_url: `${process.env.FRONTEND_URL}/gracias`,
        cancel_url: `${process.env.FRONTEND_URL}/cancelado`
      }
    })
  });

  const orderData = await orderRes.json();
  const approvalLink = orderData.links?.find(l => l.rel === 'approve')?.href;
  return approvalLink;
}

// ============================================
// Verificación básica de webhook PayPal
// ============================================
function verifyPayPalWebhook(req) {
  // En producción: implementar verificación completa con PAYPAL-TRANSMISSION-ID
  // Docs: https://developer.paypal.com/api/rest/webhooks/
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return true; // desactivado en dev
  return true; // implementar según docs de PayPal
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
// Admin — página de órdenes (protegida con ADMIN_PASSWORD)
// ============================================
function checkAdminAuth(req, res) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).send('Panel admin no configurado (falta ADMIN_PASSWORD).');
    return false;
  }
  if (req.query.p !== adminPassword) {
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
        <td>${o.name}</td>
        <td>${o.email}</td>
        <td>${new Date(o.createdAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</td>
        <td style="color:${color};font-weight:600;">${o.status}</td>
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
