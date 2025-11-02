const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const cors = require("cors");
const { GoogleAuth } = require("google-auth-library");
const path = require("path");
require("dotenv").config();

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(
  __dirname,
  "credentials.json"
);

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  console.log("🔌 Solicitud de upgrade recibida (WebSocket)");
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

const MODEL = "gemini-2.5-flash-native-audio-preview-09-2025";
const PORT = process.env.PORT || 3000;

// ⚙️ CONFIGURACIÓN OPTIMIZADA PARA SESIONES ILIMITADAS
const PING_INTERVAL = 30000; // Ping cada 30s (keepalive suave)
const CONNECTION_REFRESH_TIME = 540000; // 9 minutos (antes de los 10 min de límite)
const PONG_TIMEOUT = 90000; // 90s sin pong = problema real
const MAX_RECONNECT_ATTEMPTS = 5; // Más intentos para casos extremos
const RECONNECT_DELAY = 2000; // 2 segundos (respuesta rápida)

const clientConnections = new Map();

// 🆕 Helper para códigos de cierre
function getCloseCodeInfo(code) {
  const codes = {
    1000: "Normal",
    1001: "Going Away",
    1002: "Protocol Error",
    1003: "Unsupported Data",
    1006: "Abnormal Closure",
    1008: "Policy Violation",
    1011: "Server Error",
    1015: "TLS Handshake",
  };
  return codes[code] || "Unknown";
}

async function getEphemeralToken() {
  try {
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    });

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    if (!accessToken.token) {
      throw new Error("No se pudo obtener token");
    }

    return accessToken.token;
  } catch (error) {
    console.error("❌ Error obteniendo token efímero:", error.message);
    return null;
  }
}

