// src/voice/useRealtimeVoice.ts
// Hook de VOZ vía WebRTC + tu bridge /realtime/* (instancia única persistente)
// - PTT (start/stop/toggle) + Latch
// - Transcripción por eventos del Realtime API → onUserText(...)
// - TTS: speak(text)
// - SIN Web Speech API

import { useEffect, useRef } from "react";

export type VoiceApi = {
  connect: () => Promise<void>;
  speak: (text: string) => void;

  startListening: () => void;
  stopListening: () => void;
  toggleListening: () => void;

  enableLatch: () => void;
  disableLatch: () => void;
  toggleLatch: () => void;

  cancelCurrentTurn: () => void;

  readonly connected: boolean;
  readonly listening: boolean;
  readonly latch: boolean;

  attachAudioElement?: (el: HTMLAudioElement | null) => void;
  setAudioElement?: (el: HTMLAudioElement | null) => void;
};

type Opts = {
  onUserText: (text: string) => Promise<void> | void;
  bridgeBase?: string;
  audioElId?: string;
  onListeningChange?: (listening: boolean) => void;
  pttMaxMs?: number;
  beeps?: boolean;
  onError?: (e: any) => void;
};

type Internal = {
  // estado webrtc
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  micStream: MediaStream | null;

  // flags
  connected: boolean;
  connecting: boolean;
  listening: boolean;
  latch: boolean;
  pttTimer: number | null;

  // salida
  audioOutEl: HTMLAudioElement | null;

  // turnos / dedupe
  textBuf: string;
  currentTurnNonce: number;
  cancelled: Set<number>;
  seenUtterIds: Set<string>;
  recentTexts: Array<{ t: number; txt: string }>;

  // helpers de opciones (refs a callbacks “vivas”)
  optsRef: React.MutableRefObject<Required<Omit<Opts, "bridgeBase" | "audioElId">> & {
    bridgeBase: string;
  }>;

  // api (se rellena al final)
  api!: VoiceApi;
};

// ---- helpers “puros” (fuera de React) ----
const log = (...a: any[]) => console.log("[voice]", ...a);
const sanitize = (s: string) => (s || "").replace(/[¡!¿?]+/g, "").replace(/\s+/g, " ").trim();

function makeBeep(enabled: boolean) {
  return (f = 1175, ms = 60) => {
    if (!enabled) return;
    try {
      const ACX = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!ACX) return;
      const acx = new ACX();
      const osc = acx.createOscillator();
      const g = acx.createGain();
      g.gain.value = 0.08;
      osc.type = "sine";
      osc.frequency.value = f;
      osc.connect(g).connect(acx.destination);
      osc.start();
      setTimeout(() => {
        try { osc.stop(); } catch {}
        try { osc.disconnect(); g.disconnect(); acx.close(); } catch {}
      }, ms);
    } catch {}
  };
}

function isRecentTextPush(arr: Array<{ t: number; txt: string }>, txt: string, ttl = 10_000) {
  const now = Date.now();
  while (arr.length && now - arr[0].t > ttl) arr.shift();
  const hit = arr.some((r) => r.txt === txt);
  if (!hit) arr.push({ t: now, txt });
  return hit;
}

