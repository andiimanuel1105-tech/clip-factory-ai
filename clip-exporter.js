
/*
 * CLIP FACTORY AI - EXPORTADOR MP4
 * Módulo independiente: no modifica el análisis ni render().
 * FFmpeg.wasm 0.11.6 + core single-thread 0.11.1
 */

(() => {
  "use strict";

  const FFMPEG_SCRIPT =
    "https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js";

  const FFMPEG_CORE =
    "https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js";

  const MAX_FILE_SIZE = 100 * 1024 * 1024;

  let ffmpegInstance = null;
  let ffmpegLoading = null;
  let processing = false;

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.crossOrigin = "anonymous";
      script.onload = resolve;
      script.onerror = () =>
        reject(new Error("No se pudo cargar la librería de video."));
      document.head.appendChild(script);
    });
  }

  async function getFFmpeg() {
    if (ffmpegInstance && ffmpegInstance.isLoaded()) {
      return ffmpegInstance;
    }

    if (ffmpegLoading) return ffmpegLoading;

    ffmpegLoading = (async () => {
      if (!window.FFmpeg) {
        await loadScript(FFMPEG_SCRIPT);
      }

      if (!window.FFmpeg || !window.FFmpeg.createFFmpeg) {
        throw new Error("La librería FFmpeg no está disponible.");
      }

      const engine = window.FFmpeg.createFFmpeg({
        log: false,
        corePath: FFMPEG_CORE,
        mainName: "main"
      });

      await engine.load();
      ffmpegInstance = engine;
      return engine;
    })();

    try {
      return await ffmpegLoading;
    } finally {
      ffmpegLoading = null;
    }
  }

  function timeToSeconds(value) {
    const parts = value.trim().split(":").map(Number);

    if (!parts.length || parts.some(n => !Number.isFinite(n))) {
      throw new Error("El tiempo del clip no es válido.");
    }

    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  function getClipTimes(card) {
    const paragraphs = Array.from(card.querySelectorAll("p"));

    const info = paragraphs.find(p =>
      /Desde\s+[\d:]+\s+hasta\s+[\d:]+/i.test(p.textContent)
    );

    if (!info) {
      throw new Error("No pude encontrar el inicio y final del clip.");
    }

    const match = info.textContent.match(
      /Desde\s+([\d:]+)\s+hasta\s+([\d:]+)/i
    );

    if (!match) {
      throw new Error("No pude leer los tiempos del clip.");
    }

    const start = timeToSeconds(match[1]);
    const end = timeToSeconds(match[2]);

    if (end <= start) {
      throw new Error("El final debe ser posterior al inicio.");
    }

    return { start, duration: end - start };
  }

  function safeName(value) {
    return (value || "clip")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 55) || "clip";
  }

  function addExportButton(card) {
    if (card.querySelector(".cf-export-button")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "cf-export-button";
    button.textContent = "GENERAR MP4";

    button.style.cssText = [
      "display:block",
      "width:100%",
      "margin-top:12px",
      "padding:12px",
      "border:0",
      "border-radius:8px",
      "background:#e50914",
      "color:white",
      "font-weight:bold",
      "cursor:pointer"
    ].join(";");

    button.addEventListener("click", () => exportClip(card, button));

    card.appendChild(button);
  }

  async function exportClip(card, button) {
    if (processing) {
      alert("Espera a que termine la exportación actual.");
      return;
    }

    const fileInput = document.getElementById("videoFile");
    const file = fileInput && fileInput.files && fileInput.files[0];

    if (!file) {
      alert("Primero selecciona un video.");
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      alert("Este video supera los 100 MB. Para evitar errores de memoria, utiliza un archivo más pequeño.");
      return;
    }

    let inputName = "";
    let outputName = "";

    processing = true;
    button.disabled = true;
    button.textContent = "PREPARANDO MOTOR...";

    try {
      const { start, duration } = getClipTimes(card);

      const titleElement = card.querySelector("h3");
      const title = safeName(titleElement?.textContent || "clip");

      const extension = (
        file.name.split(".").pop() || "mp4"
      ).toLowerCase().replace(/[^a-z0-9]/g, "");

      inputName = `video_entrada.${extension || "mp4"}`;
      outputName = `clip_${Date.now()}.mp4`;

      const ffmpeg = await getFFmpeg();

      button.textContent = "CARGANDO VIDEO...";

      const videoData = await window.FFmpeg.fetchFile(file);
      ffmpeg.FS("writeFile", inputName, videoData);

      button.textContent = "GENERANDO MP4...";

      await ffmpeg.run(
        "-i", inputName,
        "-ss", String(start),
        "-t", String(duration),
        "-map", "0:v:0",
        "-map", "0:a?",
        "-vf",
        "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        outputName
      );

      button.textContent = "PREPARANDO DESCARGA...";

      const result = ffmpeg.FS("readFile", outputName);
      const blob = new Blob([result.buffer], {
        type: "video/mp4"
      });

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = `${title}.mp4`;
      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(() => URL.revokeObjectURL(url), 60000);

      button.textContent = "MP4 GENERADO";
      button.style.background = "#16803c";

    } catch (error) {
      console.error("CLIP FACTORY EXPORT:", error);

      alert(
        "No se pudo generar el MP4.\n\n" +
        (error.message || "Error desconocido") +
        "\n\nComprueba que el video sea compatible y vuelve a intentarlo."
      );

      button.textContent = "REINTENTAR MP4";
      button.disabled = false;

    } finally {
      if (ffmpegInstance) {
        try {
          if (inputName) ffmpegInstance.FS("unlink", inputName);
        } catch (_) {}

        try {
          if (outputName) ffmpegInstance.FS("unlink", outputName);
        } catch (_) {}
      }

      processing = false;
    }
  }

  function scanClips() {
    const results = document.getElementById("results");
    if (!results) return;

    results.querySelectorAll(".clip").forEach(addExportButton);
  }

  function start() {
    const results = document.getElementById("results");

    if (!results) {
      console.error("CLIP FACTORY: No se encontró el contenedor results.");
      return;
    }

    scanClips();

    const observer = new MutationObserver(scanClips);
    observer.observe(results, {
      childList: true,
      subtree: true
    });

    console.log("CLIP FACTORY: Exportador MP4 preparado.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
