"use client";

import { useState, useRef, useEffect, useCallback } from "react";

type AppStatus =
  | "idle"
  | "uploading"
  | "queued"
  | "converting"
  | "done"
  | "error";

interface QueueStats {
  running: number;
  pending: number;
  maxConcurrent: number;
}

const POLL_INTERVAL_MS = 2000;
const QUEUE_POLL_INTERVAL_MS = 3000;

/** Polls /api/queue-status every QUEUE_POLL_INTERVAL_MS and returns live stats */
function useQueueStatus(): QueueStats | null {
  const [stats, setStats] = useState<QueueStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/queue-status", { cache: "no-store" });
        if (!res.ok) return;
        const data: QueueStats = await res.json();
        if (!cancelled) setStats(data);
      } catch {
        // server not yet ready — stay silent
      }
    };
    poll();
    const id = setInterval(poll, QUEUE_POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return stats;
}

/** Compact server-load banner displayed below the header */
function QueueStatusBanner({ stats }: { stats: QueueStats | null }) {
  if (!stats) {
    return (
      <div className="flex items-center justify-center gap-2 text-xs text-slate-500 animate-pulse">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-600" />
        Sunucu durumu alınıyor...
      </div>
    );
  }

  const total = stats.running + stats.pending;
  const isIdle = total === 0;
  const isBusy = stats.running >= stats.maxConcurrent;
  const fillPct = Math.min(100, (stats.running / stats.maxConcurrent) * 100);

  const dotColor = isIdle
    ? "bg-emerald-400"
    : isBusy
    ? "bg-amber-400 animate-pulse"
    : "bg-cyan-400 animate-pulse";

  const label = isIdle
    ? "Sunucu boşta — hemen dönüştürme başlar"
    : isBusy
    ? `${stats.pending} iş bekliyor — sıra oluştu`
    : `${stats.running} iş işleniyor`;

  return (
    <div className="flex items-center justify-center gap-3 flex-wrap">
      {/* Status dot + label */}
      <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
        <span className={`w-2 h-2 rounded-full ${dotColor} shrink-0`} />
        {label}
      </div>

      {/* Capacity mini-bar */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-slate-600 uppercase tracking-wider">Kapasite</span>
        <div className="w-20 h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${
              fillPct >= 100 ? "bg-amber-400" : "bg-cyan-500"
            }`}
            style={{ width: `${fillPct}%` }}
          />
        </div>
        <span className="text-[10px] text-slate-600">
          {stats.running}/{stats.maxConcurrent}
        </span>
      </div>

      {/* Pending pill (only when there's a queue) */}
      {stats.pending > 0 && (
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 font-semibold">
          {stats.pending} bekliyor
        </span>
      )}
    </div>
  );
}

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<AppStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [progress, setProgress] = useState(0); // 0..100
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queueStats = useQueueStatus();

  // ------------------------------------------------------------------
  // Progress bar simulation while converting
  // ------------------------------------------------------------------
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (status === "converting") {
      interval = setInterval(() => {
        setProgress((prev) => (prev >= 95 ? 95 : prev + Math.random() * 2));
      }, 500);
    } else if (status === "done") {
      setProgress(100);
    } else if (status === "idle" || status === "error") {
      setProgress(0);
    }
    return () => clearInterval(interval);
  }, [status]);

  // Cleanup poll on unmount
  useEffect(() => {
    return () => stopPolling();
  }, []);

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const triggerDownload = async (downloadUrl: string, fileName: string) => {
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error("Download failed");
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  };

  const pollJobStatus = useCallback(
    (jobId: string, defaultFileName: string) => {
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/job/${jobId}`);
          if (!res.ok) {
            stopPolling();
            setStatus("error");
            setErrorMessage("Job status check failed.");
            return;
          }

          const data = await res.json();

          if (data.status === "pending") {
            setStatus("queued");
            setQueuePosition(data.position ?? null);
          } else if (data.status === "running") {
            setStatus("converting");
            setQueuePosition(null);
            setProgress(50);
          } else if (data.status === "done") {
            stopPolling();
            setQueuePosition(null);
            await triggerDownload(data.downloadUrl, defaultFileName);
            setStatus("done");
          } else if (data.status === "error") {
            stopPolling();
            setStatus("error");
            setErrorMessage(data.message || "Dönüştürme başarısız.");
          }
        } catch {
          stopPolling();
          setStatus("error");
          setErrorMessage("Bağlantı kesildi. Lütfen tekrar deneyin.");
        }
      }, POLL_INTERVAL_MS);
    },
    []
  );

  // ------------------------------------------------------------------
  // File selection
  // ------------------------------------------------------------------
  const handleFilesSelected = (selectedFiles: File[]) => {
    const validFiles = selectedFiles.filter(
      (f) =>
        f.name.toLowerCase().endsWith(".ppt") ||
        f.name.toLowerCase().endsWith(".pptx")
    );
    if (validFiles.length !== selectedFiles.length) {
      alert("Sadece .ppt ve .pptx dosyaları seçebilirsiniz.");
    }
    setFiles((prev) => [...prev, ...validFiles]);
    setStatus("idle");
    setErrorMessage("");
    setProgress(0);
  };

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length > 0) {
      handleFilesSelected(Array.from(e.dataTransfer.files));
    }
  };

  const removeFile = (idx: number) =>
    setFiles((prev) => prev.filter((_, i) => i !== idx));

  // ------------------------------------------------------------------
  // Upload → enqueue → poll
  // ------------------------------------------------------------------
  const handleUpload = () => {
    if (files.length === 0) return;

    stopPolling();
    setStatus("uploading");
    setErrorMessage("");
    setProgress(0);
    setQueuePosition(null);

    const formData = new FormData();
    files.forEach((f) => formData.append("file", f));

    const defaultFileName =
      files.length === 1
        ? `${files[0].name.replace(/\.[^/.]+$/, "")}.pdf`
        : "Sunum_Ciktilari.zip";

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/convert");
    xhr.responseType = "json";

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        // Upload maps to first 40% of progress bar
        setProgress((event.loaded / event.total) * 40);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 202 && xhr.response?.jobId) {
        // Upload done — now poll for status
        setStatus("queued");
        setProgress(40);
        pollJobStatus(xhr.response.jobId, defaultFileName);
      } else {
        const msg = xhr.response?.error || "Yükleme başarısız.";
        setStatus("error");
        setErrorMessage(msg);
      }
    };

    xhr.onerror = () => {
      setStatus("error");
      setErrorMessage("Bağlantı koptu veya ağ hatası.");
    };

    xhr.send(formData);
  };

  // ------------------------------------------------------------------
  // Status text helpers
  // ------------------------------------------------------------------
  const statusLabel = () => {
    if (status === "uploading") return "Sunucuya Yükleniyor...";
    if (status === "queued")
      return queuePosition
        ? `Sırada #${queuePosition}. bekliyorsunuz...`
        : "Sırada bekleniyor...";
    if (status === "converting") return "Dönüştürülüyor (Lütfen sayfadan ayrılmayın)...";
    if (status === "done") return "İşlem Tamamlandı!";
    return "";
  };

  const isProcessing =
    status === "uploading" || status === "queued" || status === "converting";

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <main className="h-screen w-screen overflow-hidden bg-slate-950 text-slate-200 font-sans flex flex-col p-4 md:p-8 selection:bg-cyan-500/30">
      {/* Decorative Gradients */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none -z-10">
        <div className="absolute -top-[20%] -left-[10%] w-[50%] h-[50%] rounded-full bg-indigo-900/20 blur-[120px]" />
        <div className="absolute -bottom-[20%] -right-[10%] w-[50%] h-[50%] rounded-full bg-cyan-900/20 blur-[120px]" />
      </div>

      <div className="flex-1 w-full max-w-4xl mx-auto flex flex-col h-full gap-6">
        {/* Header */}
        <header className="text-center shrink-0">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 mb-3">
            <svg className="w-6 h-6 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-cyan-400 to-teal-400">
            PPTX → PDF Web Aracı
          </h1>
        </header>

        {/* Live Queue Status Banner */}
        <div className="shrink-0 px-2 py-1.5 rounded-2xl bg-slate-900/40 border border-slate-800/60 backdrop-blur-sm">
          <QueueStatusBanner stats={queueStats} />
        </div>

        {/* Content */}
        <div className="flex flex-col md:flex-row gap-6 flex-1 min-h-0 bg-slate-900/30 border border-slate-800/80 rounded-3xl p-4 md:p-6 backdrop-blur-xl shadow-2xl">

          {/* Left Panel — Drop Zone */}
          <div
            className={`flex-1 flex flex-col justify-center items-center rounded-2xl border-2 border-dashed transition-all duration-300 relative overflow-hidden group ${
              isDragging
                ? "border-cyan-400 bg-cyan-900/20"
                : "border-slate-700/60 hover:border-indigo-500/50 hover:bg-slate-800/30"
            }`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleFileDrop}
          >
            <div className="p-8 flex flex-col items-center justify-center text-center space-y-4">
              <div className="p-4 rounded-full bg-slate-800/80 group-hover:bg-indigo-500/20 transition-colors duration-300 shadow-md">
                <svg className="w-10 h-10 text-slate-400 group-hover:text-indigo-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <div>
                <p className="text-xl font-medium text-slate-200">Dosyaları Sürükle ve Bırak</p>
                <p className="text-sm text-slate-500 mt-2">veya sistemden seçin (Birden çok .pptx/.ppt)</p>
              </div>
              <input
                type="file"
                multiple
                accept=".ppt,.pptx"
                className="hidden"
                ref={fileInputRef}
                onChange={(e) => {
                  if (e.target.files) handleFilesSelected(Array.from(e.target.files));
                  e.target.value = "";
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="mt-4 px-6 py-2.5 rounded-xl bg-slate-800/80 border border-slate-600 hover:bg-slate-700 hover:border-slate-500 text-slate-100 font-medium transition-colors shadow-sm"
                disabled={isProcessing}
              >
                Göz At
              </button>
            </div>
          </div>

          {/* Right Panel — Queue & Controls */}
          <div className="flex-1 flex flex-col rounded-2xl bg-slate-950/50 border border-slate-800/80 overflow-hidden">
            <div className="p-4 border-b border-slate-800/80 flex justify-between items-center bg-slate-900/50 shrink-0">
              <h3 className="font-semibold text-slate-200 flex items-center gap-2">
                <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                İşlem Kuyruğu ({files.length})
              </h3>
              {!isProcessing && files.length > 0 && (
                <button
                  onClick={() => setFiles([])}
                  className="text-xs font-medium text-slate-400 hover:text-red-400 transition-colors px-2 py-1 rounded-md hover:bg-red-500/10"
                >
                  Temizle
                </button>
              )}
            </div>

            {/* File List */}
            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
              {files.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-500 text-sm italic">
                  Henüz dosya eklenmedi.
                </div>
              ) : (
                <ul className="space-y-2">
                  {files.map((file, i) => (
                    <li key={i} className="flex justify-between items-center p-3 rounded-xl bg-slate-800/40 border border-slate-700/50 hover:border-indigo-500/30 transition-colors group">
                      <div className="flex items-center gap-3 overflow-hidden">
                        <svg className="w-5 h-5 text-indigo-400 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM6 20V4h5v7h7v9H6z" />
                        </svg>
                        <span className="text-sm font-medium text-slate-300 truncate" title={file.name}>
                          {file.name}
                        </span>
                      </div>
                      {!isProcessing && (
                        <button
                          onClick={() => removeFile(i)}
                          className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded-md transition-colors shrink-0 opacity-0 group-hover:opacity-100"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Progress + Button Area */}
            <div className="p-4 bg-slate-900/70 border-t border-slate-800/80 shrink-0">

              {/* Progress Bar */}
              {(isProcessing || status === "done") && (
                <div className="mb-4 space-y-2">
                  <div className="flex justify-between text-xs font-semibold">
                    <span className="text-slate-300 flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${status === "done" ? "bg-emerald-400" : "bg-indigo-400 animate-pulse"}`} />
                      {statusLabel()}
                    </span>
                    <span className="text-cyan-400">{Math.round(progress)}%</span>
                  </div>
                  <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ease-out bg-gradient-to-r ${
                        status === "done" ? "from-emerald-500 to-emerald-400" : "from-indigo-500 to-cyan-400"
                      }`}
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  {/* Queue position badge */}
                  {status === "queued" && queuePosition && queuePosition > 1 && (
                    <p className="text-xs text-amber-400/80 text-center pt-1">
                      ⏳ Sistemde {queuePosition - 1} iş önünüzde. Sıranızı bekliyorsunuz...
                    </p>
                  )}
                </div>
              )}

              {/* Error */}
              {status === "error" && (
                <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex gap-3 text-red-400">
                  <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <p className="text-xs font-medium">{errorMessage}</p>
                </div>
              )}

              {/* Action Button */}
              <button
                onClick={handleUpload}
                disabled={isProcessing || files.length === 0}
                className="w-full relative overflow-hidden group py-3.5 px-6 rounded-xl font-bold tracking-wide transition-all shadow-lg
                         bg-gradient-to-r from-indigo-500 to-cyan-500 hover:from-indigo-400 hover:to-cyan-400
                         disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:from-indigo-500 disabled:hover:to-cyan-500"
              >
                <div className="absolute inset-0 w-full h-full bg-white/20 -translate-x-full group-hover:animate-[shimmer_1.5s_infinite] pointer-events-none" />
                <div className="flex items-center justify-center gap-2 text-white">
                  {!isProcessing ? (
                    <>
                      <span>{status === "done" ? "Yeni Dönüştürme Başlat" : "Dönüştür ve İndir"}</span>
                      <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </>
                  ) : (
                    <>
                      <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      <span>İşleniyor {Math.round(progress)}%</span>
                    </>
                  )}
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