async function createGeminiConnection(useEphemeralToken = true) {
  let geminiUrl;
  let geminiWs;

  if (useEphemeralToken) {
    const token = await getEphemeralToken();

    if (token) {
      geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent`;
      geminiWs = new WebSocket(geminiUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      console.log("✅ Usando token efímero (OAuth)");
      return geminiWs;
    } else {
      console.log("⚠️ Token efímero no disponible, usando API Key...");
    }
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    throw new Error("No hay GEMINI_API_KEY ni credentials.json válidos");
  }

  geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
  console.log("✅ Usando API Key");
  return new WebSocket(geminiUrl);
}

function buildConversationHistory(conversationLog) {
  if (conversationLog.length === 0) return "";

  let history = "\n\n=== HISTORIAL DE CONVERSACIÓN PREVIA ===\n";
  conversationLog.forEach((entry) => {
    if (entry.role === "user") {
      history += `\n[Usuario dijo]: ${entry.text}\n`;
    } else if (entry.role === "assistant") {
      history += `[Tú respondiste]: ${entry.text}\n`;
    }
  });
  history += "\n=== FIN DEL HISTORIAL ===\n";
  history +=
    "IMPORTANTE: Continúa la conversación manteniendo coherencia con este historial. ";
  history +=
    "No repitas información ya discutida a menos que sea relevante.\n\n";

  return history;
}

// 🆕 FUNCIÓN MEJORADA CON SESSION RESUMPTION
async function setupGeminiConnection(
  clientWs,
  useEphemeralToken = true,
  reason = "initial",
  resumptionHandle = null
) {
  const geminiWs = await createGeminiConnection(useEphemeralToken);

  let existingConnection = clientConnections.get(clientWs);
  let conversationLog = existingConnection
    ? existingConnection.conversationLog
    : [];

  const connectionData = {
    gemini: geminiWs,
    reconnectTimeout: null,
    conversationLog: conversationLog,
    pingInterval: null,
    connectionRefreshTimer: null, // 🆕 Timer para refresh proactivo
    lastPong: Date.now(),
    lastPing: Date.now(),
    currentUserText: "",
    currentAssistantText: "",
    reconnectCount: existingConnection
      ? existingConnection.reconnectCount + 1
      : 0,
    audioBuffers: [],
    currentVoice: existingConnection
      ? existingConnection.currentVoice
      : "Zephyr",
    sessionStartTime: existingConnection
      ? existingConnection.sessionStartTime
      : Date.now(),
    connectionStartTime: Date.now(), // 🆕 Tiempo de esta conexión específica
    shouldReconnect: true,
    lastActivity: Date.now(),
    resumptionHandle: resumptionHandle || existingConnection?.resumptionHandle, // 🆕 Handle de reanudación
    isVoiceChanging: false, // 🆕 Flag para cambio de voz
  };

  clientConnections.set(clientWs, connectionData);

  geminiWs.on("open", () => {
    const sessionDuration = Date.now() - connectionData.sessionStartTime;
    const resumeInfo = resumptionHandle ? " (resumiendo sesión)" : "";
    console.log(
      `🔗 Conectado a Gemini API (${reason}, conexión #${
        connectionData.reconnectCount
      }, sesión total: ${Math.round(sessionDuration / 1000)}s)${resumeInfo}`
    );

    const currentVoice = connectionData.currentVoice || "Zephyr";
    const historyContext = buildConversationHistory(conversationLog);
    const systemText =
      "Eres un asistente amigable que responde en español de forma clara y concisa. " +
      "Mantén coherencia con el historial de conversación y evita repetir información ya discutida." +
      historyContext;

    // 🆕 CONFIGURACIÓN CON SESSION RESUMPTION Y CONTEXT COMPRESSION
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
        system_instruction: {
          parts: [{ text: systemText }],
        },
        // 🆕 Habilitar Session Resumption para sesiones ilimitadas
        session_resumption: resumptionHandle
          ? { handle: resumptionHandle }
          : {},
        // 🆕 Habilitar Context Window Compression para evitar límite de 15 min
        context_window_compression: {
          sliding_window: {},
          trigger_tokens: 30000, // Comprimir cuando se acerque al límite
        },
      },
    };

    geminiWs.send(JSON.stringify(setupMessage));
    console.log(
      `🎵 Voz: ${currentVoice} | 🔄 Session Resumption: ✓ | 🗜️ Compression: ✓`
    );

    if (conversationLog.length > 0) {
      console.log(
        `📜 Contexto: ${
          conversationLog.length
        } mensajes (${conversationLog.reduce(
          (acc, msg) => acc + msg.text.length,
          0
        )} chars)`
      );
    }

    const connection = clientConnections.get(clientWs);
    if (connection) {
      // Limpiar timers anteriores
      if (connection.pingInterval) clearInterval(connection.pingInterval);
      if (connection.connectionRefreshTimer)
        clearTimeout(connection.connectionRefreshTimer);

      // 🆕 KEEPALIVE SUAVE (30s)
      connection.pingInterval = setInterval(() => {
        if (geminiWs.readyState === WebSocket.OPEN) {
          const now = Date.now();
          connection.lastPing = now;
          geminiWs.ping();

          const timeSinceLastPong = now - connection.lastPong;
          if (timeSinceLastPong > PONG_TIMEOUT) {
            console.log(
              `⚠️ Sin pong por ${Math.round(
                timeSinceLastPong / 1000
              )}s - Reconectando...`
            );
            geminiWs.close(1000, "Ping timeout");
          }
        }
      }, PING_INTERVAL);

      // 🆕 REFRESH PROACTIVO DE CONEXIÓN (9 minutos)
      // Google cierra conexiones a los ~10 min, nosotros refrescamos a los 9
      connection.connectionRefreshTimer = setTimeout(() => {
        if (
          geminiWs.readyState === WebSocket.OPEN &&
          connection.shouldReconnect &&
          !connection.isVoiceChanging
        ) {
          console.log(
            "🔄 Refrescando conexión proactivamente (límite de 10 min)..."
          );
          geminiWs.close(1000, "Proactive connection refresh");
        }
      }, CONNECTION_REFRESH_TIME);
    }

    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        JSON.stringify({
          type: "ready",
          historyRestored: conversationLog.length > 0,
          reconnectCount: connectionData.reconnectCount,
          currentVoice: currentVoice,
          sessionResumptionEnabled: true,
        })
      );
    }
  });

  geminiWs.on("pong", () => {
    const connection = clientConnections.get(clientWs);
    if (connection) {
      connection.lastPong = Date.now();
      connection.lastActivity = Date.now();
    }
  });

  geminiWs.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      const connection = clientConnections.get(clientWs);

      if (!connection) return;
      connection.lastActivity = Date.now();

      // 🆕 CAPTURAR SESSION RESUMPTION HANDLE
      if (message.sessionResumptionUpdate) {
        const update = message.sessionResumptionUpdate;
        if (update.resumable && update.newHandle) {
          connection.resumptionHandle = update.newHandle;
          console.log("🔑 Session resumption handle actualizado");
        }
      }

      // 🆕 DETECTAR GOAWAY (advertencia de cierre inminente)
      if (message.goAway) {
        const timeLeft = message.goAway.timeLeft;
        console.log(`⏰ GoAway recibido: conexión se cerrará en ${timeLeft}`);
        // El servidor cerrará pronto, dejar que ocurra y usar resumption
      }

      if (message.serverContent) {
        if (message.serverContent.modelTurn) {
          const parts = message.serverContent.modelTurn.parts || [];
          parts.forEach((part) => {
            if (part.text) {
              connection.currentAssistantText += part.text;
            }
            if (
              part.inlineData?.mimeType === "text/plain" &&
              part.inlineData?.data
            ) {
              try {
                const decoded = Buffer.from(
                  part.inlineData.data,
                  "base64"
                ).toString("utf-8");
                connection.currentAssistantText += decoded;
              } catch (e) {}
            }
          });
        }

        if (message.serverContent.turnComplete) {
          if (connection.currentAssistantText.trim()) {
            const assistantText = connection.currentAssistantText.trim();
            connection.conversationLog.push({
              role: "assistant",
              text: assistantText,
              timestamp: Date.now(),
            });
            console.log(
              `💬 Asistente: "${assistantText.substring(0, 60)}${
                assistantText.length > 60 ? "..." : ""
              }"`
            );
            connection.currentAssistantText = "";

            // Mantener últimos 40 mensajes (~20 turnos)
            if (connection.conversationLog.length > 40) {
              const removed = connection.conversationLog.splice(
                0,
                connection.conversationLog.length - 40
              );
              console.log(
                `🗑️ Historial: eliminados ${removed.length} msgs antiguos`
              );
            }
          }
        }
      }

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({ type: "gemini_response", data: message })
        );
      }
    } catch (error) {
      console.error("❌ Error procesando mensaje:", error);
    }
  });

  // 🆕 MANEJO DE CIERRE INTELIGENTE
  geminiWs.on("close", (code, reason) => {
    const codeInfo = getCloseCodeInfo(code);
    console.log(
      `🔌 Gemini desconectado: ${code} (${codeInfo}) - ${reason || "sin razón"}`
    );

    const connection = clientConnections.get(clientWs);

    if (connection) {
      if (connection.pingInterval) {
        clearInterval(connection.pingInterval);
        connection.pingInterval = null;
      }
      if (connection.connectionRefreshTimer) {
        clearTimeout(connection.connectionRefreshTimer);
        connection.connectionRefreshTimer = null;
      }
    }

    // 🆕 LÓGICA DE RECONEXIÓN MEJORADA
    if (
      connection &&
      connection.shouldReconnect &&
      clientWs.readyState === WebSocket.OPEN
    ) {
      const connectionDuration = Date.now() - connection.connectionStartTime;
      const timeSinceActivity = Date.now() - connection.lastActivity;

      // No reconectar solo si hay MUCHA inactividad (>10 minutos)
      // o errores fatales
      const isPermanentError = [1008, 1003].includes(code);
      const tooMuchInactivity = timeSinceActivity > 600000; // 10 minutos

      if (
        connection.reconnectCount >= MAX_RECONNECT_ATTEMPTS ||
        isPermanentError ||
        tooMuchInactivity
      ) {
        const errorMsg = isPermanentError
          ? "Error permanente de API"
          : tooMuchInactivity
          ? "Inactividad prolongada (>10 min)"
          : `Demasiados intentos (${connection.reconnectCount})`;

        console.log(`⛔ No se reconectará: ${errorMsg}`);

        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(
            JSON.stringify({
              type: "session_expired",
              message:
                "Sesión finalizada. Recarga la aplicación para continuar.",
            })
          );
        }
        return;
      }

      // Reconexión normal o cambio de voz
      const isProactiveRefresh = reason === "Proactive connection refresh";
      const isVoiceChange = reason === "Voice change requested";

      console.log(
        `🔄 Reconectando en ${RECONNECT_DELAY / 1000}s (intento ${
          connection.reconnectCount + 1
        }/${MAX_RECONNECT_ATTEMPTS})...`
      );

      if (!isVoiceChange) {
        clientWs.send(
          JSON.stringify({
            type: "reconnecting",
            message: isProactiveRefresh
              ? "Refrescando conexión (mantenimiento automático)..."
              : `Reconectando... (${
                  connection.reconnectCount + 1
                }/${MAX_RECONNECT_ATTEMPTS})`,
            reconnectCount: connection.reconnectCount,
            reason: reason || "unknown",
          })
        );
      }

      connection.reconnectTimeout = setTimeout(async () => {
        console.log(
          `🔄 Iniciando reconexión ${
            connection.resumptionHandle
              ? "CON session resumption"
              : "sin resumption"
          }`
        );

        try {
          // 🆕 USAR RESUMPTION HANDLE SI ESTÁ DISPONIBLE
          await setupGeminiConnection(
            clientWs,
            true,
            isProactiveRefresh
              ? "proactive-refresh"
              : isVoiceChange
              ? "voice-change"
              : "auto-reconnect",
            connection.resumptionHandle
          );
        } catch (error) {
          console.error("❌ Error en reconexión:", error);
          // Retry sin resumption como fallback
          setTimeout(
            () => setupGeminiConnection(clientWs, false, "fallback", null),
            1000
          );
        }
      }, RECONNECT_DELAY);
    }
  });

  geminiWs.on("error", (error) => {
    console.error("❌ Error en Gemini:", error.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        JSON.stringify({
          type: "error",
          message: `Error: ${error.message}`,
        })
      );
    }
  });

  return geminiWs;
}

