<div align="center">

<img src="frontend/public/icon.png" alt="Monet" width="120" />

# Monet

### Turn your impressions into software

</div>

---

Monet is the real-time canvas where **voice and sketch become working apps**. It combines natural voice conversation with freehand sketching to generate fully functional React applications — all in real time. Speak your ideas, draw your layouts, and watch Monet bring them to life.

---

## What It Does

Monet reimagines software creation as a conversation. Instead of typing prompts into a text box, you **talk** to an AI assistant while **sketching** on a canvas, and it builds your app live.

| Capability                  | Description                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Voice-First Interaction** | Speak naturally with Monet using the Gemini Live API. It listens, responds with voice, and handles interruptions seamlessly.                   |
| **Sketch-to-Code**          | Draw rough layouts on the canvas with a blue pen. Monet sees your annotations as visual instructions and translates them into real components. |
| **Live Preview**            | See your app update in real time as code is generated — actual React code running in the browser, not a mockup.                                |
| **Image Generation**        | Draw a rough composition in the image frame, describe what you want, and Monet generates a polished image and integrates it into your app.     |
| **Upload References**       | Drop in reference images (screenshots, design mockups, photos) and Monet uses them as context for code and image generation.                   |
| **One-Click Deploy**        | Save and share your creation with a unique URL. Deployed apps are persisted and viewable by anyone.                                            |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   Frontend (Next.js)                     │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │   tldraw    │  │    Voice     │  │   Sandpack     │  │
│  │   Canvas    │  │   Controls   │  │  Live Preview  │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
│                          │                               │
│              WebSocket (binary PCM + JSON)                │
└──────────────────────────┬───────────────────────────────┘
                           │
                    Cloud Run (GCP)
                           │
┌──────────────────────────┴───────────────────────────────┐
│                  Backend (FastAPI + ADK)                  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │          Orchestrator Agent (Gemini Live)          │  │
│  │   Model: gemini-live-2.5-flash-native-audio       │  │
│  │   Mode: BIDI streaming with voice I/O             │  │
│  │                                                    │  │
│  │   - Real-time speech recognition & synthesis       │  │
│  │   - Multimodal input (voice + canvas + images)     │  │
│  │   - Natural interruption handling (barge-in)       │  │
│  │   - Affective dialog & proactive audio             │  │
│  └──────────┬────────────────────────┬───────────────┘  │
│             │                        │                   │
│  ┌──────────▼──────────┐  ┌─────────▼─────────────┐    │
│  │    Code Agent       │  │    Image Agent         │    │
│  │                     │  │                        │    │
│  │ gemini-3-flash      │  │ gemini-3.1-flash       │    │
│  │                     │  │ -image-preview         │    │
│  │ Tools:              │  │                        │    │
│  │ - list_files        │  │ Canvas frame →         │    │
│  │ - read_file         │  │ polished image →       │    │
│  │ - write_file        │  │ upload to GCS          │    │
│  │ - edit_file         │  │                        │    │
│  │ - delete_file       │  │                        │    │
│  └─────────────────────┘  └────────────────────────┘    │
│                                                          │
└──────────────────────────┬───────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   ┌────▼─────┐    ┌──────▼──────┐    ┌──────▼──────┐
   │ Vertex AI│    │  Cloud SQL  │    │    GCS      │
   │ (Models) │    │ (PostgreSQL)│    │  (Storage)  │
   └──────────┘    └─────────────┘    └─────────────┘
```

### Data Flow

1. **User speaks** → Frontend captures PCM audio at 16 kHz and streams it over WebSocket
2. **User draws** → Canvas annotations are captured as screenshots and sent as image blobs
3. **Orchestrator** receives multimodal input via Gemini Live API (BIDI streaming mode)
4. **Orchestrator decides** whether to call `generate_code` or `generate_image` (only after user approval)
5. **Code Agent** generates/edits React + TypeScript + Tailwind files using ADK tools
6. **Image Agent** takes the canvas frame as a composition reference, generates a polished image, and uploads to GCS
7. **Results stream back** → Frontend applies file changes to the live Sandpack preview in real time
8. **Orchestrator narrates** the result via voice output

---

## Technologies Used

| Layer               | Technology                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| **AI Models**       | Gemini Live 2.5 Flash (native audio), Gemini 3 Flash, Gemini 3.1 Flash Lite, Gemini 3.1 Flash Image |
| **Agent Framework** | Google Agent Development Kit (ADK)                                                                  |
| **Backend**         | Python 3.12, FastAPI, Uvicorn, WebSockets                                                           |
| **Frontend**        | Next.js 16, React 19, TypeScript, Tailwind CSS                                                      |
| **Canvas**          | tldraw for freehand drawing                                                                         |
| **Code Execution**  | Sandpack (CodeSandbox) for in-browser React rendering                                               |
| **Cloud Hosting**   | Google Cloud Run (backend), Vercel (frontend)                                                       |
| **Database**        | Google Cloud SQL (PostgreSQL)                                                                       |
| **Object Storage**  | Google Cloud Storage for images, uploads, and thumbnails                                            |
| **CI/CD**           | GitHub Actions → Cloud Run (Workload Identity Federation)                                           |

---

## Google Cloud Deployment

The backend is hosted on **Google Cloud Run** and deployed automatically via GitHub Actions on every push to `main`.

| Service           | Role                                                                       |
| ----------------- | -------------------------------------------------------------------------- |
| **Cloud Run**     | Serves the FastAPI backend with auto-scaling and managed TLS               |
| **Vertex AI**     | Hosts all Gemini model endpoints (Live, code generation, image generation) |
| **Cloud SQL**     | PostgreSQL instance for deployment metadata persistence                    |
| **Cloud Storage** | Stores uploaded images, generated images, and app thumbnails               |

The CI/CD pipeline uses `google-github-actions/auth` with **Workload Identity Federation** — no service account keys are stored in the repository.

---

## Getting Started

### Prerequisites

- Python 3.12+, Node.js 20+, `gcloud` CLI
- A Google Cloud project with the following APIs enabled:
  - **Vertex AI** (for Gemini models)
  - **Cloud SQL Admin** (for PostgreSQL)
  - **Cloud Storage** (for file uploads)

### 1. Set Up Google Cloud Resources

```bash
# Authenticate
gcloud auth login
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID

