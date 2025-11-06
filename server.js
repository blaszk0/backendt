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

// Mapa de conexiones por cliente
const clientConnections = new Map();

async function createGeminiConnection() {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_API_KEY) {
    throw new Error(
      "❌ GEMINI_API_KEY no está configurado en variables de entorno"
    );
  }

  const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

  console.log("✅ Usando API Key de Gemini");
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
        `⏱️ INACTIVIDAD DETECTADA [${conn.userName}]: ${Math.round(
          timeSinceLastInteraction / 1000
        )}s sin interacción`
      );

      conn.hasHadInteraction = false;

      if (conn.gemini && conn.gemini.readyState === WebSocket.OPEN) {
        console.log(`🔌 Cerrando Gemini por inactividad [${conn.userName}]`);
        conn.gemini.close(1000, "Inactivity timeout");
      }
    }
  }, INACTIVITY_CHECK_INTERVAL);
}

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
    isReconnecting: false,
    pendingAudioChunks: [], // 🔥 NUEVO: Buffer para audio durante reconexión
  };

  clientConnections.set(clientWs, connectionData);

  startInactivityCheck(clientWs);

  geminiWs.on("open", () => {
    console.log(
      `🎯 [${userName}] Conectado a Gemini (reconexión #${connectionData.reconnectCount})`
    );

    // 🔥 Resetear flag de reconexión
    const conn = clientConnections.get(clientWs);
    if (conn) {
      conn.isReconnecting = false;
    }

    const currentVoice = connectionData.currentVoice || "Zephyr";

    let systemText =
      "Eres un asistente amigable que responde en español de forma natural. ";
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
      if (connection.connectionTimer) {
        clearTimeout(connection.connectionTimer);
      }

      connection.connectionTimer = setTimeout(() => {
        console.log(
          `⏱️ [${userName}] Límite de tiempo alcanzado, programando reconexión...`
        );

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
      `🔌 [${userName}] Gemini desconectado: ${code} - ${reason || "sin razón"}`
    );
    const connection = clientConnections.get(clientWs);

    if (connection) {
      if (connection.connectionTimer) {
        clearTimeout(connection.connectionTimer);
        connection.connectionTimer = null;
      }

      // 🔥 Resetear flag de reconexión al cerrar
      connection.isReconnecting = false;
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
          `🔄 [${userName}] Reconectando... (última interacción hace ${Math.round(
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
          console.log(`🔄 [${userName}] Iniciando reconexión...`);
          try {
            await setupGeminiConnection(clientWs, connection.userName);
          } catch (error) {
            console.error(`❌ [${userName}] Error en reconexión:`, error);
          }
        }, 2000);
      } else {
        const reason = connection.isChangingVoice
          ? "cambio de voz"
          : !connection.hasHadInteraction
          ? "sin interacción"
          : `inactividad (${Math.round(timeSinceLastInteraction / 1000)}s)`;

        console.log(`⏸️ [${userName}] Conexión pausada por: ${reason}`);

        clientWs.send(
          JSON.stringify({
            type: "connection_paused",
            reason: reason,
            message: "Conexión pausada por inactividad. Habla para reconectar.",
          })
        );
      }
    }
  });

  geminiWs.on("error", (error) => {
    console.error(`❌ [${userName}] Error con Gemini:`, error.message);
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

function generateClientId() {
  return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

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
    isReconnecting: false, // 🔥 NUEVO
  };

  clientConnections.set(clientWs, connectionData);

  if (clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(
      JSON.stringify({
        type: "waiting_for_name",
        message: "Esperando nombre de usuario para conectar...",
        clientId: clientId,
      })
    );
  }

  clientWs.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());
      const connection = clientConnections.get(clientWs);
      if (!connection) return;

      // Recibir nombre y conectar
      if (data.type === "set_user_name") {
        const userName = data.name;
        if (userName && userName.trim()) {
          connection.userName = userName.trim();
          console.log(
            `👤 [${clientId}] Nombre recibido: ${connection.userName}`
          );

          try {
            console.log(
              `🚀 [${clientId}] Conectando a Gemini como: ${connection.userName}`
            );
            await setupGeminiConnection(clientWs, connection.userName);
          } catch (error) {
            console.error(`❌ [${clientId}] Error en conexión inicial:`, error);
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(
                JSON.stringify({
                  type: "error",
                  message: "Error al conectar con Gemini. Verifica tu API Key.",
                })
              );
            }
          }
        } else {
          console.log(`⚠️ [${clientId}] Nombre vacío recibido`);
        }
        return;
      }

      // 🔥 NUEVO: Mensaje de activación para reconectar
      if (data.type === "voice_activity_detected") {
        const geminiWs = connection.gemini;

        // Si Gemini no está conectado, reconectar
        if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) {
          // Evitar múltiples reconexiones simultáneas
          if (connection.isReconnecting) {
            console.log(
              `⏳ [${connection.userName}] Ya hay una reconexión en proceso, ignorando...`
            );
            return;
          }

          console.log(
            `🎤 [${connection.userName}] Actividad de voz detectada - Reconectando...`
          );

          connection.isReconnecting = true;
          connection.hasHadInteraction = true;
          connection.lastInteractionTime = Date.now();

          // Enviar notificación al cliente
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(
              JSON.stringify({
                type: "reconnecting",
                message: "Reconectando por actividad detectada...",
              })
            );
          }

          try {
            await setupGeminiConnection(clientWs, connection.userName);

            // Esperar que la conexión esté completamente lista
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Obtener la conexión actualizada
            const updatedConn = clientConnections.get(clientWs);
            const updatedGemini = updatedConn?.gemini;

            if (updatedGemini && updatedGemini.readyState === WebSocket.OPEN) {
              console.log(
                `✅ [${connection.userName}] Reconexión exitosa - Listo para recibir audio`
              );

              updatedConn.lastInteractionTime = Date.now();
              updatedConn.hasHadInteraction = true;
              updatedConn.isReconnecting = false;

              // Notificar al cliente que está listo
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(
                  JSON.stringify({
                    type: "reconnection_complete",
                    message: "Reconexión completada - Puedes hablar",
                  })
                );
              }
            } else {
              console.error(
                `❌ [${connection.userName}] Reconexión falló - Gemini no está listo`
              );
              connection.isReconnecting = false;

              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(
                  JSON.stringify({
                    type: "reconnection_failed",
                    message: "Reconexión falló, intenta de nuevo",
                  })
                );
              }
            }
          } catch (error) {
            console.error(
              `❌ [${connection.userName}] Error reconectando:`,
              error
            );
            connection.isReconnecting = false;

            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(
                JSON.stringify({
                  type: "error",
                  message: "Error al reconectar. Intenta de nuevo.",
                })
              );
            }
          }
        }
        return;
      }

      const geminiWs = connection.gemini;
      if (!geminiWs) {
        console.log(
          `⚠️ [${
            connection.userName || clientId
          }] Mensaje recibido pero Gemini no está conectado`
        );
        return;
      }

      if (data.type === "audio_chunk") {
        // Solo procesar audio si Gemini está conectado
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
        } else {
          // Si llega audio pero no hay conexión, ignorar silenciosamente
          // El cliente ya debería haber enviado "voice_activity_detected"
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
          console.log(
            `🎵 [${connection.userName}] Cambio de voz a: ${newVoice}`
          );

          connection.currentVoice = newVoice;
          connection.isChangingVoice = true;

          if (geminiWs.readyState === WebSocket.OPEN) {
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
            console.log(
              `🎵 [${connection.userName}] Reconectando con voz: ${newVoice}`
            );

            try {
              await setupGeminiConnection(clientWs, connection.userName);

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
              console.error(
                `❌ [${connection.userName}] Error cambiando voz:`,
                error
              );
            }
          }, 1000);
        }
      } else if (data.type === "request_reconnect") {
        console.log(`🔄 [${connection.userName}] Reconexión manual solicitada`);

        connection.hasHadInteraction = true;
        connection.lastInteractionTime = Date.now();

        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.close(1000, "Manual reconnect requested");
        } else {
          try {
            await setupGeminiConnection(clientWs, connection.userName);
          } catch (error) {
            console.error(
              `❌ [${connection.userName}] Error en reconexión manual:`,
              error
            );
          }
        }
      }
    } catch (error) {
      console.error("❌ Error procesando mensaje del cliente:", error);
    }
  });

  clientWs.on("close", () => {
    const connection = clientConnections.get(clientWs);
    const identifier = connection?.userName || clientId;
    console.log(`🔌 Cliente desconectado [${identifier}]`);

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
    const connection = clientConnections.get(clientWs);
    const identifier = connection?.userName || clientId;
    console.error(`❌ [${identifier}] Error en conexión:`, error.message);
  });
});

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
      willDisconnectIn: conn.hasHadInteraction
        ? Math.max(
            0,
            Math.round((INACTIVITY_THRESHOLD - timeSinceInteraction) / 1000)
          ) + "s"
        : "N/A",
      isChangingVoice: conn.isChangingVoice,
      isReconnecting: conn.isReconnecting, // 🔥 NUEVO
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
  console.log(`👥 Servidor multi-usuario activo`);
  console.log(`🔑 Usando API Key de Gemini (no OAuth)`);
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