wss.on("connection", async (clientWs) => {
  console.log("👤 Cliente Unity conectado");

  try {
    await setupGeminiConnection(clientWs, true, "initial", null);
  } catch (error) {
    console.error("❌ Error en conexión inicial:", error);
    await setupGeminiConnection(clientWs, false, "fallback", null);
  }

  clientWs.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      const connection = clientConnections.get(clientWs);
      if (!connection || !connection.gemini) return;

      connection.lastActivity = Date.now();

      const geminiWs = connection.gemini;

      if (data.type === "audio_chunk") {
        if (geminiWs.readyState === WebSocket.OPEN) {
          connection.audioBuffers.push(data.audio);

          geminiWs.send(
            JSON.stringify({
              realtime_input: {
                media_chunks: [
                  {
                    mime_type: "audio/pcm",
                    data: data.audio,
                  },
                ],
              },
            })
          );
        }
      } else if (data.type === "turn_complete") {
        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify({ realtime_input: {} }));

          if (connection.currentUserText.trim()) {
            const userText = connection.currentUserText.trim();
            connection.conversationLog.push({
              role: "user",
              text: userText,
              timestamp: Date.now(),
            });
            console.log(
              `💬 Usuario: "${userText.substring(0, 60)}${
                userText.length > 60 ? "..." : ""
              }"`
            );
            connection.currentUserText = "";
          }

          connection.audioBuffers = [];
        }
      } else if (data.type === "interrupt") {
        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify({ interrupt: {} }));
        }
      } else if (data.type === "change_voice") {
        const newVoice = data.voice;
        if (newVoice) {
          console.log(`🎵 Cambio de voz solicitado: ${newVoice}`);
          connection.currentVoice = newVoice;
          connection.isVoiceChanging = true;
          connection.shouldReconnect = true;

          // Limpiar resumption handle (nueva voz = nueva configuración)
          connection.resumptionHandle = null;

          if (geminiWs.readyState === WebSocket.OPEN) {
            console.log(`🎵 Reconectando para aplicar voz: ${newVoice}`);
            geminiWs.close(1000, "Voice change requested");
          }

          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(
              JSON.stringify({
                type: "voice_changing",
                voice: newVoice,
                message: `Cambiando a voz ${newVoice}...`,
              })
            );
          }

          // Reset flag después de un momento
          setTimeout(() => {
            if (connection) connection.isVoiceChanging = false;
          }, 5000);
        }
      } else if (data.type === "clear_history") {
        connection.conversationLog = [];
        connection.currentUserText = "";
        connection.currentAssistantText = "";
        connection.audioBuffers = [];
        connection.resumptionHandle = null; // Limpiar también el handle
        console.log("🗑️ Historial y sesión limpiados");
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: "history_cleared" }));
        }
      } else if (data.type === "user_transcript") {
        if (data.text) {
          connection.currentUserText += " " + data.text;
          console.log(`📝 Transcripción: "${data.text}"`);
        }
      } else if (data.type === "keep_alive") {
        connection.lastActivity = Date.now();
      }
    } catch (error) {
      console.error("❌ Error procesando mensaje del cliente:", error);
    }
  });

  clientWs.on("close", () => {
    console.log("👋 Cliente Unity desconectado");
    const connection = clientConnections.get(clientWs);
    if (connection) {
      connection.shouldReconnect = false;

      if (connection.reconnectTimeout)
        clearTimeout(connection.reconnectTimeout);
      if (connection.pingInterval) clearInterval(connection.pingInterval);
      if (connection.connectionRefreshTimer)
        clearTimeout(connection.connectionRefreshTimer);
      if (
        connection.gemini &&
        connection.gemini.readyState === WebSocket.OPEN
      ) {
        connection.gemini.close(1000, "Client disconnected");
      }
      clientConnections.delete(clientWs);
    }
  });

  clientWs.on("error", (error) => {
    console.error("❌ Error con cliente:", error.message);
  });
});

