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
const MAX_CONNECTION_TIME = 13 * 60 * 1000;
const INACTIVITY_THRESHOLD = 3 * 60 * 1000;
const INACTIVITY_CHECK_INTERVAL = 30 * 1000;

const clientConnections = new Map();

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
        `⏱️ INACTIVIDAD DETECTADA: ${Math.round(
          timeSinceLastInteraction / 1000
        )}s sin interacción`
      );

      conn.hasHadInteraction = false;

      if (conn.gemini && conn.gemini.readyState === WebSocket.OPEN) {
        console.log("🔌 Cerrando Gemini por inactividad...");
        conn.gemini.close(1000, "Inactivity timeout");
      }
    }
  }, INACTIVITY_CHECK_INTERVAL);
}

async function setupGeminiConnection(
  clientWs,
  userName,
  useEphemeralToken = true
) {
  console.log(`🔗 Iniciando conexión a Gemini para usuario: ${userName}`);

  const geminiWs = await createGeminiConnection(useEphemeralToken);

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
    userName: userName, // 🔥 GUARDAR NOMBRE
  };

  clientConnections.set(clientWs, connectionData);

  startInactivityCheck(clientWs);

  geminiWs.on("open", () => {
    console.log(
      `🎯 Conectado a Gemini API para ${userName} (reconexión #${connectionData.reconnectCount})`
    );

    const currentVoice = connectionData.currentVoice || "Zephyr";

    // 🔥 SYSTEM INSTRUCTION CON NOMBRE
    let systemText =
      "Eres un asistente amigable que responde en español de forma clara y concisa. ";
    systemText += `El usuario se llama ${userName}. Úsalo naturalmente en la conversación cuando sea apropiado.`;

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
      },
    };

    geminiWs.send(JSON.stringify(setupMessage));
    console.log(`🎵 Voz configurada: ${currentVoice}`);
    console.log(`👤 Sistema configurado para: ${userName}`);

    const connection = clientConnections.get(clientWs);
    if (connection) {
      if (connection.connectionTimer) {
        clearTimeout(connection.connectionTimer);
      }

      connection.connectionTimer = setTimeout(() => {
        console.log(
          `⏱️ Límite de tiempo alcanzado (${
            MAX_CONNECTION_TIME / 60000
          } min), programando reconexión...`
        );

        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.close(1000, "Connection time limit reached");
        }
      }, MAX_CONNECTION_TIME);

      console.log(
        `⏱️ Timer de conexión configurado: ${
          MAX_CONNECTION_TIME / 60000
        } minutos`
      );
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
      console.error("❌ Error procesando mensaje de Gemini:", error);
    }
  });

  geminiWs.on("close", (code, reason) => {
    console.log(`🔌 Gemini desconectado: ${code} - ${reason || "sin razón"}`);
    const connection = clientConnections.get(clientWs);

    if (connection) {
      if (connection.connectionTimer) {
        clearTimeout(connection.connectionTimer);
        connection.connectionTimer = null;
      }
    }

    if (connection && clientWs.readyState === WebSocket.OPEN) {
      const timeSinceLastInteraction =
        Date.now() - connection.lastInteractionTime;
      const shouldReconnect =
        connection.hasHadInteraction &&
        timeSinceLastInteraction < INACTIVITY_THRESHOLD &&
        !connection.isChangingVoice;

      if (shouldReconnect) {
        console.log(
          `🔄 Reconectando... (última interacción hace ${Math.round(
            timeSinceLastInteraction / 1000
          )}s)`
        );

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
            await setupGeminiConnection(clientWs, connection.userName, true);
          } catch (error) {
            console.error("❌ Error en reconexión:", error);
            setTimeout(
              () => setupGeminiConnection(clientWs, connection.userName, false),
              2000
            );
          }
        }, 2000);
      } else {
        const reason = connection.isChangingVoice
          ? "cambio de voz"
          : !connection.hasHadInteraction
          ? "sin interacción"
          : `inactividad (${Math.round(timeSinceLastInteraction / 1000)}s)`;

        console.log(`⏸️ NO se reconectará: ${reason}`);

        clientWs.send(
          JSON.stringify({
            type: "connection_paused",
            reason: reason,
            message: "Conexión pausada. Habla para reconectar.",
          })
        );
      }
    }
  });

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

