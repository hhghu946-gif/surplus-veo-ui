# Surplus Veo UI

A tiny self-hosted image-to-video web interface for the Surplus Intelligence video generation API.

## Coolify deployment

1. Put these files in a GitHub repository.
2. In Coolify choose **New Resource → Application → Git Repository**.
3. Use the included `Dockerfile`.
4. Set the application port to **3000**.
5. Add these environment variables in Coolify:

```env
SURPLUS_API_KEY=inf_your_real_key
SURPLUS_API_URL=https://api.surplusintelligence.ai
SURPLUS_VIDEO_MODEL=veo3-fast-image-to-video
PORT=3000
```

6. Deploy.
7. Open `/health` to verify the container is running.
8. Point your Pangolin resource to this application's internal/private address and port 3000.

## Important model ID note

Surplus recommends checking the live `/v1/models` catalog because model IDs and availability can change.
The UI exposes the model field so you can replace the default without rebuilding the app.

## Security

- The Surplus API key is server-side only.
- Do not place the API key in frontend JavaScript.
- Keep the site behind Pangolin authentication if it is for private use.
- Reference image uploads are held in memory only for the request and are not written to disk by this app.

## API flow

- `POST /api/generate` → server calls Surplus `POST /v1/video/generations`
- `GET /api/status/:id` → server polls Surplus `GET /v1/video/generations/:id`
- Browser displays the returned video artifact URL after success.
