const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const cors = require("cors");
const { GoogleAuth } = require("google-auth-library");
const path = require("path");
require("dotenv").config();

// Configurar ruta a credentials.json
process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(
  __dirname,
  "credentials.json"
);

const app = express();
app.use(cors()); // ✅ habilitar CORS para Render y Unity

// --- NUEVO BLOQUE --- habilita "upgrade" explícitamente
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true }); // 👈 noServer

server.on("upgrade", (request, socket, head) => {
  console.log("🔍 Solicitud de upgrade recibida (WebSocket)");
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

const MODEL = "gemini-2.5-flash-native-audio-preview-09-2025";
const PORT = process.env.PORT || 3000;
const PING_INTERVAL = 20000; // Ping cada 20 segundos (más agresivo)
const PONG_TIMEOUT = 45000; // 45 segundos sin pong = reconectar

// Almacenar conexiones cliente-Gemini con historial
const clientConnections = new Map();

// Función para obtener token efímero
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

// Función para crear conexión con Gemini
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

  // Fallback a API Key
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    throw new Error("No hay GEMINI_API_KEY ni credentials.json válidos");
  }

  geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
  console.log("✅ Usando API Key");
  return new WebSocket(geminiUrl);
}

// Construir historial de conversación como texto
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

// Función para reconectar Gemini automáticamente
async function setupGeminiConnection(clientWs, useEphemeralToken = true) {
  const geminiWs = await createGeminiConnection(useEphemeralToken);

  // Obtener conexión existente para mantener historial
  let existingConnection = clientConnections.get(clientWs);
  let conversationLog = existingConnection
    ? existingConnection.conversationLog
    : [];

  const connectionData = {
    gemini: geminiWs,
    reconnectTimeout: null,
    conversationLog: conversationLog,
    pingInterval: null,
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
      : "Zephyr", // 🎵 Mantener voz actual
  };

  clientConnections.set(clientWs, connectionData);

  // Cuando Gemini se conecta, enviar setup
  geminiWs.on("open", () => {
    console.log(
      `🔗 Conectado a Gemini API (reconexión #${connectionData.reconnectCount})`
    );

    // 🎵 Obtener voz actual (por defecto "Zephyr")
    const currentVoice = connectionData.currentVoice || "Zephyr";

    // Construir system instruction con historial
    const historyContext = buildConversationHistory(conversationLog);
    const systemText =
      "Eres un asistente amigable que responde en español de forma clara y concisa. " +
      "Mantén coherencia con el historial de conversación y evita repetir información ya discutida." +
      historyContext;

    const setupMessage = {
      setup: {
        model: `models/${MODEL}`,
        generation_config: {
          response_modalities: ["AUDIO"],
          speech_config: {
            voice_config: {
              prebuilt_voice_config: { voice_name: currentVoice }, // 🎵 Usar voz actual
            },
          },
        },
        system_instruction: {
          parts: [
            {
              text: systemText,
            },
          ],
        },
      },
    };

    geminiWs.send(JSON.stringify(setupMessage));
    console.log(`🎵 Voz configurada: ${currentVoice}`);

    if (conversationLog.length > 0) {
      console.log(
        `📜 Contexto restaurado: ${
          conversationLog.length
        } mensajes (${conversationLog.reduce(
          (acc, msg) => acc + msg.text.length,
          0
        )} caracteres)`
      );
    }

    // Configurar keep-alive con ping/pong más agresivo
    const connection = clientConnections.get(clientWs);
    if (connection) {
      connection.pingInterval = setInterval(() => {
        if (geminiWs.readyState === WebSocket.OPEN) {
          const now = Date.now();
          connection.lastPing = now;

          // Enviar ping nativo de WebSocket
          geminiWs.ping();

          // Verificar si hace mucho que no recibimos respuesta
          const timeSinceLastPong = now - connection.lastPong;
          if (timeSinceLastPong > PONG_TIMEOUT) {
            console.log(
              `⚠️ Sin respuesta de Gemini por ${Math.round(
                timeSinceLastPong / 1000
              )}s, forzando reconexión...`
            );
            geminiWs.close(1000, "Ping timeout");
          } else {
            console.log(
              `💓 Ping enviado (último pong hace ${Math.round(
                timeSinceLastPong / 1000
              )}s)`
            );
          }
        }
      }, PING_INTERVAL);
    }

    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        JSON.stringify({
          type: "ready",
          historyRestored: conversationLog.length > 0,
          reconnectCount: connectionData.reconnectCount,
          currentVoice: currentVoice, // 🎵 Informar voz actual
        })
      );
    }
  });

  // Manejar pong de Gemini
  geminiWs.on("pong", () => {
    const connection = clientConnections.get(clientWs);
    if (connection) {
      connection.lastPong = Date.now();
      const pingTime = connection.lastPong - connection.lastPing;
      console.log(`💚 Pong recibido (latencia: ${pingTime}ms)`);
    }
  });

  // Reenviar mensajes de Gemini al cliente Unity
  geminiWs.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      const connection = clientConnections.get(clientWs);

      if (!connection) return;

      // Capturar transcripciones de texto del asistente
      if (message.serverContent) {
        if (message.serverContent.modelTurn) {
          const parts = message.serverContent.modelTurn.parts || [];
          parts.forEach((part) => {
            if (part.text) {
              connection.currentAssistantText += part.text;
            }
            // También intentar capturar de inlineData si existe
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
              } catch (e) {
                // Ignorar errores de decodificación
              }
            }
          });
        }

        // Cuando termina el turno del modelo, guardar en historial
        if (message.serverContent.turnComplete) {
          if (connection.currentAssistantText.trim()) {
            const assistantText = connection.currentAssistantText.trim();
            connection.conversationLog.push({
              role: "assistant",
              text: assistantText,
              timestamp: Date.now(),
            });
            console.log(
              `💬 Asistente: "${assistantText.substring(0, 80)}${
                assistantText.length > 80 ? "..." : ""
              }"`
            );
            connection.currentAssistantText = "";

            // Limitar historial a últimos 30 mensajes (~15 turnos)
            if (connection.conversationLog.length > 30) {
              const removed = connection.conversationLog.splice(
                0,
                connection.conversationLog.length - 30
              );
              console.log(
                `🗑️ Historial recortado: eliminados ${removed.length} mensajes antiguos`
              );
            }
          }
        }
      }

      // Enviar mensaje completo a Unity
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({ type: "gemini_response", data: message })
        );
      }
    } catch (error) {
      console.error("❌ Error procesando mensaje de Gemini:", error);
    }
  });

  // Manejar cierre de Gemini y reconectar
  geminiWs.on("close", (code, reason) => {
    console.log(`🔌 Gemini desconectado: ${code} - ${reason || "sin razón"}`);
    const connection = clientConnections.get(clientWs);

    if (connection && connection.pingInterval) {
      clearInterval(connection.pingInterval);
      connection.pingInterval = null;
    }

    if (connection && clientWs.readyState === WebSocket.OPEN) {
      console.log("🔄 Programando reconexión en 3 segundos...");
      clientWs.send(
        JSON.stringify({
          type: "reconnecting",
          message: `Reconectando a Gemini... (intento ${
            connection.reconnectCount + 1
          })`,
          reconnectCount: connection.reconnectCount,
        })
      );

      connection.reconnectTimeout = setTimeout(async () => {
        console.log("🔄 Iniciando reconexión...");
        try {
          await setupGeminiConnection(clientWs, true); // Intentar con OAuth primero
        } catch (error) {
          console.error("❌ Error en reconexión:", error);
          // Intentar una vez más con API Key
          setTimeout(() => setupGeminiConnection(clientWs, false), 2000);
        }
      }, 3000);
    }
  });

  // Manejar errores
  geminiWs.on("error", (error) => {
    console.error("❌ Error en conexión con Gemini:", error.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        JSON.stringify({
          type: "error",
          message: `Error en conexión con Gemini: ${error.message}`,
        })
      );
    }
  });

  return geminiWs;
}

