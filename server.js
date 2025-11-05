const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  console.log("📌 Solicitud de upgrade recibida (WebSocket)");
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

const MODEL = "gemini-2.5-flash-native-audio-preview-09-2025";
const PORT = process.env.PORT || 3000;
const MAX_CONNECTION_TIME = 13 * 60 * 1000;
const INACTIVITY_THRESHOLD = 3 * 60 * 1000;
const INACTIVITY_CHECK_INTERVAL = 30 * 1000;

// 🔥 Conexiones activas por cliente
const clientConnections = new Map();

// ✅ Conexión directa usando solo la API Key
async function createGeminiConnection() {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    throw new Error("❌ No se encontró GEMINI_API_KEY en variables de entorno");
  }

  const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
  console.log("✅ Conectando con API Key...");
  return new WebSocket(geminiUrl);
}

// ⏱️ Detección de inactividad
function startInactivityCheck(clientWs) {
  const connection = clientConnections.get(clientWs);
  if (!connection) return;

  if (connection.inactivityCheckInterval) {
    clearInterval(connection.inactivityCheckInterval);
  }

  connection.inactivityCheckInterval = setInterval(() => {
    const conn = clientConnections.get(clientWs);
    if (!conn || !conn.hasHadInteraction) return;

    const timeSinceLastInteraction = Date.now() - conn.lastInteractionTime;
    if (timeSinceLastInteraction >= INACTIVITY_THRESHOLD) {
      console.log(
        `⏱️ INACTIVIDAD DETECTADA [${conn.userName}]: ${Math.round(
          timeSinceLastInteraction / 1000
        )}s sin interacción`
      );

      conn.hasHadInteraction = false;
      if (conn.gemini && conn.gemini.readyState === WebSocket.OPEN) {
        console.log(`📌 Cerrando Gemini por inactividad [${conn.userName}]`);
        conn.gemini.close(1000, "Inactivity timeout");
      }
    }
  }, INACTIVITY_CHECK_INTERVAL);
}

// 🚀 Establecer conexión con Gemini
async function setupGeminiConnection(clientWs, userName) {
  console.log(`🔗 Iniciando conexión a Gemini para: ${userName}`);

  const geminiWs = await createGeminiConnection();

  let existingConnection = clientConnections.get(clientWs);
  const connectionData = {
    gemini: geminiWs,
    reconnectTimeout: null,
    connectionTimer: null,
    inactivityCheckInterval: null,
    lastInteractionTime: Date.now(),
    hasHadInteraction: false,
    reconnectCount: existingConnection
      ? existingConnection.reconnectCount + 1
      : 0,
    audioBuffers: [],
    currentVoice: existingConnection
      ? existingConnection.currentVoice
      : "Zephyr",
    isChangingVoice: false,
    userName: userName,
    clientId: existingConnection
      ? existingConnection.clientId
      : generateClientId(),
  };

  clientConnections.set(clientWs, connectionData);
  startInactivityCheck(clientWs);

  geminiWs.on("open", () => {
    console.log(`🎯 [${userName}] Conectado a Gemini`);
    const currentVoice = connectionData.currentVoice || "Zephyr";

    let systemText = `Eres un asistente amigable que responde en español de forma natural. El usuario se llama ${userName}.`;
    const setupMessage = {
      setup: {
        model: `models/${MODEL}`,
        generation_config: {
          response_modalities: ["AUDIO"],
          speech_config: {
            voice_config: {
              prebuilt_voice_config: { voice_name: currentVoice },
            },
          },
        },
        realtime_input_config: {
          automatic_activity_detection: {
            disabled: false, // TRUE = lo desactiva, FALSE = auto-VAD activo
            start_of_speech_sensitivity: "START_SENSITIVITY_HIGH",
            end_of_speech_sensitivity: "END_SENSITIVITY_HIGH",
            prefix_padding_ms: 250,
            silence_duration_ms: 400,
          },
        },
        system_instruction: {
          parts: [
            {
              text: `Eres un asistente amigable que responde en español de forma natural. El usuario se llama ${userName}.`,
            },
          ],
        },
      },
    };

    geminiWs.send(JSON.stringify(setupMessage));
    console.log(`🎵 [${userName}] Voz configurada: ${currentVoice}`);

    const connection = clientConnections.get(clientWs);
    if (connection) {
      clearTimeout(connection.connectionTimer);
      connection.connectionTimer = setTimeout(() => {
        console.log(`⏱️ [${userName}] Tiempo máximo alcanzado`);
        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.close(1000, "Connection time limit reached");
        }
      }, MAX_CONNECTION_TIME);
    }

    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        JSON.stringify({
          type: "ready",
          reconnectCount: connectionData.reconnectCount,
          currentVoice: currentVoice,
          userName: userName,
        })
      );
    }
  });

  geminiWs.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({ type: "gemini_response", data: message })
        );
      }
    } catch (error) {
      console.error(`❌ [${userName}] Error procesando mensaje:`, error);
    }
  });

  geminiWs.on("close", (code, reason) => {
    console.log(
      `📌 [${userName}] Gemini desconectado: ${code} - ${reason || "sin razón"}`
    );
  });

  geminiWs.on("error", (error) => {
    console.error(`❌ [${userName}] Error con Gemini:`, error.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        JSON.stringify({
          type: "error",
          message: `Error con Gemini: ${error.message}`,
        })
      );
    }
  });

  return geminiWs;
}

