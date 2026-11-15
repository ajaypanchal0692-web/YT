# YouTube AI Factory — Release 2

A cloud-only single-channel YouTube production system for English, Hindi and Marathi. The browser is the only thing used on your computer. Script generation, AI image generation, narration, rendering, storage and uploads run on cloud services.

## What is included
- Cloudflare Worker API with D1, R2 and Workers AI bindings.
- Google OAuth authorization-code flow with one-time state and AES-256-GCM encrypted refresh tokens.
- Cloudflare Workers AI FLUX.1 Schnell scene generation; scene images are stored in private R2.
- GitHub Actions cloud rendering using Gemini text generation (required free-tier key), Edge TTS voices, FFmpeg Ken Burns motion, captions and thumbnails.
- Dashboard for one channel and three languages.
- Approval uploads as PRIVATE. A separate dashboard action changes a reviewed private video to PUBLIC.
- Signed R2 media URLs with 60-minute expiry.

## Important zero-cost limitations
- No paid plan, subscription or paid AI key is required by the design. Free quotas are finite and can change. The system must pause when a quota is exhausted rather than incur charges.
- Cloudflare Workers AI has a shared free allocation of 10,000 neurons/day. FLUX uses that allocation.
- R2 has a 10 GB-month free standard-storage allowance. Set an R2 lifecycle rule to expire `jobs/` objects after 30 days and monitor storage.
- GitHub-hosted standard runners are free/unlimited for public repositories. Public repository source is visible; secrets remain GitHub Actions secrets.
- Gemini free-tier model availability/quotas change. A free-tier Gemini API key is required for script generation; without it, the render fails safely.
- Edge TTS uses an unofficial no-key cloud client interface, not a contractual SLA. It may change or throttle; verify applicable provider terms before monetized commercial use. It is a replaceable voice provider.
- Cinematic scenes are AI-generated still images animated with pans/zooms and transitions. This is not true generative text-to-video.
- No background music is added by default. Add only music you own or have licensed.
- YouTube OAuth in Testing mode may issue refresh tokens that expire after 7 days. Configure OAuth publishing status to Production before relying on unattended publishing.

## Setup: no local processing
Use GitHub Codespaces or Cloudflare's browser dashboard for setup if you do not want to install development tools on your PC. The production system runs on GitHub-hosted cloud runners.

### 1. Cloudflare
1. Create D1 database `ytfactory`.
2. Create R2 bucket `ytfactory-media`.
3. Add an R2 lifecycle rule to expire objects under `jobs/` after 30 days.
4. Enable Workers AI.
5. Create Worker from `worker/index.js`.
6. Bind D1 as `DB`, R2 as `MEDIA`, Workers AI as `AI`.
7. Run `schema.sql` against D1.
8. Replace `database_id`, `GITHUB_OWNER`, `GITHUB_REPO` and `WORKER_ORIGIN` in `wrangler.toml`.
9. Deploy using Wrangler from GitHub Codespaces:
   - `npm install -g wrangler`
   - `wrangler login`
   - `wrangler d1 execute ytfactory --remote --file=schema.sql`
   - `wrangler deploy`

Worker secrets:
- `APP_TOKEN`: long random dashboard/render API bearer token.
- `PUBLISHER_TOKEN`: separate long random secret used only by the private upload workflow.
- `GITHUB_TOKEN`: fine-grained GitHub token with Actions:write permission on this repository.
- `GOOGLE_CLIENT_ID`: Google OAuth Web application ID.
- `GOOGLE_CLIENT_SECRET`: Google OAuth client secret.
- `GOOGLE_REDIRECT_URI`: exact Worker URL ending `/oauth/callback`.
- `TOKEN_ENCRYPTION_KEY`: base64 encoding of 32 random bytes.
- `MEDIA_SIGNING_KEY`: long random signing secret.

Generate keys in a cloud shell:
- `openssl rand -hex 32` for APP_TOKEN, PUBLISHER_TOKEN and MEDIA_SIGNING_KEY.
- `openssl rand -base64 32` for TOKEN_ENCRYPTION_KEY.

### 2. Google OAuth / YouTube
1. Create a Google Cloud project and enable YouTube Data API v3.
2. Configure OAuth consent screen as External.
3. Add your account as a test user for initial testing.
4. Create OAuth client ID of type Web application.
5. Add exact Worker callback URL as an authorized redirect URI.
6. Add the Google OAuth secrets to the Worker.
7. Set publishing status to Production before unattended use. Testing mode has a seven-day refresh-token expiry for these scopes.
8. Connect your channel from the dashboard.

Requested scopes:
- `youtube.upload` for uploading.
- `youtube` for the explicit API action to change a private upload to public. This is a broader account permission; review the consent carefully.

### 3. GitHub
1. Create a **public** repository and upload the project contents.
2. Enable GitHub Actions.
3. Add repository secrets:
   - `WORKER_API_URL` — Worker base URL, no trailing slash.
   - `APP_TOKEN` — same dashboard/render token as Worker.
   - `PUBLISHER_TOKEN` — separate publisher-only token matching the Worker secret.
   - `GEMINI_API_KEY` — free-tier key from Google AI Studio; use only models with a currently available free tier.
4. Keep workflow files on the default branch `main`.
5. Configure Worker vars `GITHUB_OWNER` and `GITHUB_REPO`; set `GITHUB_TOKEN` Worker secret with Actions:write permission.

### 4. Dashboard
1. Edit `public/config.js` with Worker URL and APP_TOKEN.
2. Deploy the `public/` folder to Cloudflare Pages.
3. Protect the Pages hostname using Cloudflare Access; allow only your own identity.
4. Add one channel.
5. Click Connect YouTube and complete Google consent.
6. Create a short English test video, then test Hindi and Marathi separately.

### 5. Workflow
1. Dashboard creates job and dispatches `render.yml`.
2. GitHub runner asks Gemini for a localized script and six visual prompts.
3. Worker AI generates six FLUX images and stores them in R2.
4. Edge TTS generates the selected language narration.
5. FFmpeg applies Ken Burns motion, assembles scenes and burns captions.
6. Runner uploads MP4 and thumbnail to R2; job becomes Ready.
7. Owner reviews the preview and clicks Approve & upload privately.
8. Worker dispatches `publish.yml`; the runner receives a short-lived access token and signed media URL.
9. YouTube receives a PRIVATE upload; the thumbnail is set.
10. Owner reviews it in YouTube Studio and separately clicks Publish publicly.

## Secrets and security
Never commit secrets, OAuth tokens, MP4 files or private channel data. Keep Cloudflare Access enabled. Rotate APP_TOKEN if exposed. Refresh tokens are encrypted in D1 using AES-GCM. A separate `PUBLISHER_TOKEN` protects upload-token endpoints from the dashboard. Access tokens are only delivered to the approved upload runner and are never written to logs. Signed R2 URLs expire after 60 minutes.

## Current implementation boundary
This is a source package, not an already deployed service. You must create cloud accounts, configure bindings and secrets, deploy, authorize the channel and test the first private upload. I cannot authorize your Google account or deploy into your Cloudflare/GitHub accounts without your account-side setup.
