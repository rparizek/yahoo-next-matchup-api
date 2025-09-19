# Deploy (DreamHost, Passenger)


1) Upload all files in this folder to `/home/<user>/api.yourdomain.com/` via SFTP.
2) Create a `.env` in that same folder by copying `.env.example` and filling your secrets.
3) Ensure the domain has HTTPS enabled in DreamHost panel.
4) Restart Passenger by touching `tmp/restart.txt` (upload again or re-save the file).
5) Test `https://api.yourdomain.com/health` → `{ ok: true }`.