app.get("/health", (req, res) => {
  const connectionsInfo = [];
  clientConnections.forEach((conn) => {
    const historySize = conn.conversationLog.reduce(
      (acc, msg) => acc + msg.text.length,
      0
    );
    const sessionDuration = Date.now() - conn.sessionStartTime;
    const connectionDuration = Date.now() - conn.connectionStartTime;
    const timeSinceActivity = Date.now() - conn.lastActivity;

    connectionsInfo.push({
      messagesInHistory: conn.conversationLog.length,
      historySizeChars: historySize,
      reconnectCount: conn.reconnectCount,
      currentVoice: conn.currentVoice,
      sessionDurationMins: Math.round(sessionDuration / 60000),
      connectionDurationMins: Math.round(connectionDuration / 60000),
      timeSinceActivitySecs: Math.round(timeSinceActivity / 1000),
      geminiConnected: conn.gemini?.readyState === WebSocket.OPEN,
      hasResumptionHandle: !!conn.resumptionHandle,
      shouldReconnect: conn.shouldReconnect,
    });
  });

  res.json({
    status: "ok",
    connections: clientConnections.size,
    connectionsInfo,
    uptimeHours: Math.round(process.uptime() / 3600),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

app.get("/", (req, res) => {
  res.status(200).send("🟢 Servidor con Sesiones Ilimitadas activo");
});

server.listen(PORT, () => {
  const renderUrl =
    process.env.RENDER_EXTERNAL_URL || "https://backendt-isi3.onrender.com";
  const wsUrl = renderUrl.replace("https://", "wss://");

  console.log(`🚀 Servidor WebSocket con Session Resumption`);
  console.log(`📡 URL: ${wsUrl}`);
  console.log(`🩺 Health: ${renderUrl}/health`);
  console.log(`⏰ Refresh automático cada 9 minutos`);
  console.log(`🔄 Session Resumption habilitado`);
  console.log(`🗜️ Context Compression habilitado`);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Cerrando servidor...");
  clientConnections.forEach((connection) => {
    connection.shouldReconnect = false;
    if (connection.reconnectTimeout) clearTimeout(connection.reconnectTimeout);
    if (connection.pingInterval) clearInterval(connection.pingInterval);
    if (connection.connectionRefreshTimer)
      clearTimeout(connection.connectionRefreshTimer);
    if (connection.gemini) connection.gemini.close();
  });
  server.close(() => {
    console.log("✅ Servidor cerrado");
    process.exit(0);
  });
});
