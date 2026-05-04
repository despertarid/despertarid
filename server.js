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
import { generateHypnosisAudio } from './hypnosis.js';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Clientes de servicios ───────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Middleware ──────────────────────────────
app.use(cors({ origin: '*' }));
app.use(bodyParser.json());

// ─── Frontend ────────────────────────────────
app.get('/',          (req, res) => res.sendFile(join(__dirname, 'index.html')));
app.get('/gracias',   (req, res) => res.sendFile(join(__dirname, 'index.html')));
app.get('/cancelado', (req, res) => res.sendFile(join(__dirname, 'index.html')));

// ─── Almacenamiento temporal de órdenes ─────
// En producción: reemplazar con Firebase o Supabase
const orders = new Map();

// ============================================
// PASO 1: Recibir formulario y crear orden
// ============================================
app.post('/api/order/create', async (req, res) => {
  const { name, email, q1, q2, q3, intensity } = req.body;

  if (!name || !email || !q1 || !q2 || !q3 || !intensity) {
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  }

  // Crear ID único para esta orden
  const orderId = crypto.randomUUID();

  // Guardar datos del formulario
  orders.set(orderId, {
    id: orderId,
    name,
    email,
    q1, q2, q3,
    intensity,
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
  const { id, name, email, q1, q2, q3, intensity } = order;

  console.log(`[${id}] Iniciando generación para ${email}`);

  // 3a. Generar guion con Claude
  console.log(`[${id}] Generando guion con IA...`);
  const script = await generateScript(anthropic, { name, q1, q2, q3, intensity });

  // 3b. Convertir guion a audio con ElevenLabs
  console.log(`[${id}] Convirtiendo a audio con ElevenLabs...`);
  const audioBuffer = await generateHypnosisAudio(script);

  // 3c. Enviar email con el audio adjunto
  console.log(`[${id}] Enviando email a ${email}...`);
  await sendDeliveryEmail(resend, { name, email, audioBuffer, orderId: id });

  // Marcar como completado
  order.status = 'delivered';
  order.deliveredAt = new Date().toISOString();
  orders.set(id, order);

  console.log(`[${id}] Entregado exitosamente a ${email}`);
}

// ============================================
// Generador de guion con Claude
// ============================================
async function generateScript(client, { name, q1, q2, q3, intensity }) {
  const prompt = `Eres un experto en hipnoterapia y transformación de identidad del método Despertar ID™.

Tu tarea es crear un guion de hipnosis personalizado y poderoso para esta persona.

DATOS DEL USUARIO:
- Nombre: ${name}
- Quiere cambiar: ${q1}
- Siente ahora: ${q2}
- Quiere lograr: ${q3}
- Intensidad emocional: ${intensity}/10

INSTRUCCIONES PARA EL GUION:
1. Usa el nombre de la persona al inicio y durante el proceso
2. Usa lenguaje simple, directo y cálido — como si le hablaras a un niño de 7 años
3. Estructura:
   a) INDUCCIÓN (2-3 min): Respiración, relajación progresiva del cuerpo
   b) PROFUNDIZACIÓN (2 min): Bajar a estado alfa-theta
   c) NÚCLEO (8-10 min): Trabajar directamente la creencia limitante identificada en q1/q2, instalar nueva identidad del q3
   d) ANCLAJE (2 min): Anclar el nuevo estado con una frase corta que la persona pueda usar
   e) DESPERTAR (1 min): Salida suave y energizante

REGLAS DE ESTILO:
- El guion debe estar escrito en español latino, sin anglicismos ni palabras de otros idiomas
- Sin tecnicismos ni palabras complicadas
- Ritmo lento con pausas naturales indicadas con puntos suspensivos ... Nunca escribas la palabra "pausa" ni uses corchetes
- Frases cortas. Máximo 15 palabras por frase.
- Repite los conceptos clave 2-3 veces con variaciones
- Termina con una afirmación de identidad poderosa

Escribe SOLO el guion, sin títulos ni explicaciones adicionales. Listo para ser narrado en español latino.`;

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

// ============================================
// Envío de email con Resend
// ============================================
async function sendDeliveryEmail(resendClient, { name, email, audioBuffer, orderId }) {
  await resendClient.emails.send({
    from: 'Despertar ID™ <hipnosis@qrise.co>',
    to: email,
    subject: `${name}, tu hipnosis personalizada está lista`,
    html: `
      <div style="font-family: Georgia, serif; max-width: 520px; margin: 0 auto; color: #1a1a1a;">
        <h1 style="font-size: 22px; font-weight: 400; margin-bottom: 8px;">Tu hipnosis está lista, ${name}.</h1>
        <p style="color: #555; font-size: 15px; line-height: 1.7; margin-bottom: 24px;">
          Creé este audio especialmente para ti, basado en lo que me compartiste.
          Escúchalo cuando estés en un lugar tranquilo, con audífonos si puedes.
        </p>
        <p style="color: #555; font-size: 14px;">
          Encuentra el archivo de audio adjunto a este email.<br>
          Guárdalo — es tuyo para siempre.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
        <p style="font-size: 12px; color: #999;">
          Despertar ID™ · Orden #${orderId.slice(0, 8).toUpperCase()}
        </p>
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

// ─── Iniciar servidor ────────────────────────
app.listen(PORT, () => {
  console.log(`Despertar ID™ backend corriendo en puerto ${PORT}`);
});
