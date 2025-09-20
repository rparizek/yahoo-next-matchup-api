// app.js (CommonJS) — Known-good minimal API for Render
const express = require("express");
const session = require("cookie-session");
const cors = require("cors");
const fetch = require("node-fetch"); // v2
if (process.env.NODE_ENV !== "production") { require("dotenv").config(); }

const app = express();
app.set("trust proxy", 1);

// --- ENV ---
const {
  YAHOO_CLIENT_ID,
  YAHOO_CLIENT_SECRET,
  YAHOO_REDIRECT_URI,          // e.g. https://yahoo-next-matchup-api.onrender.com/auth/callback
  APP_ORIGIN,                  // e.g. https://lab.vanillabeansolutions.com/yahoo-next-match/
  SESSION_SECRET,
  PORT = process.env.PORT || 10000,
} = process.env;

// --- MIDDLEWARE ---
app.use(express.json());
app.use(session({
  name: "yahoo_sess",
  secret: SESSION_SECRET || "changeme",
  httpOnly: true,
  sameSite: "lax",
  secure: true, // Render = HTTPS
}));
app.use(cors({
  origin: [APP_ORIGIN],
  credentials: true,
}));

// --- ROUTES ---
app.get("/", (_req, res) => res.send("Yahoo Next Matchup API is running"));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/_env-check", (_req, res) => {
  const id = process.env.YAHOO_CLIENT_ID || "";
  const sec = process.env.YAHOO_CLIENT_SECRET || "";
  res.json({
    hasId: !!id,
    idLen: id.length,
    idSample: id ? `${id.slice(0,4)}...${id.slice(-4)}` : null,
    hasSecret: !!sec,
    secretLen: sec.length,
    hasRedirect: !!process.env.YAHOO_REDIRECT_URI,
    redirect: process.env.YAHOO_REDIRECT_URI || null
  });
});


const OAUTH_AUTHORIZE = "https://api.login.yahoo.com/oauth2/request_auth";
const OAUTH_TOKEN = "https://api.login.yahoo.com/oauth2/get_token";
const FANTASY_API = "https://fantasysports.yahooapis.com/fantasy/v2";

app.get("/auth/login", (req, res) => {
  if (!YAHOO_CLIENT_ID || !YAHOO_CLIENT_SECRET || !YAHOO_REDIRECT_URI) {
    return res.status(500).send("Server misconfigured: missing Yahoo env vars");
  }
  const params = new URLSearchParams({
    client_id: YAHOO_CLIENT_ID,
    redirect_uri: YAHOO_REDIRECT_URI,
    response_type: "code",
    language: "en-us",
    scope: "fspt-r openid profile",
  });
  res.redirect(`${OAUTH_AUTHORIZE}?${params.toString()}`);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { code, error, error_description } = req.query;
    if (error) return res.status(400).send(`Yahoo error: ${error} - ${error_description}`);
    if (!code) return res.status(400).send("Missing code");

    const auth = Buffer.from(`${YAHOO_CLIENT_ID}:${YAHOO_CLIENT_SECRET}`).toString("base64");
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("redirect_uri", YAHOO_REDIRECT_URI);
    body.set("code", code);

    const tokenResp = await fetch(OAUTH_TOKEN, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const text = await tokenResp.text();
    let tok; try { tok = JSON.parse(text); } catch { tok = { raw: text }; }
    if (!tokenResp.ok || !tok.access_token) {
      console.error("[callback] token error", tokenResp.status, tok);
      return res.status(502).send(`Token exchange failed: ${tokenResp.status}`);
    }

    req.session.token = tok.access_token;
    req.session.refresh_token = tok.refresh_token;
    req.session.token_exp = Math.floor(Date.now() / 1000) + (tok.expires_in || 3500);

    return res.redirect(APP_ORIGIN || "/");
  } catch (e) {
    console.error("[callback] exception:", e);
    return res.status(502).send("Auth callback exception");
  }
});

function authed(req, res, next) {
  if (!req.session?.token) return res.status(401).json({ error: "not_authed" });
  next();
}

async function yFetch(sess, path) {
  const url = `${FANTASY_API}${path}${path.includes("?") ? "&" : "?"}format=json`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${sess.token}` } });
  if (!r.ok) {
    const t = await r.text();
    console.error("[Yahoo API]", r.status, url, t);
    throw new Error(`Yahoo API ${r.status}`);
  }
  return r.json();
}

const getByName = (arr, name) =>
  Array.isArray(arr) ? (arr.find(x => Array.isArray(x) && x[0]?.name === name)?.[0]?.value) : undefined;

app.get("/api/me", authed, async (req, res) => {
  try { res.json(await yFetch(req.session, "/users;use_login=1")); }
  catch { res.status(500).json({ error: "me_failed" }); }
});

app.get("/api/next-matchup", authed, async (req, res) => {
  try {
    const j = await yFetch(req.session, "/users;use_login=1/games/teams");
    const user = j?.fantasy_content?.users?.[0]?.user;
    const games = user?.[1]?.games?.[0]?.game || [];

    let team_key, league_key, team_name;
    for (const g of games) {
      const teams = g?.[1]?.teams?.[0]?.team || [];
      for (const t of teams) {
        const tk = t?.[0]?.team_key || getByName(t, "team_key");
        if (tk) {
          team_key = tk;
          league_key = getByName(t, "league_key");
          team_name = getByName(t, "name");
          break;
        }
      }
      if (team_key) break;
    }
    if (!team_key || !league_key) return res.status(404).json({ error: "no_team" });

    const sc = await yFetch(req.session, `/league/${league_key}/scoreboard`);
    const league = sc?.fantasy_content?.league?.[0]?.league;
    const current_week = parseInt(getByName(league, "current_week") || "1", 10);

    const findWeek = async (w) => {
      const s = await yFetch(req.session, `/league/${league_key}/scoreboard;week=${w}`);
      const ms = s?.fantasy_content?.league?.[1]?.scoreboard?.[0]?.matchups?.[0]?.matchup || [];
      for (const m of ms) {
        const ts = m?.[0]?.teams?.[0]?.team || [];
        const aKey = getByName(ts?.[0], "team_key");
        const bKey = getByName(ts?.[1], "team_key");
        if (aKey === team_key || bKey === team_key) {
          return {
            week: w,
            you: aKey === team_key ? getByName(ts?.[0], "name") : getByName(ts?.[1], "name"),
            opponent: aKey === team_key ? getByName(ts?.[1], "name") : getByName(ts?.[0], "name"),
            week_start: getByName(m, "week_start"),
            week_end: getByName(m, "week_end"),
            team_name, team_key, league_key,
          };
        }
      }
      return null;
    };

    let next = null;
    for (let w = current_week; w < current_week + 4; w++) { next = await findWeek(w); if (next) break; }
    if (!next) return res.status(404).json({ error: "no_upcoming_matchup" });
    res.json(next);
  } catch { res.status(500).json({ error: "matchup_failed" }); }
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
