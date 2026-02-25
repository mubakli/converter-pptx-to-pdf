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
const MAX_CONCURRENT_FILES = 20;

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
      } catch {}
    };
    poll();
    const id = setInterval(poll, QUEUE_POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return stats;
}

function QueueStatusBanner({ stats }: { stats: QueueStats | null }) {
  if (!stats) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-700 animate-pulse" />
        Connecting...
      </div>
    );
  }

  const isBusy = stats.running > 0 || stats.pending > 0;
  
  return (
    <div className="flex items-center gap-4 text-xs font-medium text-zinc-400">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${!isBusy ? "bg-zinc-400" : "bg-zinc-100 animate-pulse"}`} />
        {!isBusy ? "System Ready" : "System Busy"}
      </div>
      {(stats.running > 0 || stats.pending > 0) && (
        <div className="flex items-center gap-3 border-l border-zinc-800 pl-4">
          <span>Active: {stats.running}/{stats.maxConcurrent}</span>
          {stats.pending > 0 && <span>Queued: {stats.pending}</span>}
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<AppStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [progress, setProgress] = useState(0); 
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queueStats = useQueueStatus();

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

  useEffect(() => {
    return () => stopPolling();
  }, []);

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
            setErrorMessage(data.message || "Conversion failed.");
          }
        } catch {
          stopPolling();
          setStatus("error");
          setErrorMessage("Connection lost. Please try again.");
        }
      }, POLL_INTERVAL_MS);
    },
    []
  );

  const handleFilesSelected = (selectedFiles: File[]) => {
    const validFiles = selectedFiles.filter(
      (f) =>
        f.name.toLowerCase().endsWith(".ppt") ||
        f.name.toLowerCase().endsWith(".pptx")
    );

    let hasError = false;
    let newErrorMsg = "";

    if (validFiles.length !== selectedFiles.length) {
      hasError = true;
      newErrorMsg = "Only .ppt and .pptx files are supported. Invalid files were ignored.";
    }

    setFiles((prev) => {
      const remainingQuota = MAX_CONCURRENT_FILES - prev.length;
      if (validFiles.length > remainingQuota) {
        hasError = true;
        newErrorMsg = `Maximum limit is ${MAX_CONCURRENT_FILES} files. Extra files were ignored.`;
        return [...prev, ...validFiles.slice(0, Math.max(0, remainingQuota))];
      }
      return [...prev, ...validFiles];
    });

    if (hasError) {
      setStatus("error");
      setErrorMessage(newErrorMsg);
      setProgress(0);
    } else {
      setStatus("idle");
      setErrorMessage("");
      setProgress(0);
    }
  };

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length > 0) {
      handleFilesSelected(Array.from(e.dataTransfer.files));
    }
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
    if (status === "error") {
      setStatus("idle");
      setErrorMessage("");
    }
  };

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
        : "Converted_Presentations.zip";

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/convert");
    xhr.responseType = "json";

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setProgress((event.loaded / event.total) * 40);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 202 && xhr.response?.jobId) {
        setStatus("queued");
        setProgress(40);
        pollJobStatus(xhr.response.jobId, defaultFileName);
      } else {
        const msg = xhr.response?.error || "Upload failed.";
        setStatus("error");
        setErrorMessage(msg);
      }
    };

    xhr.onerror = () => {
      setStatus("error");
      setErrorMessage("Network error or connection lost.");
    };

    xhr.send(formData);
  };

  const isProcessing =
    status === "uploading" || status === "queued" || status === "converting";

  return (
    <main className="h-screen w-screen bg-[#0a0a0a] text-zinc-100 font-sans flex flex-col items-center justify-center p-4 selection:bg-zinc-800">
      <div className="w-full max-w-2xl flex flex-col h-full max-h-[85vh] gap-6">
        
        {/* Header */}
        <header className="flex flex-col gap-2 shrink-0">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-3">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              PPTX to PDF
            </h1>
            <QueueStatusBanner stats={queueStats} />
          </div>
          <p className="text-sm text-zinc-500">Secure, serverless presentation converter.</p>
        </header>

        {/* Workspace */}
        <div className="flex flex-col flex-1 min-h-0 bg-[#0f0f0f] border border-zinc-800/80 rounded-xl overflow-hidden shadow-2xl">
          
          {/* Dropzone */}
          <div
            className={`flex flex-col items-center justify-center p-8 border-b-2 border-dashed transition-colors ${
              isDragging
                ? "border-zinc-500 bg-zinc-900"
                : "border-zinc-800 hover:border-zinc-700 bg-transparent"
            }`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleFileDrop}
          >
            <div className="text-center space-y-3">
              <div className="mx-auto w-10 h-10 flex items-center justify-center rounded-lg bg-zinc-800/50 text-zinc-400">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-300">Drag files here or browse</p>
                <p className="text-xs text-zinc-600 mt-1">Accepts .ppt, .pptx (Max {MAX_CONCURRENT_FILES} files)</p>
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
                disabled={isProcessing}
                className="mt-2 px-4 py-2 text-xs font-medium rounded-md bg-zinc-100 text-zinc-900 hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Select Files
              </button>
            </div>
          </div>

          {/* List Area */}
          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar bg-[#0a0a0a]/50">
            {files.length === 0 ? (
              <div className="h-full flex items-center justify-center text-zinc-600 text-xs">
                No files selected.
              </div>
            ) : (
              <ul className="space-y-1">
                <li className="flex justify-between items-center px-2 py-1 mb-2 text-xs font-medium text-zinc-500 border-b border-zinc-800/50">
                  <span>{files.length} FILE{files.length > 1 ? "S" : ""}</span>
                  {!isProcessing && (
                    <button onClick={() => { setFiles([]); setErrorMessage(""); setStatus("idle"); }} className="hover:text-zinc-300">
                      Clear
                    </button>
                  )}
                </li>
                {files.map((file, i) => (
                  <li key={i} className="flex justify-between items-center py-2 px-2 rounded-md hover:bg-zinc-800/30 transition-colors group">
                    <div className="flex items-center gap-3 overflow-hidden">
                      <svg className="w-4 h-4 text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <span className="text-sm text-zinc-300 truncate">{file.name}</span>
                    </div>
                    {!isProcessing && (
                      <button onClick={() => removeFile(i)} className="text-zinc-600 hover:text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Controls Footer */}
          <div className="p-4 border-t border-zinc-800/80 bg-[#0f0f0f]">
            {(isProcessing || status === "done") && (
              <div className="mb-4">
                <div className="flex justify-between text-xs font-medium text-zinc-400 mb-2">
                  <span>
                    {status === "uploading" && "Uploading..."}
                    {status === "queued" && `Queued${queuePosition ? ` (#${queuePosition})` : ""}...`}
                    {status === "converting" && "Converting..."}
                    {status === "done" && <span className="text-zinc-100">Conversion completed</span>}
                  </span>
                  <span>{Math.round(progress)}%</span>
                </div>
                <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
                  <div className="h-full bg-zinc-100 transition-all duration-300 ease-out" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}

            {status === "error" && (
              <div className="mb-4 p-3 rounded-md bg-red-950/30 border border-red-900/50 text-red-500 text-xs">
                {errorMessage}
              </div>
            )}

            <button
              onClick={handleUpload}
              disabled={isProcessing || files.length === 0}
              className="w-full py-2.5 px-4 rounded-md text-sm font-medium transition-colors
                       bg-zinc-100 text-zinc-900 hover:bg-white
                       disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed"
            >
              {status === "done" ? "Convert Again" : "Convert"}
            </button>
          </div>
        </div>
        
        {/* Footer info */}
        <footer className="shrink-0 text-center text-xs text-zinc-600">
          Powered by LibreOffice Headless. All files are processed completely locally inside the container.
        </footer>
      </div>
    </main>
  );
}
