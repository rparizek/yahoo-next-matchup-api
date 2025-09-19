import express from "express";


const getByName = (arr, name) =>
Array.isArray(arr) ? (arr.find((x) => Array.isArray(x) && x[0]?.name === name)?.[0]?.value) : undefined;


app.get("/api/me", authed, async (req, res) => {
try {
const j = await yFetch(req.session, "/users;use_login=1");
res.json(j);
} catch (e) {
res.status(500).json({ error: "me_failed" });
}
});


app.get("/api/next-matchup", authed, async (req, res) => {
try {
const j = await yFetch(req.session, "/users;use_login=1/games/teams");
const user = j?.fantasy_content?.users?.[0]?.user;
const games = user?.[1]?.games?.[0]?.game || [];


let teamNode, team_key, league_key, team_name;
for (const g of games) {
const teams = g?.[1]?.teams?.[0]?.team || [];
for (const t of teams) {
const tk = t?.[0]?.team_key || getByName(t, "team_key");
if (tk) {
teamNode = t;
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
} catch (e) {
res.status(500).json({ error: "matchup_failed" });
}
});


const PORT = process.env.PORT || 8080; // Passenger sets PORT
app.listen(PORT, () => {
console.log(`Server listening on :${PORT}`);
});