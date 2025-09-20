// CommonJS server for Render
const express = require("express");
const session = require("cookie-session");
const cors = require("cors");
const fetch = require("node-fetch"); // v2 for CJS
require("dotenv").config();

const app = express();
app.set("trust proxy", 1); // Render uses reverse proxy

// --- Config from env ---
const {
  YAHOO_CLIENT_ID,
  YAHOO_CLIENT_SECRET,
  YAHOO_REDIRECT_URI, // e.g. https://<service>.onrender.com/auth/callback
  SESSION_SECRET,
  APP_ORIGIN, // e.g. https://app.vanillabeansolutions.com
  PORT = 10000, // Render provides PORT
} = process.env;

const OAUTH_AUTHORIZE = "https://api.login.yahoo.com/oauth2/request_auth";
const OAUTH_TOKEN = "https://api.login.yahoo.com/oauth2/get_token";
const FANTASY_API = "https://fantasysports.yahooapis.com/fantasy/v2";

app.use(express.json());
app.use(
  session({
    name: "yahoo_sess",
    secret: SESSION_SECRET || "change_me",
    httpOnly: true,
    sameSite: "lax",
    secure: true, // HTTPS on Render
  })
);

app.use(
  cors({
    origin: [APP_ORIGIN],
    credentials: true,
  })
);

app.get("/health", (_req, res) => res.json({ ok: true }));

// ------- OAuth -------
app.get("/auth/callback", async (req, res) => {
  try {
    const { code, error, error_description } = req.query;
    if (error) {
      console.error("[callback] Yahoo error:", error, error_description);
      return res.status(400).send(`Yahoo error: ${error} - ${error_description}`);
    }
    if (!code) {
      console.error("[callback] Missing ?code");
      return res.status(400).send("Missing code");
    }

    const { YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_REDIRECT_URI, APP_ORIGIN } = process.env;
    if (!YAHOO_CLIENT_ID || !YAHOO_CLIENT_SECRET || !YAHOO_REDIRECT_URI) {
      console.error("[callback] Missing env", {
        hasId: !!YAHOO_CLIENT_ID, hasSecret: !!YAHOO_CLIENT_SECRET, hasRedirect: !!YAHOO_REDIRECT_URI
      });
      return res.status(500).send("Server misconfigured: missing Yahoo env vars");
    }

    const auth = Buffer.from(`${YAHOO_CLIENT_ID}:${YAHOO_CLIENT_SECRET}`).toString("base64");
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("redirect_uri", YAHOO_REDIRECT_URI);
    body.set("code", code);

    console.log("[callback] exchanging code…");
    const tokenResp = await fetch("https://api.login.yahoo.com/oauth2/get_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const text = await tokenResp.text();
    let tok;
    try { tok = JSON.parse(text); } catch { tok = { raw: text }; }

    console.log("[callback] token status", tokenResp.status);
    if (!tokenResp.ok) {
      console.error("[callback] token error body:", tok);
      return res.status(502).send(`Token exchange failed: ${tokenResp.status}`);
    }

    // Expecting JSON with access_token / refresh_token
    if (!tok.access_token) {
      console.error("[callback] no access_token in body:", tok);
      return res.status(502).send("Token exchange returned no access_token");
    }

    req.session.token = tok.access_token;
    req.session.refresh_token = tok.refresh_token;
    req.session.token_exp = Math.floor(Date.now() / 1000) + (tok.expires_in || 3500);

    console.log("[callback] token ok, redirecting to app");
    return res.redirect(APP_ORIGIN || "/");
  } catch (e) {
    console.error("[callback] exception:", e);
    return res.status(502).send("Auth callback exception");
  }
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
    const tok = await tokenResp.json();
    if (!tokenResp.ok) return res.status(500).send(`Token exchange failed: ${tokenResp.status}`);

    req.session.token = tok.access_token;
    req.session.refresh_token = tok.refresh_token;
    req.session.token_exp = Math.floor(Date.now() / 1000) + (tok.expires_in || 3500);

    // back to your React app on DreamHost
    return res.redirect(APP_ORIGIN || "/");
  } catch (e) {
    console.error("callback err", e);
    return res.status(500).send("Auth callback exception");
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
  try {
    const j = await yFetch(req.session, "/users;use_login=1");
    res.json(j);
  } catch {
    res.status(500).json({ error: "me_failed" });
  }
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
            team_name,
            team_key,
            league_key,
          };
        }
      }
      return null;
    };

    let next = null;
    for (let w = current_week; w < current_week + 4; w++) {
      next = await findWeek(w);
      if (next) break;
    }
    if (!next) return res.status(404).json({ error: "no_upcoming_matchup" });
    res.json(next);
  } catch {
    res.status(500).json({ error: "matchup_failed" });
  }
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
