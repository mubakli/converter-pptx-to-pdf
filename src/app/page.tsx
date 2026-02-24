"use client";

import { useState, useRef } from "react";

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<"idle" | "uploading" | "converting" | "done" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesSelected(Array.from(e.dataTransfer.files));
    }
  };

  const handleFilesSelected = (selectedFiles: File[]) => {
    // Sadece ppt veya pptx dosyalarını filtrele
    const validFiles = selectedFiles.filter(f => 
      f.name.toLowerCase().endsWith(".ppt") || f.name.toLowerCase().endsWith(".pptx")
    );
    
    if (validFiles.length !== selectedFiles.length) {
      alert("Sadece .ppt ve .pptx dosyaları seçebilirsiniz.");
    }

    setFiles((prev) => [...prev, ...validFiles]);
    setStatus("idle");
    setErrorMessage("");
  };

  const removeFile = (indexToRemove: number) => {
    setFiles((prev) => prev.filter((_, index) => index !== indexToRemove));
  };

  const handleUpload = async () => {
    if (files.length === 0) return;

    setStatus("uploading");
    setErrorMessage("");

    const formData = new FormData();
    files.forEach((file) => {
      formData.append("file", file);
    });

    try {
      setStatus("converting");
      const res = await fetch("/api/convert", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        let errMessage = "Bir hata oluştu.";
        try {
          const body = await res.json();
          errMessage = body.error || errMessage;
        } catch {}
        throw new Error(errMessage);
      }

      // İndirme işlemi
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      
      const a = document.createElement("a");
      a.href = url;
      // Eğer tek dosyaysa PDF, çok dosyaysa ZIP döner (Header'dan çekebiliriz ama şimdilik uzantıdan kestiremiyoruz kolayca, header'a bakalım)
      const disposition = res.headers.get("content-disposition");
      let filename = files.length === 1 ? `${files[0].name.split(".")[0]}.pdf` : "Sunum_Ciktilari.zip";
      
      if (disposition && disposition.indexOf('filename=') !== -1) {
        const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
        const matches = filenameRegex.exec(disposition);
        if (matches != null && matches[1]) filename = matches[1].replace(/['"]/g, '');
      }
      
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      setStatus("done");
      // İsteğe bağlı olarak liste temizlenebilir:
      // setFiles([]);
    } catch (error: any) {
      console.error(error);
      setErrorMessage(error.message);
      setStatus("error");
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 font-sans p-6 md:p-12 selection:bg-cyan-500/30">
      {/* Decorative Gradients */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">
        <div className="absolute -top-[20%] -left-[10%] w-[50%] h-[50%] rounded-full bg-indigo-900/20 blur-[120px]" />
        <div className="absolute -bottom-[20%] -right-[10%] w-[50%] h-[50%] rounded-full bg-cyan-900/20 blur-[120px]" />
      </div>

      <div className="max-w-4xl mx-auto space-y-8">
        <header className="text-center space-y-4">
          <div className="inline-block p-3 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 mb-2">
            <svg className="w-10 h-10 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-cyan-400 to-teal-400 pb-2">
            PPTX → PDF Dönüştürücü
          </h1>
          <p className="text-slate-400 text-lg max-w-2xl mx-auto font-light">
            Sunumlarınızı sürükleyip bırakın, anında yüksek kaliteli PDF formatında veya topluca ZIP olarak cihazınıza indirin.
          </p>
        </header>

        {/* Drag & Drop Alanı */}
        <div
          className={`glass-panel border-2 border-dashed transition-all duration-300 relative overflow-hidden group ${
            isDragging ? "border-cyan-400 bg-cyan-900/20" : "border-slate-700/60 hover:border-indigo-500/50"
          }`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleFileDrop}
        >
          <div className="p-12 flex flex-col items-center justify-center text-center space-y-4">
            <div className="p-4 rounded-full bg-slate-800/80 group-hover:bg-indigo-500/20 transition-colors duration-300">
              <svg className="w-8 h-8 text-slate-400 group-hover:text-indigo-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <div>
              <p className="text-lg font-medium text-slate-300">
                Dosyaları sürükleyip buraya bırakın
              </p>
              <p className="text-sm text-slate-500 mt-1">veya bilgisayarınızdan seçin.</p>
            </div>
            
            <input
              type="file"
              multiple
              accept=".ppt,.pptx"
              className="hidden"
              ref={fileInputRef}
              onChange={(e) => {
                if (e.target.files) handleFilesSelected(Array.from(e.target.files));
                e.target.value = ""; // Aynı dosyayı seçmeye izin ver
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-6 py-2.5 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 hover:border-slate-600 text-slate-200 font-medium transition-colors shadow-sm"
              disabled={status === "converting" || status === "uploading"}
            >
              Dosya Seç
            </button>
          </div>
        </div>

        {/* Dosya Listesi ve İşlem Butonu */}
        {files.length > 0 && (
          <div className="glass-panel p-6 space-y-6 animate-in slide-in-from-bottom-4 fade-in duration-500">
            <div className="flex justify-between items-center border-b border-slate-700/50 pb-4">
              <h3 className="text-lg font-semibold text-slate-200 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-indigo-400"></span>
                Seçilen Dosyalar ({files.length})
              </h3>
              {(status === "idle" || status === "error" || status === "done") && (
                <button 
                  onClick={() => setFiles([])}
                  className="text-sm text-slate-400 hover:text-red-400 transition-colors"
                >
                  Listeyi Temizle
                </button>
              )}
            </div>

            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
              {files.map((file, i) => (
                <li key={i} className="flex justify-between items-center p-3 rounded-lg bg-slate-900/50 border border-slate-800 hover:border-slate-700 transition-colors group">
                  <div className="flex items-center gap-3 overflow-hidden">
                    <svg className="w-5 h-5 text-indigo-400 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM6 20V4h5v7h7v9H6z"/>
                    </svg>
                    <span className="text-sm font-medium text-slate-300 truncate" title={file.name}>
                      {file.name}
                    </span>
                  </div>
                  {(status === "idle" || status === "error" || status === "done") && (
                    <button
                      onClick={() => removeFile(i)}
                      className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded-md transition-colors shrink-0"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {/* Hata Mesajı */}
            {status === "error" && (
              <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 flex gap-3 text-red-400">
                <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <p className="text-sm font-medium">{errorMessage}</p>
              </div>
            )}

            {/* Başarı Mesajı */}
            {status === "done" && (
              <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex justify-between items-center text-emerald-400">
                <div className="flex gap-3">
                  <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-sm font-medium">Dönüştürme başarılı! Dosyanız inmeye başladı.</p>
                </div>
              </div>
            )}

            {/* Aksiyon Butonu */}
            <button
              onClick={handleUpload}
              disabled={status === "uploading" || status === "converting" || files.length === 0}
              className="w-full relative overflow-hidden group py-4 px-6 rounded-xl font-bold tracking-wide transition-all shadow-lg 
                       bg-gradient-to-r from-indigo-500 to-cyan-500 hover:from-indigo-400 hover:to-cyan-400
                       disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:from-indigo-500 disabled:hover:to-cyan-500"
            >
              <div className="absolute inset-0 w-full h-full bg-white/20 -translate-x-full group-hover:animate-[shimmer_1.5s_infinite] pointer-events-none" />
              
              <div className="flex items-center justify-center gap-2 text-white">
                {status === "idle" || status === "error" ? (
                  <>
                    <span>Dönüştürmeyi Başlat</span>
                    <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  </>
                ) : status === "uploading" ? (
                  <>
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>Dosyalar Yükleniyor...</span>
                  </>
                ) : status === "converting" ? (
                  <>
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>Dönüştürülüyor... Bu biraz zaman alabilir</span>
                  </>
                ) : (
                  <span>Yeniden Başlat</span>
                )}
              </div>
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
