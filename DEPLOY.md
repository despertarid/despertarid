# DESPERTAR ID™ — Guía de Deploy
## De cero a producción en menos de 1 hora

---

## PASO 1 — Claves que necesitas conseguir primero

### 1. Anthropic (Claude AI)
- Ve a: https://console.anthropic.com
- Crea cuenta → API Keys → Create Key
- Copia la key al .env como ANTHROPIC_API_KEY

### 2. ElevenLabs (tu voz)
- Ve a: https://elevenlabs.io
- Profile → API Key → copia al .env como ELEVENLABS_API_KEY
- My Voices → encuentra tu voz → copia el Voice ID al .env como ELEVENLABS_VOICE_ID

### 3. PayPal (pagos)
- Ve a: https://developer.paypal.com
- Crea una app en modo Sandbox para pruebas
- Copia Client ID y Secret al .env
- Cuando estés listo para producción: cambia PAYPAL_ENV=production
  y usa las credenciales de producción
- En Webhooks: crea un webhook apuntando a:
  https://TU-DOMINIO.com/api/paypal/webhook
  Evento a escuchar: CHECKOUT.ORDER.APPROVED

### 4. Resend (email de entrega)
- Ve a: https://resend.com
- Crea cuenta gratuita (3000 emails/mes gratis)
- Verifica tu dominio siguiendo sus instrucciones
- API Keys → Create API Key
- Copia al .env como RESEND_API_KEY
- En server.js cambia: from: 'hipnosis@TU-DOMINIO.com'

---

## PASO 2 — Deploy en Railway (recomendado, gratis para empezar)

```bash
# 1. Instala Railway CLI
npm install -g @railway/cli

# 2. Login
railway login

# 3. Entra a la carpeta del proyecto
cd despertar-id-backend

# 4. Inicia proyecto en Railway
railway init

# 5. Sube las variables de entorno
# Ve a railway.app → tu proyecto → Variables
# Agrega una por una las del .env.example con sus valores reales

# 6. Deploy
railway up

# Railway te dará una URL como:
# https://despertar-id-backend.railway.app
```

Alternativa gratuita: Render.com
- Conecta tu repositorio de GitHub
- Elige "Web Service"
- Agrega las variables de entorno en el panel
- Deploy automático

---

## PASO 3 — Subir el código a GitHub primero

```bash
# En la carpeta del proyecto
git init
echo ".env" >> .gitignore        # MUY IMPORTANTE: nunca subas el .env real
echo "node_modules" >> .gitignore
git add .
git commit -m "Despertar ID backend v1"

# Crea repo en github.com y sigue sus instrucciones para push
```

---

## PASO 4 — Conectar el frontend con el backend

En el frontend (el artifact de Claude), reemplaza la función `simulatePay()` con:

```javascript
async function createRealOrder() {
  const res = await fetch('https://TU-BACKEND.railway.app/api/order/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('userName').value,
      email: document.getElementById('userEmail').value,
      q1: document.getElementById('q1').value,
      q2: document.getElementById('q2').value,
      q3: document.getElementById('q3').value,
      intensity: selectedIntensity
    })
  });
  const { paypalLink } = await res.json();
  window.location.href = paypalLink; // Redirige a PayPal
}
```

---

## PASO 5 — Prueba el flujo completo

1. Llena el formulario
2. Haz clic en pagar
3. En sandbox PayPal usa las cuentas de prueba que crea automáticamente
4. Después del pago, revisa tu email — el audio debe llegar en menos de 3 minutos
5. Cuando todo funciona: cambia PAYPAL_ENV=production

---

## Costos estimados por hipnosis vendida

| Servicio | Costo por audio |
|----------|----------------|
| Claude (guion ~2000 tokens) | ~$0.024 |
| ElevenLabs (15 min audio) | ~$0.30 |
| Resend (1 email con adjunto) | Gratis hasta 3000/mes |
| Railway/Render (servidor) | ~$5/mes fijo |

**Costo total por venta: ~$0.33**
**Tu precio: $27**
**Margen: ~98%**

---

## Siguiente escalada (cuando tengas 50+ ventas)

- Agregar Firebase para guardar historial de usuarios
- Dashboard de admin para ver todas las órdenes
- Programa de 21 días con hipnosis diarias (suscripción)
- Comunidad tipo Skool integrada
