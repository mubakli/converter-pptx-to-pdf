# Architecture Decision Record (ADR) & Technical Design Document

## 1. Core Problem & Requirements
The objective is to build a highly reliable, multi-user web service capable of converting PowerPoint presentations (`.ppt`, `.pptx`) to PDF format. 
**Key constraints & requirements included:**
- **Host Server Safety:** The deployment server is a shared Linux VPS running older Node.js (v18.19) apps that cannot be disrupted.
- **Resource Management:** Presentation formats are mathematically complex. Converting them via headless software is extremely CPU and memory intensive. Concurrent conversions could easily trigger an Out-Of-Memory (OOM) crash.
- **Security & Privacy:** Multiple users will be hitting the service simultaneously. File cross-contamination must be structurally impossible.
- **UX & Localization:** Must gracefully handle Turkish character encoding in file downloads and provide a seamless, unblocked UI for lengthy conversions.

---

## 2. Chosen Technologies & Logical Approaches

### A. Core Framework: Next.js (App Router) + React
**Rationale:** Next.js provides a robust full-stack environment where the frontend UI and the backend File Upload/Conversion API routes comfortably co-exist in a single repository without dealing with CORS or separate CI/CD pipelines.

### B. Conversion Engine: LibreOffice Headless (`libreoffice-convert`)
**Rationale:** Native JavaScript libraries for parsing and rendering PPTX to PDF accurately are practically non-existent or prohibitively expensive (commercial). Open-source LibreOffice is the gold standard for Microsoft Office document compatibility. Running it in "headless" mode enables server-side execution.

### C. State & Job Management: In-Memory Singleton Task Queue
**Rationale:** Instead of immediately spawning a `soffice` conversion process the moment a file hits the `/api/convert` endpoint, the file buffer is written to an isolated `/tmp/uuid` directory, and a "Job" is pushed into an in-memory FIFO (First-In-First-Out) Queue (`src/server/services/queue.ts`). 
The queue strictly caps parallel processing (e.g., `MAX_CONCURRENT_JOBS = 1` or `2`). As jobs finish, the queue automatically triggers the next waiting job.
**Why:** Directly offloading heavy conversions to the event loop would overwhelm the host VPS CPU/RAM during traffic spikes. The queue guarantees sustained server health regardless of traffic blasts.

### D. Client-Server Communication: HTTP Long-Polling & XHR
**Rationale:** When a client uploads files, they receive a `jobId`. The client then polls a lightweight endpoint (`/api/job/[jobId]`) every 2 seconds to fetch its specific queue position, conversion status, or download link. XHR is used on the frontend specifically to capture deterministic `onprogress` bytes-uploaded data for the initial 0-40% of the UI progress bar.

### E. Environment Isolation: Docker & Alpine Linux
**Rationale:** Solves the Node.js versioning conflict on the host machine. The `Dockerfile` pulls `node:20-alpine`, installs LibreOffice and open-source font packs (`font-droid`, `ttf-dejavu`), and binds the internal `next start` process to `0.0.0.0`. This guarantees "it works on my machine" translates flawlessly to the production VPS.

---

## 3. Trade-offs and Rejected Alternatives

### 1. WebSockets vs. HTTP Polling
- **Alternative:** Use WebSockets or Server-Sent Events (SSE) to stream live conversion progress.
- **Why it was rejected:** Next.js App Router (being structurally serverless-first) does not natively support long-lived stateful WebSocket connections without complex custom Node.js HTTP server boilerplate. Additionally, WebSockets are prone to reverse-proxy dropouts (Nginx/Cloudflare) and require custom reconnection logic. A 2-second HTTP polling interval is radically simpler, stateless, proxy-agnostic, and perfectly adequate since LibreOffice conversions typically take 5+ seconds anyway.

### 2. Global Directories vs. UUID Temporary Workspaces
- **Alternative:** The original iteration used static `girdiler/` (inputs) and `ciktilar/` (outputs) folders at the project root.
- **Why it was rejected:** A web service requires session isolation. If User A and User B both upload `presentation.pptx`, a static folder will overwrite files or merge zip archives asynchronously. 
- **Solution:** We dynamically generate `os.tmpdir()/pptx-job-${uuid}` per request. This guarantees 100% cryptographic file isolation. A `setTimeout` Garbage Collection mechanism deletes the `/tmp` folder after 10 minutes or immediately upon a successful download to prevent disk bloat.

### 3. Native `util.promisify` vs. Custom Promise Wrapper
- **Alternative:** Wrapping the legacy LibreOffice callback using standard `util.promisify`.
- **Why it was rejected:** The `libreoffice-convert` NPM package attempts to return a Promise internally, causing Node.js to throw a `DeprecationWarning: Calling promisify on a function that returns a Promise` and a fatal `TypeError` under specific edge cases. Writing a manual `new Promise((resolve, reject) => ...)` wrapper nullified the deprecation warning and guaranteed a clean, crash-free async/await flow.

### 4. Raw Filenames vs. RFC 5987 Header Encoding
- **Alternative:** Directly inserting `filename="${userFile.name}"` into the `Content-Disposition` HTTP Header.
- **Why it was rejected:** Turkish characters (e.g., `İ`, `ş`, `ğ`) possess Unicode byte values exceeding 255. Node.js native `Headers` constructor throws a fatal ByteString `TypeError` when encountering these values, breaking the download endpoint entirely.
- **Solution:** Refactored the API to utilize `RFC 5987` standard: `filename*=UTF-8''${encodeURIComponent(name)}`. This enables modern browsers to safely decode complex UTF-8 filenames without crashing the server's byte-boundary limits.

### 5. "AI-Generated" Glassmorphism UI vs. Minimalist Flat UI
- **Alternative:** Relying on standard modern UI generator tropes (gradient texts, heavy blurs, neon borders).
- **Why it was rejected:** The user specifically requested a highly professional, enterprise-grade aesthetic (akin to Vercel/Stripe). The DOM was heavily refactored to remove all computationally expensive CSS blurs, utilizing brutalist high-contrast solid colors (`bg-zinc-50` / `bg-[#0a0a0a]`) to communicate robust speed and reliability instead of flashiness.