// ---- fábrica de instancia interna única ----
function createInstance(optsRef: Internal["optsRef"], audioElId?: string): Internal {
  const st: Internal = {
    pc: null,
    dc: null,
    micStream: null,

    connected: false,
    connecting: false,
    listening: false,
    latch: false,
    pttTimer: null,

    audioOutEl: (audioElId && (document.getElementById(audioElId) as HTMLAudioElement)) || null,

    textBuf: "",
    currentTurnNonce: 0,
    cancelled: new Set<number>(),
    seenUtterIds: new Set<string>(),
    recentTexts: [],

    optsRef,
  } as any;

  const beep = makeBeep(optsRef.current.beeps);

  const notifyListen = (on: boolean) => {
    try { st.optsRef.current.onListeningChange(on); } catch {}
  };

  const clearPttTimer = () => {
    if (st.pttTimer != null) {
      clearTimeout(st.pttTimer);
      st.pttTimer = null;
    }
  };

  const setMicEnabled = (on: boolean) => {
    st.listening = on;
    if (st.micStream) st.micStream.getAudioTracks().forEach((t) => (t.enabled = on));
    notifyListen(on);
    beep(on ? 1200 : 750, 55);
    if (on) {
      st.currentTurnNonce++;
      st.textBuf = "";
      clearPttTimer();
      // si NO es latch, cortamos solo por timeout
      if (st.optsRef.current.pttMaxMs && !st.latch) {
        st.pttTimer = window.setTimeout(() => {
          if (st.listening) st.api.stopListening();
        }, st.optsRef.current.pttMaxMs);
      }
    } else {
      clearPttTimer();
      st.textBuf = "";
    }
    log(on ? "🎙️ PTT ON" : "🔇 PTT OFF");
  };

  // ==== API pública (las funciones capturan SIEMPRE este mismo 'st') ====
  const api: VoiceApi = {
    connect: async () => {
      if (st.connected || st.connecting) return;
      st.connecting = true;
      try {
        // 1) token efímero
        const ses = await fetch(`${optsRef.current.bridgeBase}/realtime/session`);
        if (!ses.ok) throw new Error(`/realtime/session ${ses.status}`);
        const j = await ses.json();
        const ephemeral = j?.client_secret?.value;
        if (!ephemeral) throw new Error("sin token efímero");

        // 2) RTCPeerConnection y canal de datos
        st.pc = new RTCPeerConnection();
        st.dc = st.pc.createDataChannel("oai-events");

        const dcOpen = new Promise<void>((res, rej) => {
          const to = setTimeout(() => rej(new Error("timeout datachannel")), 10000);
          st.dc!.onopen = () => {
            if (st.dc!.readyState === "open") {
              clearTimeout(to);
              log("datachannel OPEN");
              res();
            }
          };
          st.dc!.onclose = () => rej(new Error("datachannel close"));
          st.dc!.onerror = (e) => rej(e as any);
        });

        // 3) audio remoto → <audio>
        st.pc.addTransceiver("audio", { direction: "sendrecv" });
        st.pc.addTransceiver("video", { direction: "recvonly" });
        st.pc.ontrack = (ev) => {
          if (ev.track.kind !== "audio" || !st.audioOutEl) return;
          const prev = st.audioOutEl.srcObject as MediaStream | null;
          if (prev) prev.getTracks().forEach((t) => t.stop());
          st.audioOutEl.srcObject = new MediaStream([ev.track]);
          ev.track.onunmute = () => st.audioOutEl!.play().catch(() => {});
        };

        // 4) mic local (tracks disabled por PTT)
        st.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        st.micStream.getAudioTracks().forEach((t) => {
          t.enabled = false;
          st.pc!.addTrack(t, st.micStream!);
        });

        // 5) mensajes del modelo
        if (st.dc) {
          st.dc.onmessage = async (e) => {
            try {
              const m = JSON.parse(e.data);

              // A) nuevo formato: conversation.item.input_audio_transcription.*
              if (m.type === "conversation.item.input_audio_transcription.delta") {
                if (st.listening || st.latch) st.textBuf += m.delta || "";
                return;
              }
              if (m.type === "conversation.item.input_audio_transcription.completed") {
                const nonceAt = st.currentTurnNonce;
                if (st.cancelled.has(nonceAt)) {
                  st.cancelled.delete(nonceAt);
                  st.textBuf = "";
                  return;
                }
                const utterId = m.item?.id || m.item_id || m.id || `utt-${Date.now()}-${Math.random()}`;
                if (st.seenUtterIds.has(utterId)) return;
                st.seenUtterIds.add(utterId);

                const finalTxt = sanitize(m.transcript || st.textBuf || "");
                st.textBuf = "";
                if (!finalTxt || isRecentTextPush(st.recentTexts, finalTxt)) return;

                await st.optsRef.current.onUserText(finalTxt);
                if (!st.latch && st.listening) api.stopListening();
                return;
              }

              // B) viejo formato (por si el bridge lo emite)
              if (m.type === "input_audio_buffer.transcription_completed") {
                const finalTxt = sanitize(m.transcript || "");
                if (!finalTxt || isRecentTextPush(st.recentTexts, finalTxt)) return;
                await st.optsRef.current.onUserText(finalTxt);
                if (!st.latch && st.listening) api.stopListening();
                return;
              }

              if (m.type === "input_audio_buffer.speech_started") { log("🗣️ speech start"); return; }
              if (m.type === "input_audio_buffer.speech_stopped") { log("🤫 speech stop"); return; }
              if (m.type === "error") console.warn("[voice] realtime error", m);
            } catch {
              // ignore no-JSON
            }
          };
        }

        // 6) SDP
        const offer = await st.pc.createOffer();
        await st.pc.setLocalDescription(offer);
        const sdpResp = await fetch(`${optsRef.current.bridgeBase}/realtime/sdp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sdp: offer.sdp,
            client_secret: ephemeral,
            model: "gpt-4o-mini-realtime-preview",
          }),
        });
        if (!sdpResp.ok) throw new Error(`/realtime/sdp ${sdpResp.status}`);
        const answer = await sdpResp.text();
        if (!answer.startsWith("v=")) throw new Error("SDP inválido");
        if (st.pc.signalingState === "have-local-offer") {
          await st.pc.setRemoteDescription({ type: "answer", sdp: answer });
        }

        // 7) esperar DC OPEN
        await dcOpen;

        // 8) configurar sesión (VAD server, sin autorrespuesta)
        const safeSend = (obj: any) => {
          if (!st.dc || st.dc.readyState !== "open") return;
          if (obj?.type === "session.update" && obj.session) {
            delete (obj.session as any).default_response_modalities;
            delete (obj.session as any).response_modalities;
          }
          st.dc.send(JSON.stringify(obj));
        };
        safeSend({
          type: "session.update",
          session: {
            instructions: "Transcribí en es-AR. No generes respuestas automáticas.",
            turn_detection: { type: "server_vad", threshold: 0.60, silence_duration_ms: 350, create_response: false },
          },
        });

        st.connected = true;
        notifyListen(false);
        log("✅ conectado (realtime)");
        if (st.audioOutEl) log("🔊 audio de asistente adjuntado");
      } catch (err) {
        // cleanup minimal
        try { st.dc?.close(); } catch {}
        try { st.pc?.close(); } catch {}
        try { st.micStream?.getTracks().forEach((t) => t.stop()); } catch {}
        st.dc = null; st.pc = null; st.micStream = null;
        st.connected = false; st.listening = false; st.latch = false;
        st.cancelled.clear(); st.seenUtterIds.clear(); st.recentTexts = []; st.textBuf = "";
        st.optsRef.current.onError(err);
        throw err;
      } finally {
        st.connecting = false;
      }
    },

    speak: (text: string) => {
      try {
        if (!st.dc || st.dc.readyState !== "open") return;
        st.dc.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio"], instructions: text },
        }));
      } catch (e) {
        st.optsRef.current.onError(e);
      }
    },

    startListening: () => {
      if (!st.connected || st.listening) return;
      setMicEnabled(true);
    },
    stopListening: () => {
      if (!st.connected || !st.listening) return;
      setMicEnabled(false);
    },
    toggleListening: () => {
      if (!st.connected) return;
      setMicEnabled(!st.listening);
    },

    enableLatch: () => {
      if (st.latch) return;
      st.latch = true;
      log("🔒 latch ENABLED");
      if (!st.listening) setMicEnabled(true);
    },
    disableLatch: () => {
      if (!st.latch) return;
      st.latch = false;
      log("🔓 latch DISABLED");
      if (st.listening) setMicEnabled(false);
    },
    toggleLatch: () => {
      if (st.latch) api.disableLatch(); else api.enableLatch();
    },

    cancelCurrentTurn: () => {
      st.cancelled.add(st.currentTurnNonce);
      api.stopListening();
      log("⛔ turno cancelado");
    },

    attachAudioElement: (el) => { st.audioOutEl = el; if (el) log("🔊 audio de asistente adjuntado"); },
    setAudioElement: (el) => { st.audioOutEl = el; if (el) log("🔊 audio de asistente adjuntado"); },

    get connected() { return st.connected; },
    get listening() { return st.listening; },
    get latch() { return st.latch; },
  };

  st.api = api;
  return st;
}

// ---- Hook React: mantiene UNA instancia persistente y callbacks frescas ----
export function useRealtimeVoice({
  onUserText,
  bridgeBase = "http://localhost:8002",
  audioElId,
  onListeningChange,
  pttMaxMs = 8000,
  beeps = true,
  onError,
}: Opts): VoiceApi {
  // callbacks / opciones vivas
  const optsRef = useRef({
    onUserText,
    onListeningChange: onListeningChange ?? (() => {}),
    onError: onError ?? (() => {}),
    pttMaxMs,
    beeps,
    bridgeBase,
  });
  // refrescá refs si cambian las props
  optsRef.current.onUserText = onUserText;
  optsRef.current.onListeningChange = onListeningChange ?? (() => {});
  optsRef.current.onError = onError ?? (() => {});
  optsRef.current.pttMaxMs = pttMaxMs;
  optsRef.current.beeps = beeps;
  optsRef.current.bridgeBase = bridgeBase;

  // instancia única persistente
  const instRef = useRef<Internal | null>(null);
  if (!instRef.current) {
    instRef.current = createInstance(optsRef as any, audioElId);
  }

  // cleanup al desmontar
  useEffect(() => {
    return () => {
      const st = instRef.current!;
      try { st.dc?.close(); } catch {}
      try { st.pc?.close(); } catch {}
      try { st.micStream?.getTracks().forEach((t) => t.stop()); } catch {}
      st.dc = null; st.pc = null; st.micStream = null;
      st.connected = false; st.listening = false; st.latch = false;
      st.cancelled.clear(); st.seenUtterIds.clear(); st.recentTexts = []; st.textBuf = "";
    };
  }, []);

  return instRef.current!.api;
}
