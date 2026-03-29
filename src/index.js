const express = require('express')
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js')
const qrcode = require('qrcode-terminal')
const QRCode = require('qrcode')

const app = express()
app.use(express.json({ limit: '50mb' }))

const PORT = process.env.PORT || 3001
const SECRET = process.env.WA_SERVICE_SECRET || 'woken_wa_2026_secret'

// Estado del cliente WhatsApp
let clientReady = false
let currentQR = null
let connectionStatus = 'disconnected' // disconnected | qr_pending | connected
let lastActivity = Date.now()

// Limpiar lock files de Chromium (Railway restarts)
const fs = require('fs')
const path = require('path')
const sessionPath = './wa-session'
try {
  const cleanLocks = (dir) => {
    if (!fs.existsSync(dir)) return
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.name === 'SingletonLock' || entry.name === 'SingletonCookie' || entry.name === 'SingletonSocket') {
        fs.unlinkSync(fullPath)
        console.log(`🧹 Eliminado lock: ${fullPath}`)
      } else if (entry.isDirectory()) {
        cleanLocks(fullPath)
      }
    }
  }
  cleanLocks(sessionPath)
} catch (err) {
  console.warn('⚠️ Error limpiando locks:', err.message)
}

// Inicializar cliente WhatsApp
const waClient = new Client({
  authStrategy: new LocalAuth({ dataPath: sessionPath }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-first-run',
      '--no-zygote',
    ],
  },
})

waClient.on('qr', (qr) => {
  currentQR = qr
  connectionStatus = 'qr_pending'
  console.log('\n📱 Escanea este QR con WhatsApp:')
  qrcode.generate(qr, { small: true })
  console.log('\nTambien disponible en: http://localhost:' + PORT + '/qr\n')
})

waClient.on('ready', () => {
  clientReady = true
  currentQR = null
  connectionStatus = 'connected'
  lastActivity = Date.now()
  console.log('✅ WhatsApp conectado y listo!')
})

waClient.on('authenticated', () => {
  console.log('🔐 WhatsApp autenticado')
})

waClient.on('auth_failure', (msg) => {
  console.error('❌ Error de autenticacion WhatsApp:', msg)
  connectionStatus = 'disconnected'
  clientReady = false
})

waClient.on('disconnected', (reason) => {
  console.log('📴 WhatsApp desconectado:', reason)
  connectionStatus = 'disconnected'
  clientReady = false
  currentQR = null
  setTimeout(() => {
    console.log('🔄 Reintentando conexion...')
    waClient.initialize().catch(err => {
      console.error('❌ Error reinicializando:', err.message)
    })
  }, 5000)
})

// Keepalive cada 5 minutos
setInterval(async () => {
  if (!clientReady) return
  try {
    const state = await waClient.getState()
    if (state !== 'CONNECTED') {
      console.warn(`⚠️ Estado WA inesperado: ${state}, reconectando...`)
      connectionStatus = 'disconnected'
      clientReady = false
      waClient.initialize().catch(() => {})
    } else {
      lastActivity = Date.now()
      console.log(`💓 Keepalive OK`)
    }
  } catch (err) {
    console.warn('⚠️ Keepalive fallo:', err.message)
  }
}, 5 * 60 * 1000)

waClient.on('change_state', (state) => {
  console.log(`🔀 Estado WA cambio a: ${state}`)
})

