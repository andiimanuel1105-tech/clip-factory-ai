
/*
 * CLIP FACTORY AI
 * SUBTITULOS AUTOMATICOS EN ESPANOL
 * Archivo independiente: clip-subtitles.js
 *
 * Transcribe el audio mediante el Worker de Gemini.
 * Graba el video vertical con subtitulos integrados.
 * Convierte el resultado a MP4.
 */

(() => {
  "use strict";

  const WORKER_URL =
    "https://clip-factory-subtitles.andiimanuel1105.workers.dev/transcribe";

  const FFMPEG_SCRIPT =
    "https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js";

  const FFMPEG_CORE =
    "https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js";

  const MAX_AUDIO_SIZE = 18 * 1024 * 1024;

  let ffmpeg = null;
  let ffmpegLoading = null;
  let busy = false;

  function status(message) {
    const element = document.getElementById("status");
    if (element) element.textContent = message;
  }

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.crossOrigin = "anonymous";
      script.onload = resolve;
      script.onerror = () =>
        reject(new Error("No se pudo cargar FFmpeg."));
      document.head.appendChild(script);
    });
  }

  async function getFFmpeg() {
    if (ffmpeg && ffmpeg.isLoaded()) return ffmpeg;
    if (ffmpegLoading) return ffmpegLoading;

    ffmpegLoading = (async () => {
      if (!window.FFmpeg) {
        await loadScript(FFMPEG_SCRIPT);
      }

      if (!window.FFmpeg || !window.FFmpeg.createFFmpeg) {
        throw new Error("FFmpeg no está disponible.");
      }

      const engine = window.FFmpeg.createFFmpeg({
        log: false,
        corePath: FFMPEG_CORE,
        mainName: "main"
      });

      await engine.load();
      ffmpeg = engine;
      return engine;
    })();

    try {
      return await ffmpegLoading;
    } finally {
      ffmpegLoading = null;
    }
  }

  function getTimes(card) {
    const info = Array.from(card.querySelectorAll("p")).find(p =>
      /Desde\s+[\d:]+\s+hasta\s+[\d:]+/i.test(p.textContent)
    );

    if (!info) {
      throw new Error("No se encontraron los tiempos del clip.");
    }

    const match = info.textContent.match(
      /Desde\s+([\d:]+)\s+hasta\s+([\d:]+)/i
    );

    if (!match) throw new Error("Los tiempos no son válidos.");

    const toSeconds = value =>
      value.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);

    const start = toSeconds(match[1]);
    const end = toSeconds(match[2]);

    if (end <= start) throw new Error("Duración de clip incorrecta.");

    return { start, end, duration: end - start };
  }

  function safeName(value) {
    return (value || "clip")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 50) || "clip";
  }

  function waitForMetadata(video) {
    return new Promise((resolve, reject) => {
      if (video.readyState >= 1) return resolve();

      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener(
        "error",
        () => reject(new Error("No se pudo abrir el video.")),
        { once: true }
      );
    });
  }

  function seekVideo(video, time) {
    return new Promise((resolve, reject) => {
      if (Math.abs(video.currentTime - time) < 0.05) {
        return resolve();
      }

      video.addEventListener("seeked", resolve, { once: true });
      video.addEventListener(
        "error",
        () => reject(new Error("No se pudo posicionar el video.")),
        { once: true }
      );

      video.currentTime = time;
    });
  }

  function createVideo(file) {
    const video = document.createElement("video");

    video.preload = "auto";
    video.playsInline = true;
    video.controls = false;
    video.muted = false;

    video.style.cssText =
      "position:fixed;left:-10000px;top:0;width:320px;height:180px;";

    video.src = URL.createObjectURL(file);
    document.body.appendChild(video);

    return video;
  }

  function removeVideo(video) {
    if (!video) return;

    try {
      video.pause();
      video.src = "";
      video.load();

      if (video._clipURL) {
        URL.revokeObjectURL(video._clipURL);
      }
    } catch (_) {}

    video.remove();
  }

  function makeVideo(file) {
    const video = createVideo(file);
    video._clipURL = video.src;
    return video;
  }

  function recorderType(audioOnly = false) {
    const types = audioOnly
      ? [
          "audio/webm;codecs=opus",
          "audio/webm"
        ]
      : [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm"
        ];

    return types.find(type => MediaRecorder.isTypeSupported(type)) || "";
  }

  function recordStream(stream, video, endTime, onFrame) {
    return new Promise((resolve, reject) => {
      let recorder;
      let animation = null;
      let stopped = false;
      const chunks = [];

      try {
        const type = recorderType(
          stream.getVideoTracks().length === 0
        );

        recorder = new MediaRecorder(
          stream,
          type ? { mimeType: type } : undefined
        );

        recorder.ondataavailable = event => {
          if (event.data && event.data.size > 0) {
            chunks.push(event.data);
          }
        };

        recorder.onerror = () => {
          reject(new Error("Falló la grabación del clip."));
        };

        recorder.onstop = () => {
          if (animation !== null) {
            cancelAnimationFrame(animation);
          }

          resolve(new Blob(chunks, {
            type: recorder.mimeType || "video/webm"
          }));
        };

        function finish() {
          if (stopped) return;
          stopped = true;

          if (recorder.state !== "inactive") {
            recorder.stop();
          }

          video.pause();
        }

        function monitor() {
          if (stopped) return;

          if (onFrame) onFrame();

          if (video.currentTime >= endTime || video.ended) {
            finish();
            return;
          }

          animation = requestAnimationFrame(monitor);
        }

        recorder.start(250);

        video.play().then(() => {
          monitor();
        }).catch(() => {
          finish();
          reject(new Error("El navegador no pudo reproducir el video."));
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  async function captureAudio(file, start, end) {
    const video = makeVideo(file);

    try {
      await waitForMetadata(video);

      const source = video.captureStream
        ? video.captureStream()
        : video.mozCaptureStream?.();

      if (!source) {
        throw new Error("Tu navegador no permite capturar el audio.");
      }

      const audioTracks = source.getAudioTracks();

      if (!audioTracks.length) {
        throw new Error("El video no contiene una pista de audio.");
      }

      await seekVideo(video, start);

      const audioStream = new MediaStream(audioTracks);

      const blob = await recordStream(
        audioStream,
        video,
        end
      );

      source.getTracks().forEach(track => track.stop());

      if (blob.size > MAX_AUDIO_SIZE) {
        throw new Error("El audio supera el límite de 18 MB.");
      }

      if (!blob.size) {
        throw new Error("No se pudo extraer el audio.");
      }

      return blob;

    } finally {
      removeVideo(video);
    }
  }

  async function transcribe(audioBlob, accessCode) {
    const form = new FormData();

    form.append(
      "audio",
      audioBlob,
      "audio.webm"
    );

    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: {
        "X-Clip-Access-Code": accessCode
      },
      body: form
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error || "No se pudo transcribir el audio."
      );
    }

    if (!Array.isArray(data.segments) || !data.segments.length) {
      throw new Error("No se encontraron subtítulos.");
    }

    return data.segments;
  }

  function wrapText(ctx, text, maxWidth) {
    const words = text.split(/\s+/);
    const lines = [];
    let line = "";

    for (const word of words) {
      const test = line ? line + " " + word : word;

      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }

    if (line) lines.push(line);

    return lines.slice(0, 2);
  }

  function drawFrame(ctx, canvas, video, segments, offset) {
    const width = canvas.width;
    const height = canvas.height;

    if (video.videoWidth && video.videoHeight) {
      const scale = Math.max(
        width / video.videoWidth,
        height / video.videoHeight
      );

      const drawWidth = video.videoWidth * scale;
      const drawHeight = video.videoHeight * scale;

      ctx.drawImage(
        video,
        (width - drawWidth) / 2,
        (height - drawHeight) / 2,
        drawWidth,
        drawHeight
      );
    }

    const time = video.currentTime - offset;

    const active = segments.find(segment =>
      time >= Number(segment.start) &&
      time <= Number(segment.end)
    );

    if (!active) return;

    ctx.font = "bold 54px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const lines = wrapText(ctx, active.text, 900);
    const lineHeight = 68;
    const boxHeight = lines.length * lineHeight + 44;
    const boxY = height - 390;

    ctx.fillStyle = "rgba(0,0,0,0.78)";
    ctx.fillRect(
      45,
      boxY,
      width - 90,
      boxHeight
    );

    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 3;

    lines.forEach((line, index) => {
      const y = boxY + 22 + lineHeight * index + lineHeight / 2;

      ctx.strokeText(line, width / 2, y);
      ctx.fillText(line, width / 2, y);
    });
  }

  async function captureSubtitledVideo(file, start, end, segments) {
    const video = makeVideo(file);

    try {
      await waitForMetadata(video);
      await seekVideo(video, start);

      const source = video.captureStream
        ? video.captureStream()
        : video.mozCaptureStream?.();

      if (!source) {
        throw new Error("No se pudo capturar el video.");
      }

      const audioTracks = source.getAudioTracks();

      if (!audioTracks.length) {
        throw new Error("No se encontró el audio del video.");
      }

      const canvas = document.createElement("canvas");
     canvas.width = 720;
canvas.height = 1280;
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        throw new Error("No se pudo preparar el formato vertical.");
      }

      const canvasStream = canvas.captureStream(30);

      const finalStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioTracks
      ]);

      const blob = await recordStream(
        finalStream,
        video,
        end,
        () => drawFrame(ctx, canvas, video, segments, start)
      );

      source.getTracks().forEach(track => track.stop());
      canvasStream.getTracks().forEach(track => track.stop());

      if (!blob.size) {
        throw new Error("No se pudo grabar el video subtitulado.");
      }

      return blob;

    } finally {
      removeVideo(video);
    }
  }

  async function convertToMP4(blob, filename) {
    const engine = await getFFmpeg();

    const inputName = "subtitulado_entrada.webm";
    const outputName = "subtitulado_salida.mp4";

    try {
      const data = await window.FFmpeg.fetchFile(blob);

      engine.FS("writeFile", inputName, data);

      await engine.run(
        "-i", inputName,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "25",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        outputName
      );

      const result = engine.FS("readFile", outputName);

      const mp4 = new Blob([result.buffer], {
        type: "video/mp4"
      });

      if (!mp4.size) {
        throw new Error("El archivo MP4 quedó vacío.");
      }

      const url = URL.createObjectURL(mp4);
      const link = document.createElement("a");

      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(() => URL.revokeObjectURL(url), 60000);

    } finally {
      try {
        engine.FS("unlink", inputName);
      } catch (_) {}

      try {
        engine.FS("unlink", outputName);
      } catch (_) {}
    }
  }

  async function processClip(card, button) {
    if (busy) {
      alert("Espera a que termine el otro clip.");
      return;
    }

    const fileInput = document.getElementById("videoFile");
    const accessInput = document.getElementById("accessCode");

    const file = fileInput?.files?.[0];
    const accessCode = accessInput?.value?.trim();

    if (!file) {
      alert("Selecciona un video primero.");
      return;
    }

    if (!accessCode) {
      alert("Introduce tu código privado de acceso.");
      return;
    }

    if (!window.MediaRecorder) {
      alert("Tu navegador no admite la grabación necesaria.");
      return;
    }

    let originalText = button.textContent;
    busy = true;
    button.disabled = true;

    try {
      const { start, end } = getTimes(card);

      const title = safeName(
        card.querySelector("h3")?.textContent
      );

      button.textContent = "EXTRAYENDO AUDIO...";
      status("Extrayendo audio del clip...");

      const audio = await captureAudio(file, start, end);

      button.textContent = "TRANSCRIBIENDO...";
      status("Gemini está escuchando el clip y creando los subtítulos...");

      const segments = await transcribe(audio, accessCode);

      button.textContent = "GRABANDO SUBTITULOS...";
      status("Integrando los subtítulos en el video vertical...");

      const subtitledVideo = await captureSubtitledVideo(
        file,
        start,
        end,
        segments
      );

      button.textContent = "CONVIRTIENDO A MP4...";
      status("Preparando el MP4 final. No cierres la página...");

      await convertToMP4(
        subtitledVideo,
        title + "_subtitulado.mp4"
      );

      button.textContent = "MP4 CON SUBTITULOS LISTO";
      button.style.background = "#16803c";

      status("¡Éxito! Tu video con subtítulos fue descargado.");

    } catch (error) {
      console.error("CLIP FACTORY SUBTITLES:", error);

      alert(
        "No se pudo completar el video con subtítulos.\n\n" +
        (error.message || "Error desconocido.")
      );

      button.textContent = "REINTENTAR SUBTITULOS";
      button.disabled = false;

      status("Error al generar subtítulos: " + error.message);

    } finally {
      busy = false;
    }
  }

  function addButton(card) {
    if (card.querySelector(".cf-subtitle-button")) return;

    const button = document.createElement("button");

    button.type = "button";
    button.className = "cf-subtitle-button";
    button.textContent = "SUBTITULOS + MP4";

    button.style.cssText = [
      "display:block",
      "width:100%",
      "margin-top:10px",
      "padding:13px",
      "border:0",
      "border-radius:8px",
      "background:#7b2cff",
      "color:white",
      "font-weight:bold",
      "cursor:pointer"
    ].join(";");

    button.addEventListener("click", () => {
      processClip(card, button);
    });

    card.appendChild(button);
  }

  function start() {
    const results = document.getElementById("results");

    if (!results) {
      console.error("CLIP FACTORY: No se encontró results.");
      return;
    }

    function scan() {
      results.querySelectorAll(".clip").forEach(addButton);
    }

    scan();

    const observer = new MutationObserver(scan);

    observer.observe(results, {
      childList: true,
      subtree: true
    });

    console.log("CLIP FACTORY: Módulo de subtítulos preparado.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