// 🆔 Generar ID único
function generateClientId() {
  return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// 💬 Conexión WebSocket principal
wss.on("connection", async (clientWs) => {
  const clientId = generateClientId();
  console.log(`📱 Cliente conectado [${clientId}] - Esperando nombre...`);

  const connectionData = {
    gemini: null,
    reconnectTimeout: null,
    connectionTimer: null,
    inactivityCheckInterval: null,
    lastInteractionTime: Date.now(),
    hasHadInteraction: false,
    reconnectCount: 0,
    audioBuffers: [],
    currentVoice: "Zephyr",
    isChangingVoice: false,
    userName: null,
    clientId: clientId,
    connectedAt: new Date().toISOString(),
  };

  clientConnections.set(clientWs, connectionData);

  clientWs.send(
    JSON.stringify({
      type: "waiting_for_name",
      message: "Esperando nombre de usuario para conectar...",
      clientId: clientId,
    })
  );

  clientWs.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());
      const connection = clientConnections.get(clientWs);
      if (!connection) return;

      // Recibir nombre
      if (data.type === "set_user_name") {
        const userName = data.name?.trim();
        if (userName) {
          connection.userName = userName;
          console.log(`👤 [${clientId}] Usuario: ${userName}`);
          await setupGeminiConnection(clientWs, userName);
        }
        return;
      }

      const geminiWs = connection.gemini;
      if (!geminiWs) return;

      if (data.type === "audio_chunk") {
        if (geminiWs.readyState === WebSocket.OPEN) {
          connection.lastInteractionTime = Date.now();
          connection.hasHadInteraction = true;

          geminiWs.send(
            JSON.stringify({
              realtime_input: {
                media_chunks: [{ mime_type: "audio/pcm", data: data.audio }],
              },
            })
          );
        }
      } else if (data.type === "turn_complete") {
        if (geminiWs.readyState === WebSocket.OPEN) {
          connection.lastInteractionTime = Date.now();
          connection.hasHadInteraction = true;
          geminiWs.send(JSON.stringify({ realtime_input: {} }));
        }
      } else if (data.type === "interrupt") {
        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify({ interrupt: {} }));
        }
      } else if (data.type === "change_voice") {
        const newVoice = data.voice;
        if (newVoice) {
          console.log(
            `🎵 [${connection.userName}] Cambio de voz a: ${newVoice}`
          );
          connection.currentVoice = newVoice;
          connection.isChangingVoice = true;
          if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close(1000, "Voice change requested");
          }
          setTimeout(async () => {
            connection.isChangingVoice = false;
            await setupGeminiConnection(clientWs, connection.userName);
          }, 1000);
        }
      } else if (data.type === "request_reconnect") {
        console.log(`🔄 [${connection.userName}] Reconexión manual solicitada`);
        connection.hasHadInteraction = true;
        connection.lastInteractionTime = Date.now();
        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.close(1000, "Manual reconnect requested");
        } else {
          await setupGeminiConnection(clientWs, connection.userName);
        }
      }
    } catch (error) {
      console.error("❌ Error procesando mensaje del cliente:", error);
    }
  });

  clientWs.on("close", () => {
    const connection = clientConnections.get(clientWs);
    console.log(
      `📴 Cliente desconectado [${connection?.userName || clientId}]`
    );
    if (connection?.inactivityCheckInterval)
      clearInterval(connection.inactivityCheckInterval);
    if (connection?.gemini?.readyState === WebSocket.OPEN) {
      connection.gemini.close();
    }
    clientConnections.delete(clientWs);
  });

  clientWs.on("error", (error) => {
    console.error(`❌ [${clientId}] Error en conexión:`, error.message);
  });
});

// 🩺 Health check
app.get("/health", (req, res) => {
  const connectionsInfo = [];
  clientConnections.forEach((conn) => {
    const timeSinceInteraction = Date.now() - conn.lastInteractionTime;
    connectionsInfo.push({
      clientId: conn.clientId,
      userName: conn.userName || "Sin nombre",
      geminiConnected: conn.gemini?.readyState === WebSocket.OPEN,
      reconnectCount: conn.reconnectCount,
      currentVoice: conn.currentVoice,
      hasHadInteraction: conn.hasHadInteraction,
      lastInteraction: new Date(conn.lastInteractionTime).toISOString(),
      timeSinceInteraction: Math.round(timeSinceInteraction / 1000) + "s",
      connectedAt: conn.connectedAt,
    });
  });

  res.json({
    status: "ok",
    connections: clientConnections.size,
    connectionsInfo,
    uptime: Math.round(process.uptime()) + "s",
  });
});

app.get("/", (req, res) => {
  res.status(200).send("🚀 Servidor activo con API Key (sin credentials.json)");
});

server.listen(PORT, () => {
  const renderUrl =
    process.env.RENDER_EXTERNAL_URL || "https://backendt-isi3.onrender.com";
  const wsUrl = renderUrl.replace("https://", "wss://");

  console.log(`🚀 Servidor WebSocket corriendo en puerto ${PORT}`);
  console.log(`🔗 Conectar Unity a: ${wsUrl}`);
  console.log(`🩺 Health check: ${renderUrl}/health`);
  console.log(`👥 Servidor multiusuario listo`);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Cerrando servidor...");
  clientConnections.forEach((c) => {
    if (c.inactivityCheckInterval) clearInterval(c.inactivityCheckInterval);
    if (c.gemini) c.gemini.close();
  });
  server.close(() => {
    console.log("✅ Servidor cerrado correctamente");
    process.exit(0);
  });
});