# Create a Cloud SQL PostgreSQL instance
gcloud sql instances create monet-db \
  --database-version=POSTGRES_15 \
  --region=us-central1 \
  --tier=db-f1-micro
gcloud sql databases create monet --instance=monet-db

# Create a GCS bucket
gcloud storage buckets create gs://YOUR_BUCKET_NAME --location=us-central1
```

### 2. Run the Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env   # then edit .env — see table below
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

| Variable                    | Value                                                           |
| --------------------------- | --------------------------------------------------------------- |
| `GOOGLE_GENAI_USE_VERTEXAI` | `TRUE`                                                          |
| `GOOGLE_CLOUD_PROJECT`      | Your GCP project ID                                             |
| `GOOGLE_CLOUD_LOCATION`     | `us-central1`                                                   |
| `GCS_BUCKET`                | Your GCS bucket name                                            |
| `CLOUD_SQL_CONNECTION_NAME` | `project:region:instance` (e.g. `my-proj:us-central1:monet-db`) |
| `DB_NAME`                   | `monet`                                                         |
| `DB_USER`                   | `postgres`                                                      |
| `DB_PASSWORD`               | Your Cloud SQL password                                         |

### 3. Run the Frontend

```bash
cd frontend
npm install
cp .env.example .env.local   # then edit .env.local — see table below
npm run dev
```

| Variable                     | Value                   |
| ---------------------------- | ----------------------- |
| `NEXT_PUBLIC_BACKEND_WS_URL` | `ws://localhost:8000`   |
| `NEXT_PUBLIC_BACKEND_URL`    | `http://localhost:8000` |

Open **[http://localhost:3000](http://localhost:3000)** in your browser.

### 4. Deploy to Google Cloud

**Backend → Cloud Run:**

```bash
gcloud run deploy monet-backend \
  --source backend \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "\
GOOGLE_GENAI_USE_VERTEXAI=TRUE,\
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,\
GOOGLE_CLOUD_LOCATION=us-central1,\
GCS_BUCKET=YOUR_BUCKET_NAME,\
CLOUD_SQL_CONNECTION_NAME=YOUR_CONNECTION_NAME,\
FRONTEND_ORIGINS=https://your-app.vercel.app"
```

**Frontend → Vercel:**

```bash
cd frontend && npx vercel --prod
```

Pushes to `main` also trigger automatic backend deployment via the GitHub Actions CI/CD pipeline.

---

## What We Learned

- **Voice UX requires guardrails.** Without explicit approval gates, the agent would eagerly start generating code from partial sentences. The plan-then-approve workflow was essential for usability.
- **Multimodal context is more than the sum of its parts.** Combining voice ("make it bigger"), canvas annotations (circles around elements), and live preview screenshots gave the agent far richer understanding than any single modality alone.
- **Streaming architecture matters.** The BIDI streaming mode of Gemini Live, combined with WebSocket binary frames for audio, keeps latency low enough for natural conversation. Buffering or polling would break the experience.
- **ADK simplifies agent orchestration.** The Google Agent Development Kit's `Runner` and `LiveRequestQueue` abstractions handled the complexity of managing concurrent tool calls, session state, and streaming — letting us focus on the product.
- **Sketching is an underrated input modality.** Users find it far more natural to circle an element and say "change this" than to describe it in words. The canvas bridges the gap between intention and instruction.

---

Built for the [Gemini Live Agent Challenge](https://geminiliveagentchallenge.devpost.com/)