// Conexión del cliente Unity
wss.on("connection", async (clientWs) => {
  console.log("👤 Cliente Unity conectado");

  try {
    await setupGeminiConnection(clientWs, true); // Intentar OAuth primero
  } catch (error) {
    console.error("❌ Error en conexión inicial:", error);
    await setupGeminiConnection(clientWs, false); // Fallback a API Key
  }

  clientWs.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      const connection = clientConnections.get(clientWs);
      if (!connection || !connection.gemini) return;

      const geminiWs = connection.gemini;

      if (data.type === "audio_chunk") {
        if (geminiWs.readyState === WebSocket.OPEN) {
          // Guardar audio para posible transcripción futura
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

          // Guardar texto del usuario si existe
          if (connection.currentUserText.trim()) {
            const userText = connection.currentUserText.trim();
            connection.conversationLog.push({
              role: "user",
              text: userText,
              timestamp: Date.now(),
            });
            console.log(
              `💬 Usuario: "${userText.substring(0, 80)}${
                userText.length > 80 ? "..." : ""
              }"`
            );
            connection.currentUserText = "";
          }

          // Limpiar buffers de audio
          connection.audioBuffers = [];
        }
      } else if (data.type === "interrupt") {
        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify({ interrupt: {} }));
        }
      } else if (data.type === "change_voice") {
        // 🎵 NUEVO: Manejar cambio de voz
        const newVoice = data.voice;
        if (newVoice) {
          console.log(`🎵 Solicitud de cambio de voz a: ${newVoice}`);
          connection.currentVoice = newVoice;

          // Forzar reconexión con la nueva voz
          if (geminiWs.readyState === WebSocket.OPEN) {
            console.log(
              `🎵 Cerrando conexión actual para aplicar nueva voz...`
            );
            geminiWs.close(1000, "Voice change requested");
          }

          // Enviar confirmación al cliente
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(
              JSON.stringify({
                type: "voice_changed",
                voice: newVoice,
                message: `Cambiando voz a ${newVoice}...`,
              })
            );
          }
        }
      } else if (data.type === "clear_history") {
        connection.conversationLog = [];
        connection.currentUserText = "";
        connection.currentAssistantText = "";
        connection.audioBuffers = [];
        console.log("🗑️ Historial limpiado manualmente");
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: "history_cleared" }));
        }
      } else if (data.type === "user_transcript") {
        // Unity puede enviar transcripciones manuales
        if (data.text) {
          connection.currentUserText += " " + data.text;
          console.log(`📝 Transcripción recibida: "${data.text}"`);
        }
      }
    } catch (error) {
      console.error("❌ Error procesando mensaje del cliente:", error);
    }
  });

  clientWs.on("close", () => {
    console.log("👋 Cliente Unity desconectado");
    const connection = clientConnections.get(clientWs);
    if (connection) {
      if (connection.reconnectTimeout)
        clearTimeout(connection.reconnectTimeout);
      if (connection.pingInterval) clearInterval(connection.pingInterval);
      if (
        connection.gemini &&
        connection.gemini.readyState === WebSocket.OPEN
      ) {
        connection.gemini.close();
      }
      clientConnections.delete(clientWs);
    }
  });

  clientWs.on("error", (error) => {
    console.error("❌ Error en conexión con cliente:", error.message);
  });
});