wss.on("connection", async (clientWs) => {
  console.log("📱 Cliente Unity conectado - Esperando nombre de usuario...");

  // 🔥 NO CONECTAR A GEMINI TODAVÍA - Solo crear entrada en el mapa
  const connectionData = {
    gemini: null, // Sin conexión todavía
    reconnectTimeout: null,
    connectionTimer: null,
    inactivityCheckInterval: null,
    lastInteractionTime: Date.now(),
    hasHadInteraction: false,
    reconnectCount: 0,
    audioBuffers: [],
    currentVoice: "Zephyr",
    isChangingVoice: false,
    userName: null, // Sin nombre todavía
  };

  clientConnections.set(clientWs, connectionData);

  // 🔥 ENVIAR MENSAJE INDICANDO QUE ESTÁ ESPERANDO NOMBRE
  if (clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(
      JSON.stringify({
        type: "waiting_for_name",
        message: "Esperando nombre de usuario para conectar...",
      })
    );
  }

  clientWs.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());
      const connection = clientConnections.get(clientWs);
      if (!connection) return;

      // 🔥 RECIBIR NOMBRE Y CONECTAR A GEMINI
      if (data.type === "set_user_name") {
        const userName = data.name;
        if (userName && userName.trim()) {
          connection.userName = userName.trim();
          console.log(`👤 Nombre recibido: ${connection.userName}`);

          // 🔥 AHORA SÍ CONECTAR A GEMINI
          try {
            console.log(
              `🚀 Conectando a Gemini con nombre: ${connection.userName}`
            );
            await setupGeminiConnection(clientWs, connection.userName, true);
          } catch (error) {
            console.error("❌ Error en conexión inicial:", error);
            await setupGeminiConnection(clientWs, connection.userName, false);
          }
        } else {
          console.log("⚠️ Nombre vacío recibido");
        }
        return;
      }

      // 🔥 VERIFICAR QUE GEMINI ESTÉ CONECTADO ANTES DE PROCESAR OTROS MENSAJES
      const geminiWs = connection.gemini;
      if (!geminiWs) {
        console.log("⚠️ Mensaje recibido pero Gemini no está conectado aún");
        return;
      }

      if (data.type === "audio_chunk") {
        if (geminiWs.readyState === WebSocket.OPEN) {
          connection.lastInteractionTime = Date.now();
          connection.hasHadInteraction = true;

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
          connection.lastInteractionTime = Date.now();
          connection.hasHadInteraction = true;

          geminiWs.send(JSON.stringify({ realtime_input: {} }));
          connection.audioBuffers = [];
        }
      } else if (data.type === "interrupt") {
        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify({ interrupt: {} }));
        }
      } else if (data.type === "change_voice") {
        const newVoice = data.voice;
        if (newVoice) {
          console.log(`🎵 Solicitud de cambio de voz a: ${newVoice}`);

          connection.currentVoice = newVoice;
          connection.isChangingVoice = true;

          if (geminiWs.readyState === WebSocket.OPEN) {
            console.log(`🎵 Aplicando cambio de voz...`);
            geminiWs.close(1000, "Voice change requested");
          }

          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(
              JSON.stringify({
                type: "voice_changing",
                voice: newVoice,
                message: `Cambiando voz a ${newVoice}...`,
              })
            );
          }

          setTimeout(async () => {
            connection.isChangingVoice = false;
            console.log(`🎵 Reconectando con voz: ${newVoice}`);

            try {
              await setupGeminiConnection(clientWs, connection.userName, true);

              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(
                  JSON.stringify({
                    type: "voice_changed",
                    voice: newVoice,
                    message: `Voz cambiada a ${newVoice}`,
                  })
                );
              }
            } catch (error) {
              console.error("❌ Error cambiando voz:", error);
              setTimeout(
                () =>
                  setupGeminiConnection(clientWs, connection.userName, false),
                2000
              );
            }
          }, 1000);
        }
      } else if (data.type === "request_reconnect") {
        console.log("🔄 Cliente solicita reconexión manual");

        connection.hasHadInteraction = true;
        connection.lastInteractionTime = Date.now();

        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.close(1000, "Manual reconnect requested");
        } else {
          try {
            await setupGeminiConnection(clientWs, connection.userName, true);
          } catch (error) {
            console.error("❌ Error en reconexión manual:", error);
            setTimeout(
              () => setupGeminiConnection(clientWs, connection.userName, false),
              2000
            );
          }
        }
      }
    } catch (error) {
      console.error("❌ Error procesando mensaje del cliente:", error);
    }
  });

  clientWs.on("close", () => {
    console.log("🔌 Cliente Unity desconectado");
    const connection = clientConnections.get(clientWs);
    if (connection) {
      if (connection.reconnectTimeout)
        clearTimeout(connection.reconnectTimeout);
      if (connection.connectionTimer) clearTimeout(connection.connectionTimer);
      if (connection.inactivityCheckInterval)
        clearInterval(connection.inactivityCheckInterval);
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

app.get("/health", (req, res) => {
  const connectionsInfo = [];
  clientConnections.forEach((conn) => {
    const timeSinceInteraction = Date.now() - conn.lastInteractionTime;

    connectionsInfo.push({
      userName: conn.userName || "Esperando nombre",
      geminiConnected: conn.gemini?.readyState === WebSocket.OPEN,
      reconnectCount: conn.reconnectCount,
      currentVoice: conn.currentVoice,
      hasHadInteraction: conn.hasHadInteraction,
      lastInteraction: new Date(conn.lastInteractionTime).toISOString(),
      timeSinceInteraction: Math.round(timeSinceInteraction / 1000) + "s",
      willDisconnectIn: conn.hasHadInteraction
        ? Math.max(
            0,
            Math.round((INACTIVITY_THRESHOLD - timeSinceInteraction) / 1000)
          ) + "s"
        : "N/A",
      isChangingVoice: conn.isChangingVoice,
    });
  });

  res.json({
    status: "ok",
    connections: clientConnections.size,
    connectionsInfo,
    uptime: Math.round(process.uptime()) + "s",
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
    config: {
      maxConnectionTime: MAX_CONNECTION_TIME / 60000 + " min",
      inactivityThreshold: INACTIVITY_THRESHOLD / 60000 + " min",
      inactivityCheckInterval: INACTIVITY_CHECK_INTERVAL / 1000 + "s",
    },
  });
});

app.get("/", (req, res) => {
  res.status(200).send("🚀 Servidor activo y listo para WebSocket");
});

server.listen(PORT, () => {
  const renderUrl =
    process.env.RENDER_EXTERNAL_URL || "https://backendt-isi3.onrender.com";
  const wsUrl = renderUrl.replace("https://", "wss://");

  console.log(`🚀 Servidor WebSocket corriendo en puerto ${PORT}`);
  console.log(`🔗 Conectar Unity a: ${wsUrl}`);
  console.log(`🩺 Health check: ${renderUrl}/health`);
  console.log(
    `⏱️ Desconexión por inactividad: ${INACTIVITY_THRESHOLD / 60000} min`
  );
});

process.on("SIGINT", () => {
  console.log("\n🛑 Cerrando servidor...");
  clientConnections.forEach((connection) => {
    if (connection.reconnectTimeout) clearTimeout(connection.reconnectTimeout);
    if (connection.connectionTimer) clearTimeout(connection.connectionTimer);
    if (connection.inactivityCheckInterval)
      clearInterval(connection.inactivityCheckInterval);
    if (connection.gemini) connection.gemini.close();
  });
  server.close(() => {
    console.log("✅ Servidor cerrado correctamente");
    process.exit(0);
  });
});
