# Video Downloader Backend

Robust Node.js + yt-dlp API for downloading video and audio.

## Prerequisites

- Node.js ≥ 18
- Python + yt-dlp: `pip install yt-dlp`
- ffmpeg (for merging video+audio): `apt install ffmpeg` / `brew install ffmpeg`

## Setup

```bash
npm install
cp .env.example .env
npm start
```

## API Reference

### `GET /api/health`
Health check.

---

### `POST /api/info`
Fetch video metadata and available formats.

**Body:** `{ "url": "https://..." }`

**Response:**
```json
{
  "title": "Video title",
  "thumbnail": "https://...",
  "duration": 245,
  "uploader": "Channel name",
  "formats": [
    { "formatId": "137", "ext": "mp4", "resolution": "1920x1080", ... }
  ]
}
```

---

### `GET /api/download`
Download a video/audio file (uses temp file on disk, then streams).

| Query param | Required | Description |
|---|---|---|
| `url` | ✅ | Video URL |
| `formatId` | ❌ | yt-dlp format id (from `/api/info`) |
| `audioOnly` | ❌ | `"true"` to extract MP3 audio |

**Example:**
```
GET /api/download?url=https://youtu.be/dQw4w9WgXcQ&formatId=137
GET /api/download?url=https://youtu.be/dQw4w9WgXcQ&audioOnly=true
```

---

### `GET /api/stream`
Stream video directly from yt-dlp stdout (no temp file needed).

| Query param | Required | Description |
|---|---|---|
| `url` | ✅ | Video URL |
| `formatId` | ❌ | yt-dlp format id |

---

### `GET /api/formats/presets`
Returns opinionated format presets (Best, 1080p, 720p, 480p, MP3).

---

## Rate Limiting
20 requests per minute per IP address.

## Security
- Helmet.js headers
- URL validation (http/https only)
- Filename sanitization
- Temp file cleanup on completion and server shutdown
- Client disconnect handling (kills yt-dlp process)