// Endpoint de salud con info detallada de historial
app.get("/health", (req, res) => {
  const connectionsInfo = [];
  clientConnections.forEach((conn) => {
    const historySize = conn.conversationLog.reduce(
      (acc, msg) => acc + msg.text.length,
      0
    );
    connectionsInfo.push({
      messagesInHistory: conn.conversationLog.length,
      historySizeChars: historySize,
      reconnectCount: conn.reconnectCount,
      currentVoice: conn.currentVoice, // 🎵 Mostrar voz actual
      lastPong: new Date(conn.lastPong).toISOString(),
      timeSinceLastPong: Math.round((Date.now() - conn.lastPong) / 1000) + "s",
      geminiConnected: conn.gemini?.readyState === WebSocket.OPEN,
    });
  });

  res.json({
    status: "ok",
    connections: clientConnections.size,
    connectionsInfo,
    uptime: Math.round(process.uptime()) + "s",
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
  });
});

// ✅ NUEVO ENDPOINT raíz
app.get("/", (req, res) => {
  res.status(200).send("🟢 Servidor activo y listo para WebSocket");
});

server.listen(PORT, () => {
  const renderUrl =
    process.env.RENDER_EXTERNAL_URL || "https://backendt-isi3.onrender.com";
  const wsUrl = renderUrl.replace("https://", "wss://");

  console.log(`🚀 Servidor WebSocket corriendo en puerto ${PORT}`);
  console.log(`📡 Conectar Unity a: ${wsUrl}`);
  console.log(`🩺 Health check: ${renderUrl}/health`);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Cerrando servidor...");
  clientConnections.forEach((connection) => {
    if (connection.reconnectTimeout) clearTimeout(connection.reconnectTimeout);
    if (connection.pingInterval) clearInterval(connection.pingInterval);
    if (connection.gemini) connection.gemini.close();
  });
  server.close(() => {
    console.log("✅ Servidor cerrado correctamente");
    process.exit(0);
  });
});