// Middleware de autenticacion
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || auth !== `Bearer ${SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' })
  }
  next()
}

// ── Rutas ───────────────────────────────────────────────────────────────

// Health check (sin auth)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    whatsapp: connectionStatus,
    ready: clientReady,
    uptime: Math.floor(process.uptime()),
  })
})

// Ver QR en el navegador (sin auth, para setup inicial)
app.get('/qr', async (req, res) => {
  if (clientReady) {
    return res.send(`
      <html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#022568;color:white;">
        <div style="text-align:center;">
          <h1>✅ WhatsApp Conectado</h1>
          <p>Woken IA esta listo para enviar mensajes.</p>
        </div>
      </body></html>
    `)
  }

  if (!currentQR) {
    return res.send(`
      <html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#022568;color:white;">
        <div style="text-align:center;">
          <h1>⏳ Esperando QR...</h1>
          <p>Recarga la pagina en unos segundos.</p>
          <script>setTimeout(() => location.reload(), 3000)</script>
        </div>
      </body></html>
    `)
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(currentQR)
    res.send(`
      <html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#022568;color:white;">
        <div style="text-align:center;">
          <h1>📱 Escanea con WhatsApp</h1>
          <p>Abre WhatsApp > Dispositivos vinculados > Vincular dispositivo</p>
          <img src="${qrDataUrl}" style="margin:20px auto;border-radius:8px;" />
          <script>
            setInterval(async () => {
              const res = await fetch('/health')
              const data = await res.json()
              if (data.ready) location.reload()
            }, 3000)
          </script>
        </div>
      </body></html>
    `)
  } catch {
    res.status(500).send('Error generando QR')
  }
})

// QR como JSON (con auth) — usado por Woken IA frontend
app.get('/api/qr', authMiddleware, async (req, res) => {
  if (clientReady) {
    return res.json({ status: 'connected', qr: null })
  }
  if (!currentQR) {
    return res.json({ status: 'waiting', qr: null })
  }
  try {
    const qrDataUrl = await QRCode.toDataURL(currentQR)
    res.json({ status: 'qr_pending', qr: qrDataUrl })
  } catch {
    res.status(500).json({ error: 'Error generando QR' })
  }
})

// Estado (con auth)
app.get('/api/status', authMiddleware, (req, res) => {
  res.json({
    status: connectionStatus,
    ready: clientReady,
    uptime: Math.floor(process.uptime()),
  })
})

// Enviar mensaje (con auth)
app.post('/api/send', authMiddleware, async (req, res) => {
  const { phone, message, media } = req.body

  if (!phone || (!message && !media)) {
    return res.status(400).json({ error: 'phone y (message o media) son requeridos' })
  }

  if (!clientReady) {
    return res.status(503).json({
      error: 'WhatsApp no esta conectado. Escanea el QR primero.',
      status: connectionStatus,
    })
  }

  try {
    const chatId = phone.replace(/\D/g, '') + '@c.us'

    const isRegistered = await waClient.isRegisteredUser(chatId)
    if (!isRegistered) {
      return res.status(400).json({
        error: `El numero ${phone} no esta registrado en WhatsApp`,
      })
    }

    let sent
    if (media && media.data && media.mimetype) {
      const waMedia = new MessageMedia(media.mimetype, media.data, media.filename || null)
      sent = await waClient.sendMessage(chatId, waMedia, {
        caption: message || '',
        sendMediaAsDocument: media.mimetype === 'application/pdf',
      })
      console.log(`📤 Media enviado a ${phone} (${media.mimetype})`)
    } else {
      sent = await waClient.sendMessage(chatId, message)
      console.log(`📤 Mensaje enviado a ${phone}`)
    }

    lastActivity = Date.now()
    res.json({ success: true, phone, wa_message_id: sent.id?.id || null })
  } catch (err) {
    console.error('Error enviando mensaje:', err.message)
    res.status(500).json({ error: 'Error al enviar mensaje', detail: err.message })
  }
})

// Logout (con auth)
app.post('/api/logout', authMiddleware, async (req, res) => {
  try {
    await waClient.logout()
    clientReady = false
    currentQR = null
    connectionStatus = 'disconnected'
    console.log('📴 Logout exitoso')
    res.json({ ok: true })
  } catch (err) {
    console.error('Error en logout:', err.message)
    // Forzar reset
    clientReady = false
    currentQR = null
    connectionStatus = 'disconnected'
    res.json({ ok: true })
  }
})

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`\n🚀 woken-wa corriendo en puerto ${PORT}`)
  console.log(`   Health: http://localhost:${PORT}/health`)
  console.log(`   QR:     http://localhost:${PORT}/qr\n`)

  waClient.initialize()
})
