// Kingston CC club admin. Talks straight to Supabase with the same public key as the app; what each login can
// change is decided by the database's access rules, so only people in the admins table can edit anything.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { nameKey, parseScorecard, teamCard } from "./cricclubs.js";

const SUPABASE_URL = "https://ekjirhrzungmdkmfugmu.supabase.co";
const SUPABASE_KEY = "sb_publishable_IEbcz8qZY6Vo6ZmW_ID1GA_BOoGKAvG";
const TIME_ZONE = "America/Toronto";

const db = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById("app");

const state = {
  session: null,
  leagues: [],
  players: [],
  fixtures: [],
  votes: [],
  history: [],
  admins: [],
  logins: [],
  accounts: null,    // login emails by player, from the manage-logins function; null if it couldn't be reached
  league: null,      // the chosen league's id, or "all"
  draftSquad: null,  // the side being picked, before it's published
  notice: null,
};

// Formatting -------------------------------------------------------------------------------------------------

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);

const format = (iso, options) => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, ...options })
  .format(new Date(iso));
const dayAndTime = (iso) => format(iso, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const longDay = (iso) => format(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const time = (iso) => format(iso, { hour: "numeric", minute: "2-digit" });

/** "2026-11-08T12:30" in Eastern time, for a datetime-local input. */
function toInput(iso) {
  if (!iso) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** An input's value read as Eastern time, whatever time zone this computer is in. Postgres does the conversion. */
const fromInput = (value) => (value ? `${value.replace("T", " ")}:00 ${TIME_ZONE}` : null);

const slug = (text) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const answerTag = (answer) => ({
  available: '<span class="tag yes">Available</span>',
  unavailable: '<span class="tag no">Can’t play</span>',
})[answer] ?? '<span class="tag">No reply</span>';

// Lookups ----------------------------------------------------------------------------------------------------

const player = (id) => state.players.find((p) => p.id === id);
const league = (id) => state.leagues.find((l) => l.id === id);
const squadOf = (leagueID) => new Set(league(leagueID)?.league_players.map((m) => m.player_id) ?? []);
const vote = (fixtureID, playerID) => state.votes.find((v) => v.fixture_id === fixtureID && v.player_id === playerID);

/** Who gave a reply: the player themselves, an admin by name, or the dashboard. */
function setByName(userID, playerID) {
  if (!userID) return "the dashboard";
  const login = state.logins.find((l) => l.user_id === userID);
  if (login?.player_id === playerID) return "themselves";
  const admin = state.admins.find((a) => a.user_id === userID);
  if (admin) return admin.name;
  return login ? player(login.player_id)?.name ?? "a player" : "someone";
}

function fixturesInScope() {
  if (state.league === "all") return state.fixtures;
  return state.fixtures.filter((f) => f.league_id === state.league);
}

function title(fixture) {
  return fixture.is_home ? `Kingston CC v ${fixture.opponent}` : `${fixture.opponent} v Kingston CC`;
}

/** A game that's over or has its side picked, so it counts in the selection report. Cancelled games don't. */
const isDecided = (f) => f.status === "scheduled" && (f.squad.length > 0 || f.outcome !== null || new Date(f.start) < new Date());

// Loading ----------------------------------------------------------------------------------------------------

async function must(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function loadAll() {
  const [leagues, players, fixtures, votes, history, admins, logins] = await Promise.all([
    must(db.from("leagues").select("*, league_players(player_id)").order("is_active", { ascending: false }).order("starts_on", { ascending: false })),
    must(db.from("players").select("*").order("name")),
    must(db.from("fixtures").select("*, replies_deadline, performances(*)").order("start")),
    must(db.from("availability_votes").select("*")),
    must(db.from("availability_history").select("*").order("changed_at")),
    must(db.from("admins").select("*")),
    must(db.from("player_logins").select("*")),
  ]);
  Object.assign(state, { leagues, players, fixtures, votes, history, admins, logins });
  try {
    state.accounts = await callLogins({ action: "list" });
  } catch {
    state.accounts = null;
  }
  const saved = localStorage.getItem("league");
  if (!state.league) state.league = saved === "all" || league(saved) ? saved : leagues[0]?.id ?? "all";
}

/** Calls the manage-logins Edge Function, which holds the secret key needed to create and reset logins. */
async function callLogins(body) {
  const { data, error } = await db.functions.invoke("manage-logins", { body });
  if (error) {
    let message = error.message;
    try {
      message = (await error.context.json()).error ?? message;
    } catch {
      // Not a JSON reply; keep the general message.
    }
    throw new Error(message);
  }
  return data;
}

// Screens ----------------------------------------------------------------------------------------------------

function render() {
  const route = location.hash.slice(2).split("/");
  if (!state.session) return renderSignIn();
  const screens = {
    "": renderFixtures,
    fixtures: renderFixtures,
    fixture: () => renderFixture(decodeURIComponent(route[1] ?? "")),
    new: () => renderFixtureForm(null),
    edit: () => renderFixtureForm(state.fixtures.find((f) => f.id === decodeURIComponent(route[1] ?? ""))),
    squad: renderSquad,
    "add-player": () => renderPlayerForm(null),
    "edit-player": () => {
      const p = player(decodeURIComponent(route[1] ?? ""));
      return p ? renderPlayerForm(p) : '<section><p>No such player. <a href="#/squad">Back to the squad</a></p></section>';
    },
    players: renderReport,
    player: () => renderTimeline(decodeURIComponent(route[1] ?? "")),
  };
  app.innerHTML = bar(route[0] || "fixtures") + noticeHTML() + (screens[route[0]] ?? renderFixtures)();
}

function bar(current) {
  const link = (href, label, key) => `<a href="#/${href}" ${current === key || (key === "fixtures" && ["fixture", "new", "edit"].includes(current)) || (key === "players" && current === "player") || (key === "squad" && ["add-player", "edit-player"].includes(current)) ? 'aria-current="page"' : ""}>${label}</a>`;
  const options = state.leagues.map((l) => `<option value="${esc(l.id)}" ${state.league === l.id ? "selected" : ""}>${esc(l.name)}${l.is_active ? "" : " (finished)"}</option>`).join("");
  return `<div class="bar">
    <nav>${link("fixtures", "Fixtures", "fixtures")}${link("squad", "Squad", "squad")}${link("players", "Report", "players")}</nav>
    <label style="flex:0 1 260px"><span class="hint">League</span>
      <select data-action="league">${options}<option value="all" ${state.league === "all" ? "selected" : ""}>All leagues</option></select>
    </label>
    <button class="small" data-action="sign-out">Sign out</button>
  </div>`;
}

/** Shows the latest message once. On the sign-in screen it stays until the next attempt. */
function noticeHTML({ keep = false } = {}) {
  if (!state.notice) return "";
  const html = `<p class="notice ${state.notice.error ? "error" : ""}" role="status">${esc(state.notice.text)}</p>`;
  if (!keep) state.notice = null;
  return html;
}

function renderSignIn() {
  document.getElementById("whoami").textContent = "Kingston CC";
  app.innerHTML = `${noticeHTML({ keep: true })}<section class="signin">
    <h2>Sign in</h2>
    <p class="muted">Use your Kingston CC login. Only club admins can make changes here.</p>
    <form data-action="sign-in" class="grid" style="grid-template-columns:1fr">
      <label>Email <input name="email" type="email" autocomplete="username" required></label>
      <label>Passcode <input name="passcode" type="password" autocomplete="current-password" required></label>
      <div class="actions"><button class="primary">Sign in</button></div>
    </form>
  </section>`;
}

function fixtureItem(f) {
  const day = format(f.start, { weekday: "short" });
  const date = format(f.start, { day: "numeric" });
  const replies = state.votes.filter((v) => v.fixture_id === f.id);
  const yes = replies.filter((v) => v.answer === "available").length;
  const squad = squadOf(f.league_id).size;
  let status = `<span class="tag">${yes} of ${squad} available</span>`;
  if (f.status !== "scheduled") status = `<span class="tag no">${f.status === "cancelled" ? "Cancelled" : "Postponed"}</span>`;
  else if (f.outcome) status = `<span class="tag">${{ won: "Won", lost: "Lost", tied: "Tied", no_result: "No result" }[f.outcome]}</span>`;
  else if (f.squad.length) status += ' <span class="tag yes">Side picked</span>';
  const leagueName = state.league === "all" ? `${esc(league(f.league_id)?.name)} · ` : "";
  return `<li><a class="row" href="#/fixture/${encodeURIComponent(f.id)}">
    <span class="date"><small>${esc(day)}</small><b>${esc(date)}</b></span>
    <span class="grow"><b>${esc(title(f))}</b><br><span class="muted">${leagueName}Round ${f.round} · ${esc(time(f.start))} · ${f.is_home ? "Home" : "Away"}</span></span>
    <span>${status}</span></a></li>`;
}

function renderFixtures() {
  const now = new Date();
  const all = fixturesInScope();
  const upcoming = all.filter((f) => new Date(f.start) > new Date(now - 4 * 3600e3) && !f.outcome && f.status === "scheduled");
  const past = all.filter((f) => !upcoming.includes(f)).reverse();
  const canAdd = state.league !== "all";
  return `<section>
      <div class="actions" style="justify-content:space-between">
        <h2 style="margin:0">Upcoming</h2>
        ${canAdd ? '<a class="button primary" href="#/new">Add fixture</a>' : '<span class="muted">Choose a league to add fixtures</span>'}
      </div>
      ${upcoming.length ? `<ul class="list">${upcoming.map(fixtureItem).join("")}</ul>` : '<p class="muted">No upcoming games.</p>'}
    </section>
    ${past.length ? `<section><h2>Results and past games</h2><ul class="list">${past.map(fixtureItem).join("")}</ul></section>` : ""}`;
}

function renderFixtureForm(fixture) {
  const f = fixture ?? { round: (fixturesInScope().at(-1)?.round ?? 0) + 1, is_home: true, status: "scheduled" };
  return `<section>
    <h2>${fixture ? `Edit ${esc(title(fixture))}` : `New fixture in ${esc(league(state.league)?.name)}`}</h2>
    <form data-action="save-fixture" data-id="${esc(fixture?.id ?? "")}">
      <div class="grid">
        <label>Opponent <input name="opponent" required value="${esc(f.opponent)}"></label>
        <label>Round <input name="round" type="number" min="1" required value="${esc(f.round)}"></label>
        <label>Home or away <select name="is_home">
          <option value="true" ${f.is_home ? "selected" : ""}>Home</option>
          <option value="false" ${f.is_home ? "" : "selected"}>Away</option></select></label>
      </div>
      <div class="grid">
        <label>Start <span class="hint">Eastern time</span><input name="start" type="datetime-local" required value="${toInput(f.start)}"></label>
        <label>Meet <span class="hint">Optional</span><input name="meet" type="datetime-local" value="${toInput(f.meet)}"></label>
        <label>Replies close <span class="hint">Leave empty for the Wednesday before at 9pm</span><input name="replies_close_at" type="datetime-local" value="${toInput(f.replies_close_at)}"></label>
      </div>
      <div class="grid">
        <label>Ground <input name="venue" required value="${esc(f.venue)}"></label>
        <label>Address <span class="hint">For directions</span><input name="address" value="${esc(f.address)}"></label>
        <label>Status <select name="status">
          ${["scheduled", "postponed", "cancelled"].map((s) => `<option value="${s}" ${f.status === s ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}
        </select></label>
      </div>
      <div class="actions">
        <button class="primary">${fixture ? "Save changes" : "Add fixture"}</button>
        <a class="button" href="${fixture ? `#/fixture/${encodeURIComponent(fixture.id)}` : "#/fixtures"}">Cancel</a>
      </div>
    </form>
  </section>`;
}

function renderFixture(id) {
  const f = state.fixtures.find((x) => x.id === id);
  if (!f) return '<section><p>That game doesn’t exist any more. <a href="#/fixtures">Back to fixtures</a></p></section>';
  if (state.draftSquad?.fixture !== f.id) state.draftSquad = { fixture: f.id, ids: [...f.squad] };

  const squad = [...squadOf(f.league_id)].map(player).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const groups = { available: [], unavailable: [], none: [] };
  for (const p of squad) groups[vote(f.id, p.id)?.answer ?? "none"].push(p);
  const deadline = f.replies_deadline;
  const special = f.replies_close_at ? " (set for this game)" : "";

  return `<section>
      <div class="actions" style="justify-content:space-between">
        <h2 style="margin:0">${esc(title(f))}</h2>
        <a class="button" href="#/edit/${encodeURIComponent(f.id)}">Edit details</a>
      </div>
      <p class="muted">${esc(league(f.league_id)?.name)} · Round ${f.round} · ${esc(longDay(f.start))}, ${esc(time(f.start))}${f.meet ? ` (meet ${esc(time(f.meet))})` : ""} · ${esc(f.venue)}</p>
      <p>Replies close <b>${esc(dayAndTime(deadline))}</b>${special}${f.status !== "scheduled" ? ` <span class="tag no">${esc(f.status)}</span>` : ""}</p>
    </section>

    <section>
      <h2>Replies</h2>
      <div class="counts">
        <span class="tag yes">${groups.available.length} available</span>
        <span class="tag no">${groups.unavailable.length} can’t play</span>
        <span class="tag">${groups.none.length} no reply</span>
      </div>
      <p class="muted">You can set or change a reply for anyone, even after replies close. It’s recorded as set by you.</p>
      <ul class="list">${squad.map((p) => replyRow(f, p)).join("")}</ul>
    </section>

    ${sidePicker(f, groups)}

    ${resultSection(f)}`;
}

function replyRow(f, p) {
  const v = vote(f.id, p.id);
  const current = v?.answer ?? "";
  const changes = state.history.filter((h) => h.fixture_id === f.id && h.player_id === p.id);
  const by = v ? `${esc(dayAndTime(v.updated_at))} by ${esc(setByName(v.set_by, p.id))}` : "";
  const changed = changes.length > 1 ? ` · changed ${changes.length - 1}×` : "";
  return `<li>
    <span class="grow"><a href="#/player/${encodeURIComponent(p.id)}">${esc(p.name)}</a><br><span class="muted" style="font-size:.85rem">${by}${changed}</span></span>
    <select data-action="set-reply" data-fixture="${esc(f.id)}" data-player="${esc(p.id)}" aria-label="Reply for ${esc(p.name)}" style="width:auto">
      <option value="" ${current === "" ? "selected" : ""}>No reply</option>
      <option value="available" ${current === "available" ? "selected" : ""}>Available</option>
      <option value="unavailable" ${current === "unavailable" ? "selected" : ""}>Can’t play</option>
    </select>
  </li>`;
}

function sidePicker(f, groups) {
  const draft = state.draftSquad.ids;
  const changed = draft.join() !== f.squad.join();
  const picked = draft.map((id, index) => {
    const p = player(id);
    const answer = vote(f.id, id)?.answer;
    return `<li><b style="width:1.6em">${index + 1}</b><span class="grow">${esc(p?.name ?? id)} ${answer === "available" ? "" : answerTag(answer)}</span>
      <button class="small" data-action="move" data-player="${esc(id)}" data-by="-1" ${index === 0 ? "disabled" : ""} aria-label="Move ${esc(p?.name)} up">↑</button>
      <button class="small" data-action="move" data-player="${esc(id)}" data-by="1" ${index === draft.length - 1 ? "disabled" : ""} aria-label="Move ${esc(p?.name)} down">↓</button>
      <button class="small danger" data-action="drop" data-player="${esc(id)}" aria-label="Take ${esc(p?.name)} out">✕</button></li>`;
  }).join("");
  const choose = (list, label) => {
    const rest = list.filter((p) => !draft.includes(p.id));
    if (!rest.length) return "";
    return `<h3>${label}</h3><ul class="list">${rest.map((p) => `<li><span class="grow">${esc(p.name)}</span>
      <button class="small" data-action="add" data-player="${esc(p.id)}">Add</button></li>`).join("")}</ul>`;
  };
  return `<section>
    <h2>The side</h2>
    <p class="muted">${f.squad.length ? "The side is published. Players see it in the app." : "Publishing the side closes replies and tells players whether they’re in."} ${draft.length} picked.</p>
    <div class="columns">
      <div><h3>Batting order</h3>${draft.length ? `<ol class="list">${picked}</ol>` : '<p class="muted">Add players from the list.</p>'}</div>
      <div>${choose(groups.available, "Available")}${choose(groups.none, "No reply yet")}${choose(groups.unavailable, "Can’t play")}</div>
    </div>
    <div class="actions">
      <button class="primary" data-action="publish-side" data-fixture="${esc(f.id)}" ${changed && draft.length ? "" : "disabled"}>${f.squad.length ? "Publish changes" : "Publish side"}</button>
      ${changed ? '<button data-action="reset-side">Undo changes</button>' : ""}
      ${f.squad.length ? `<button class="danger" data-action="clear-side" data-fixture="${esc(f.id)}">Unpublish side</button>` : ""}
    </div>
  </section>`;
}

// The squad and logins ---------------------------------------------------------------------------------------

const ROLES = { batter: "Batter", bowler: "Bowler", all_rounder: "All-rounder", wicket_keeper: "Wicket-keeper" };

const account = (playerID) => state.accounts?.find((a) => a.player_id === playerID);

function loginTag(p) {
  if (!state.accounts) return state.logins.some((l) => l.player_id === p.id) ? '<span class="tag">Has login</span>' : '<span class="tag">No login</span>';
  const a = account(p.id);
  if (!a) return '<span class="tag">No login</span>';
  return a.disabled ? `<span class="tag no">Login off · ${esc(a.email)}</span>` : `<span class="tag yes">${esc(a.email)}</span>`;
}

function renderSquad() {
  const inScope = state.league === "all" ? state.players : [...squadOf(state.league)].map(player).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  const others = state.league === "all" ? [] : state.players.filter((p) => !squadOf(state.league).has(p.id));
  const row = (p, extra = "") => `<li>
      <span class="grow"><b>${esc(p.name)}</b>${p.is_captain ? ' <span class="tag">Captain</span>' : ""}${p.is_vice_captain ? ' <span class="tag">Vice-captain</span>' : ""}<br>
        <span class="muted">${esc(ROLES[p.role] ?? p.role)}</span> ${loginTag(p)}</span>
      ${extra}<a class="button small" href="#/edit-player/${encodeURIComponent(p.id)}">Edit</a></li>`;
  const where = state.league === "all" ? "the club" : esc(league(state.league)?.name);
  return `${state.accounts ? "" : '<p class="notice error">Logins can’t be managed right now: the manage-logins function isn’t reachable. Players can still be added and edited.</p>'}
    <section>
      <div class="actions" style="justify-content:space-between">
        <h2 style="margin:0">Squad · ${where}</h2>
        <a class="button primary" href="#/add-player">Add player</a>
      </div>
      ${inScope.length ? `<ul class="list">${inScope.map((p) => row(p)).join("")}</ul>` : '<p class="muted">No players yet.</p>'}
    </section>
    ${others.length ? `<section><h2>Not in this league</h2><p class="muted">Players from other leagues. Add them to ${where} so they’re asked about its games.</p>
      <ul class="list">${others.map((p) => row(p, `<button class="small" data-action="join-league" data-player="${esc(p.id)}">Add to league</button>`)).join("")}</ul></section>` : ""}`;
}

function renderPlayerForm(p) {
  const memberOf = (l) => (p ? squadOf(l.id).has(p.id) : l.id === state.league);
  const leagues = state.leagues.filter((l) => l.is_active || (p && squadOf(l.id).has(p.id)));
  const a = p && account(p.id);
  const hasLogin = p && (a || state.logins.some((l) => l.player_id === p.id));

  let login = "";
  if (!state.accounts) {
    login = '<p class="muted">Logins can’t be managed right now because the manage-logins function isn’t reachable.</p>';
  } else if (!p) {
    login = `<p class="muted">Optional. Fill these in to give them a login now, then send them their email and passcode. If the email already has a login, such as an admin’s, it’s linked as it is and the passcode is left alone.</p>
      <div class="grid">
        <label>Email <input name="email" type="email" autocomplete="off"></label>
        ${passcodeField("passcode")}
      </div>`;
  } else if (hasLogin) {
    login = `<p>Signs in as <b>${esc(a?.email ?? "")}</b>${a?.disabled ? ' · <span class="tag no">Login turned off</span>' : ""}</p>
      <div class="grid">${passcodeField("new_passcode", "New passcode")}</div>
      <div class="actions">
        <button type="button" data-action="reset-passcode" data-player="${esc(p.id)}">Set new passcode</button>
        ${a?.disabled
          ? `<button type="button" data-action="enable-login" data-player="${esc(p.id)}">Turn login back on</button>`
          : `<button type="button" class="danger" data-action="disable-login" data-player="${esc(p.id)}">Turn login off</button>`}
      </div>
      <p class="muted">Turning a login off stops it signing in but keeps the record of their replies.</p>`;
  } else {
    login = `<p class="muted">No login yet.</p>
      <div class="grid">
        <label>Email <input name="new_email" type="email" autocomplete="off"></label>
        ${passcodeField("new_login_passcode")}
      </div>
      <div class="actions"><button type="button" data-action="create-login" data-player="${esc(p.id)}">Create login</button></div>`;
  }

  return `<section>
    <h2>${p ? `Edit ${esc(p.name)}` : "Add a player"}</h2>
    <form data-action="save-player" data-id="${esc(p?.id ?? "")}">
      <div class="grid">
        <label>Name <input name="name" required value="${esc(p?.name)}"></label>
        <label>Role <select name="role">${Object.entries(ROLES).map(([value, label]) => `<option value="${value}" ${(p?.role ?? "batter") === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      </div>
      <div class="grid">
        <label>Batting <input name="batting_style" placeholder="Right-hand bat" value="${esc(p?.batting_style)}"></label>
        <label>Bowling <span class="hint">Optional</span><input name="bowling_style" placeholder="Right-arm medium" value="${esc(p?.bowling_style)}"></label>
      </div>
      <div class="actions">
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="is_captain" ${p?.is_captain ? "checked" : ""}> Captain</label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="is_vice_captain" ${p?.is_vice_captain ? "checked" : ""}> Vice-captain</label>
      </div>
      <h3>Leagues</h3>
      <div class="actions">${leagues.map((l) => `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="league" value="${esc(l.id)}" ${memberOf(l) ? "checked" : ""}> ${esc(l.name)}</label>`).join("") || '<span class="muted">No leagues yet.</span>'}</div>
      ${p ? "" : `<h3>Login</h3>${login}`}
      <div class="actions">
        <button class="primary">${p ? "Save changes" : "Add player"}</button>
        <a class="button" href="#/squad">Cancel</a>
      </div>
    </form>
  </section>
  ${p ? `<section><h2>Login</h2>${login}</section>` : ""}`;
}

/** A passcode box with a button that fills in a random one, shown in full so it can be passed on. */
function passcodeField(name, label = "Passcode") {
  return `<label>${label} <span class="hint">At least 6 characters</span>
    <span style="display:flex;gap:8px"><input name="${name}" type="text" autocomplete="off" minlength="6" spellcheck="false">
    <button type="button" class="small" data-action="suggest-passcode" data-field="${name}">Make one</button></span></label>`;
}

function randomPasscode() {
  const letters = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => letters[byte % letters.length]).join("");
}

/** A short, stable ID from the name, such as "sam-patel", made unique if needed. */
function newPlayerID(name) {
  const base = slug(name) || "player";
  let id = base;
  for (let n = 2; player(id); n += 1) id = `${base}-${n}`;
  return id;
}

// Results and scorecards ------------------------------------------------------------------------------------

const OUTCOMES = { won: "Won", lost: "Lost", tied: "Tied", no_result: "No result" };

/** "3.2" overs as 20 balls. Empty means didn't bowl. */
function ballsFromOvers(text) {
  const value = text.trim();
  if (!value) return 0;
  const match = value.match(/^(\d+)(?:\.(\d))?$/);
  if (!match || Number(match[2] ?? 0) > 5) throw new Error(`“${value}” isn’t a number of overs. Use whole overs and balls, like 3.2.`);
  return Number(match[1]) * 6 + Number(match[2] ?? 0);
}

const oversFromBalls = (balls) => (balls ? `${Math.floor(balls / 6)}${balls % 6 ? `.${balls % 6}` : ""}` : "");

function scoreRow(f, playerID, perf, played) {
  const p = player(playerID);
  const field = (name, value, label, attributes = 'inputmode="numeric"') =>
    `<td><input class="num" name="${name}__${esc(playerID)}" value="${esc(value)}" ${attributes} aria-label="${label} for ${esc(p?.name)}"></td>`;
  return `<tr data-player="${esc(playerID)}">
    <td><label style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" name="played__${esc(playerID)}" ${played ? "checked" : ""}> ${esc(p?.name ?? playerID)}</label></td>
    ${field("runs", perf?.runs ?? "", "Runs")}
    ${field("balls", perf?.balls_faced || "", "Balls faced")}
    <td><input type="checkbox" name="out__${esc(playerID)}" ${perf?.is_out ? "checked" : ""} aria-label="${esc(p?.name)} was out"></td>
    ${field("overs", oversFromBalls(perf?.balls_bowled), "Overs bowled", 'inputmode="decimal"')}
    ${field("conceded", perf?.runs_conceded || "", "Runs conceded")}
    ${field("wickets", perf?.wickets || "", "Wickets")}
    ${field("catches", perf?.catches || "", "Catches")}
  </tr>`;
}

function resultSection(f) {
  const started = new Date(f.start) <= new Date();
  if (!started && !f.outcome) return '<section><h2>Result</h2><p class="muted">The result and scorecard can be added once the game has started.</p></section>';
  if (f.status !== "scheduled") return "";

  // The picked side in batting order, then anyone else who has figures.
  const ids = [...f.squad, ...f.performances.map((x) => x.player_id).filter((id) => !f.squad.includes(id))];
  const perfOf = (id) => f.performances.find((x) => x.player_id === id);
  const hasCard = f.performances.length > 0;
  const others = [...squadOf(f.league_id)].filter((id) => !ids.includes(id)).map(player).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  return `<section>
    <h2>Result and scorecard</h2>
    <details class="import" ${f.outcome ? "" : "open"}>
      <summary>Fill in from CricClubs</summary>
      <p class="muted">On CricClubs, open the match and its <b>Full Scorecard</b> tab, press Cmd+A then Cmd+C, and paste it here.
        Nothing is saved until you check the form below and press Save result.</p>
      <textarea id="cricclubs-text" rows="4" aria-label="CricClubs scorecard text" placeholder="Paste the scorecard here"></textarea>
      <div class="actions"><button type="button" data-action="read-cricclubs" data-fixture="${esc(f.id)}">Read scorecard</button></div>
      <div id="cricclubs-review"></div>
    </details>
    <form data-action="save-result" data-fixture="${esc(f.id)}">
      <div class="grid">
        <label>Result <select name="outcome" required>
          <option value="">Choose…</option>
          ${Object.entries(OUTCOMES).map(([value, label]) => `<option value="${value}" ${f.outcome === value ? "selected" : ""}>${label}</option>`).join("")}
        </select></label>
        <label>Kingston score <input name="kingston_score" placeholder="148/6 (20)" value="${esc(f.kingston_score)}"></label>
        <label>${esc(f.opponent)} score <input name="opposition_score" placeholder="131/9 (20)" value="${esc(f.opposition_score)}"></label>
        <label>Player of the match <select name="player_of_the_match">
          <option value="">None</option>
          ${ids.map(player).filter(Boolean).map((p) => `<option value="${esc(p.id)}" ${f.player_of_the_match === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        </select></label>
      </div>
      <label>Summary <span class="hint">A line or two for the app, optional</span><textarea name="summary" rows="2">${esc(f.summary)}</textarea></label>

      <h3>Scorecard</h3>
      <p class="muted">Tick everyone who played. Leave runs empty for anyone who didn’t bat, and overs empty for anyone who didn’t bowl.</p>
      <div class="table-wrap"><table class="scorecard">
        <thead><tr><th>Played</th><th class="num">Runs</th><th class="num">Balls</th><th>Out</th><th class="num">Overs</th><th class="num">Runs given</th><th class="num">Wkts</th><th class="num">Catches</th></tr></thead>
        <tbody>${ids.map((id) => scoreRow(f, id, perfOf(id), hasCard ? Boolean(perfOf(id)) : true)).join("")}</tbody>
      </table></div>
      ${others.length ? `<label style="max-width:320px">Add someone else who played <select data-action="add-score-row" data-fixture="${esc(f.id)}">
        <option value="">Choose a player…</option>${others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}
      </select></label>` : ""}
      <div class="actions">
        <button class="primary">Save result</button>
        ${f.outcome ? `<button type="button" class="danger" data-action="clear-result" data-fixture="${esc(f.id)}">Remove result</button>` : ""}
      </div>
    </form>
  </section>`;
}

// Importing from CricClubs ------------------------------------------------------------------------------------

/** CricClubs names an admin has matched to players before, remembered on this computer. */
function savedNames() {
  try {
    return JSON.parse(localStorage.getItem("cricclubs-names") ?? "{}");
  } catch {
    return {};
  }
}

function guessPlayer(name) {
  const saved = savedNames()[nameKey(name)];
  if (saved && player(saved)) return saved;
  return state.players.find((p) => nameKey(p.name) === nameKey(name))?.id ?? "";
}

let imported = null; // { fixtureID, card, team }

function renderImportReview() {
  const box = document.getElementById("cricclubs-review");
  if (!box || !imported) return;
  const f = state.fixtures.find((x) => x.id === imported.fixtureID);
  const result = teamCard(imported.card, imported.team);
  const squad = [...squadOf(f.league_id)].map(player).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const others = state.players.filter((p) => !squadOf(f.league_id).has(p.id));
  const choices = (selected) => `<option value="">Not one of ours, skip</option>
    <optgroup label="${esc(league(f.league_id)?.name)}">${squad.map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>
    ${others.length ? `<optgroup label="Other players">${others.map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>` : ""}`;
  const describe = (x) => [
    x.runs === null ? "didn’t bat" : `${x.runs}${x.out ? "" : "*"} (${x.balls})`,
    x.ballsBowled ? `${x.wickets}/${x.conceded} in ${oversFromBalls(x.ballsBowled)} ov` : "",
    x.catches ? `${x.catches} ct` : "",
  ].filter(Boolean).join(", ");

  box.innerHTML = `
    <div class="grid">
      <label>Which team is Kingston? <select data-action="cricclubs-team">
        ${imported.card.teams.map((t) => `<option ${t === imported.team ? "selected" : ""}>${esc(t)}</option>`).join("")}
      </select></label>
      <p style="margin:0;align-self:end">${esc(imported.card.resultLine || "No result line found")}<br>
        <span class="muted">${esc(result.kingstonScore)} v ${esc(result.oppositionScore)}</span></p>
    </div>
    <p class="muted">Match each CricClubs name to a player. Choices are remembered on this computer for next time.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>CricClubs</th><th>Figures</th><th>Player</th></tr></thead>
      <tbody>${result.players.map((x) => `<tr>
        <td>${esc(x.name)}</td><td class="muted">${esc(describe(x))}</td>
        <td><select data-cricclubs-name="${esc(x.name)}" aria-label="Player for ${esc(x.name)}">${choices(guessPlayer(x.name))}</select></td>
      </tr>`).join("")}</tbody>
    </table></div>
    ${result.unmatchedCatches.length ? `<p class="notice error">Couldn’t tell who took ${result.unmatchedCatches.length === 1 ? "this catch" : "these catches"}: ${esc(result.unmatchedCatches.join(", "))}. Add ${result.unmatchedCatches.length === 1 ? "it" : "them"} by hand.</p>` : ""}
    <p class="muted">Stumpings and run outs aren’t counted; the app only records catches.</p>
    <div class="actions"><button type="button" class="primary" data-action="fill-cricclubs">Fill in the form</button></div>`;
}

// The selection report ---------------------------------------------------------------------------------------

function playerRecord(p) {
  const games = fixturesInScope().filter((f) => isDecided(f) && squadOf(f.league_id).has(p.id));
  const record = { player: p, games: games.length, available: 0, unavailable: 0, none: 0, picked: 0, availableNotPicked: 0, changed: 0, byAdmin: 0 };
  for (const f of games) {
    const v = vote(f.id, p.id);
    const picked = f.squad.includes(p.id);
    record[v?.answer ?? "none"] += 1;
    if (picked) record.picked += 1;
    if (v?.answer === "available" && !picked) record.availableNotPicked += 1;
    if (state.history.filter((h) => h.fixture_id === f.id && h.player_id === p.id).length > 1) record.changed += 1;
    if (v && v.set_by && setByName(v.set_by, p.id) !== "themselves") record.byAdmin += 1;
  }
  const pickedWhenAvailable = games.filter((f) => vote(f.id, p.id)?.answer === "available" && f.squad.includes(p.id)).length;
  record.rate = record.available ? pickedWhenAvailable / record.available : null;
  return record;
}

let sortKey = "name";
let sortDescending = false;

function renderReport() {
  const members = state.league === "all" ? state.players : [...squadOf(state.league)].map(player).filter(Boolean);
  const rows = members.map(playerRecord);
  const value = (r) => (sortKey === "name" ? r.player.name : r[sortKey] ?? -1);
  rows.sort((a, b) => {
    const order = value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : a.player.name.localeCompare(b.player.name);
    return sortDescending ? -order : order;
  });
  const head = (key, label, numeric = true) => `<th class="${numeric ? "num" : ""}" aria-sort="${sortKey === key ? (sortDescending ? "descending" : "ascending") : "none"}">
    <button data-action="sort" data-key="${key}">${label}${sortKey === key ? (sortDescending ? " ↓" : " ↑") : ""}</button></th>`;
  const percent = (rate) => (rate === null ? "–" : `${Math.round(rate * 100)}%`);
  return `<section>
    <h2>Selection report</h2>
    <p class="muted">Games whose side was picked or that have been played, in ${state.league === "all" ? "every league" : esc(league(state.league)?.name)}. Cancelled games don’t count. Tap a player for their game-by-game record.</p>
    <div class="table-wrap"><table>
      <thead><tr>${head("name", "Player", false)}${head("games", "Games")}${head("available", "Available")}${head("unavailable", "Can’t play")}${head("none", "No reply")}${head("picked", "Picked")}${head("availableNotPicked", "Available, not picked")}${head("rate", "Picked when available")}${head("changed", "Changed reply")}</tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.availableNotPicked >= 2 && r.rate !== null && r.rate < 0.5 ? "flag" : ""}">
        <td><a href="#/player/${encodeURIComponent(r.player.id)}">${esc(r.player.name)}</a></td>
        <td class="num">${r.games}</td><td class="num">${r.available}</td><td class="num">${r.unavailable}</td><td class="num">${r.none}</td>
        <td class="num">${r.picked}</td><td class="num">${r.availableNotPicked}</td><td class="num">${percent(r.rate)}</td><td class="num">${r.changed}</td>
      </tr>`).join("")}</tbody>
    </table></div>
    <p class="muted">Highlighted: available at least twice but picked for under half of those games.</p>
  </section>`;
}

function performanceText(perf) {
  if (!perf) return "";
  const bits = [];
  if (perf.runs !== null) bits.push(`${perf.runs}${perf.is_out ? "" : "*"} (${perf.balls_faced})`);
  if (perf.balls_bowled > 0) bits.push(`${perf.wickets}/${perf.runs_conceded} in ${Math.floor(perf.balls_bowled / 6)}.${perf.balls_bowled % 6} ov`);
  if (perf.catches) bits.push(`${perf.catches} ct`);
  return bits.join(", ") || "Fielded";
}

function renderTimeline(id) {
  const p = player(id);
  if (!p) return '<section><p>No such player. <a href="#/players">Back to players</a></p></section>';
  const r = playerRecord(p);
  const games = fixturesInScope().filter((f) => squadOf(f.league_id).has(p.id)).slice().reverse();
  const rows = games.map((f) => {
    const v = vote(f.id, p.id);
    const changes = state.history.filter((h) => h.fixture_id === f.id && h.player_id === p.id);
    const late = v && new Date(v.updated_at) > new Date(f.replies_deadline);
    const trail = changes.length > 1
      ? `<ul class="history">${changes.map((h) => `<li>${h.answer === "available" ? "Available" : h.answer === "unavailable" ? "Can’t play" : "Cleared"} · ${esc(dayAndTime(h.changed_at))} by ${esc(setByName(h.set_by, p.id))}</li>`).join("")}</ul>`
      : "";
    const picked = f.squad.length ? (f.squad.includes(p.id) ? '<span class="tag yes">Picked</span>' : '<span class="tag">Not picked</span>') : '<span class="muted">Not picked yet</span>';
    const perf = performanceText(f.performances.find((x) => x.player_id === p.id));
    return `<tr>
      <td><a href="#/fixture/${encodeURIComponent(f.id)}">${esc(format(f.start, { day: "numeric", month: "short" }))}</a><br><span class="muted">${esc(f.opponent)}</span>${f.status !== "scheduled" ? ` <span class="tag no">${esc(f.status)}</span>` : ""}</td>
      <td>${answerTag(v?.answer)}${v ? `<br><span class="muted" style="font-size:.85rem">${esc(dayAndTime(v.updated_at))} by ${esc(setByName(v.set_by, p.id))}${late ? " · after replies closed" : ""}</span>` : ""}${trail}</td>
      <td>${picked}</td>
      <td>${esc(perf)}</td>
    </tr>`;
  }).join("");
  return `<section>
    <h2>${esc(p.name)}</h2>
    <div class="counts">
      <span class="tag">${r.games} games</span><span class="tag yes">${r.available} available</span><span class="tag no">${r.unavailable} can’t play</span>
      <span class="tag">${r.none} no reply</span><span class="tag">${r.picked} picked</span>
      <span class="tag">${r.rate === null ? "–" : `${Math.round(r.rate * 100)}%`} picked when available</span>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Game</th><th>Reply</th><th>Side</th><th>Scorecard</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">No games yet.</td></tr>'}</tbody>
    </table></div>
  </section>`;
}

// Actions ----------------------------------------------------------------------------------------------------

function notify(text, error = false) {
  state.notice = { text, error };
}

async function refresh(message) {
  await loadAll();
  if (message) notify(message);
  render();
}

async function run(task) {
  try {
    await task();
  } catch (error) {
    notify(error.message?.includes("row-level security") ? "Only club admins can change this." : `Couldn’t save: ${error.message}`, true);
    render();
  }
}

const handlers = {
  async "sign-in"(form) {
    state.notice = null;
    const { error } = await db.auth.signInWithPassword({ email: form.email.value.trim(), password: form.passcode.value });
    if (error) {
      notify("That email and passcode don’t match.", true);
      return renderSignIn();
    }
  },
  async "sign-out"() {
    await db.auth.signOut();
  },
  league(select) {
    state.league = select.value;
    localStorage.setItem("league", state.league);
    if (!["players", "player"].includes(location.hash.slice(2).split("/")[0])) location.hash = "#/fixtures";
    render();
  },
  async "save-fixture"(form) {
    const values = Object.fromEntries(new FormData(form));
    const row = {
      opponent: values.opponent.trim(),
      round: Number(values.round),
      is_home: values.is_home === "true",
      start: fromInput(values.start),
      meet: fromInput(values.meet),
      replies_close_at: fromInput(values.replies_close_at),
      venue: values.venue.trim(),
      address: values.address.trim(),
      status: values.status,
    };
    let id = form.dataset.id;
    if (id) {
      await must(db.from("fixtures").update(row).eq("id", id));
    } else {
      id = `${state.league}-r${row.round}-${slug(row.opponent)}`;
      await must(db.from("fixtures").insert({ ...row, id, league_id: state.league }));
    }
    location.hash = `#/fixture/${encodeURIComponent(id)}`;
    await refresh("Saved.");
  },
  async "set-reply"(select) {
    const { fixture, player: playerID } = select.dataset;
    if (select.value) {
      await must(db.from("availability_votes").upsert({ fixture_id: fixture, player_id: playerID, answer: select.value }, { onConflict: "fixture_id,player_id" }));
    } else {
      await must(db.from("availability_votes").delete().eq("fixture_id", fixture).eq("player_id", playerID));
    }
    await refresh(`Reply for ${player(playerID)?.name} saved.`);
  },
  add(button) {
    state.draftSquad.ids.push(button.dataset.player);
    render();
  },
  drop(button) {
    state.draftSquad.ids = state.draftSquad.ids.filter((id) => id !== button.dataset.player);
    render();
  },
  move(button) {
    const ids = state.draftSquad.ids;
    const from = ids.indexOf(button.dataset.player);
    const to = from + Number(button.dataset.by);
    [ids[from], ids[to]] = [ids[to], ids[from]];
    render();
  },
  "reset-side"() {
    state.draftSquad = null;
    render();
  },
  async "publish-side"(button) {
    await must(db.from("fixtures").update({ squad: state.draftSquad.ids }).eq("id", button.dataset.fixture));
    await refresh("Side published.");
  },
  async "save-result"(form) {
    const fixtureID = form.dataset.fixture;
    const values = new FormData(form);
    const number = (name, id) => {
      const text = (values.get(`${name}__${id}`) ?? "").trim();
      if (!text) return null;
      if (!/^\d+$/.test(text)) throw new Error(`“${text}” for ${player(id)?.name} isn’t a whole number.`);
      return Number(text);
    };

    const rows = [];
    const dropped = [];
    for (const tr of form.querySelectorAll("tbody tr[data-player]")) {
      const id = tr.dataset.player;
      if (!values.has(`played__${id}`)) {
        dropped.push(id);
        continue;
      }
      rows.push({
        fixture_id: fixtureID,
        player_id: id,
        runs: number("runs", id),
        balls_faced: number("balls", id) ?? 0,
        is_out: values.has(`out__${id}`),
        balls_bowled: ballsFromOvers(values.get(`overs__${id}`) ?? ""),
        runs_conceded: number("conceded", id) ?? 0,
        wickets: number("wickets", id) ?? 0,
        catches: number("catches", id) ?? 0,
      });
    }

    await must(db.from("fixtures").update({
      outcome: values.get("outcome"),
      kingston_score: values.get("kingston_score").trim(),
      opposition_score: values.get("opposition_score").trim(),
      summary: values.get("summary").trim(),
      player_of_the_match: values.get("player_of_the_match") || null,
    }).eq("id", fixtureID));
    if (rows.length) await must(db.from("performances").upsert(rows, { onConflict: "fixture_id,player_id" }));
    if (dropped.length) await must(db.from("performances").delete().eq("fixture_id", fixtureID).in("player_id", dropped));
    await refresh("Result saved. It’s in the app and the stats now.");
  },
  "add-score-row"(select) {
    if (!select.value) return;
    const f = state.fixtures.find((x) => x.id === select.dataset.fixture);
    select.closest("form").querySelector("tbody").insertAdjacentHTML("beforeend", scoreRow(f, select.value, null, true));
    select.querySelector(`option[value="${CSS.escape(select.value)}"]`).remove();
    select.value = "";
  },
  "read-cricclubs"(button) {
    const card = parseScorecard(document.getElementById("cricclubs-text").value);
    const f = state.fixtures.find((x) => x.id === button.dataset.fixture);
    const opponentWord = f.opponent.split(" ")[0].toLowerCase();
    const team = card.teams.find((t) => /kingston/i.test(t))
      ?? card.teams.find((t) => !t.toLowerCase().includes(opponentWord))
      ?? card.teams[0];
    imported = { fixtureID: f.id, card, team };
    renderImportReview();
  },
  "cricclubs-team"(select) {
    imported.team = select.value;
    renderImportReview();
  },
  "fill-cricclubs"() {
    const f = state.fixtures.find((x) => x.id === imported.fixtureID);
    const result = teamCard(imported.card, imported.team);
    const form = document.querySelector("form[data-action=save-result]");
    const names = savedNames();
    const chosen = new Map();
    for (const select of document.querySelectorAll("[data-cricclubs-name]")) {
      const name = select.dataset.cricclubsName;
      if (select.value) {
        if (chosen.has(select.value)) throw new Error(`${player(select.value)?.name} is matched to two CricClubs names. Fix that, then try again.`);
        chosen.set(select.value, result.players.find((x) => x.name === name));
        names[nameKey(name)] = select.value;
      }
    }
    try {
      localStorage.setItem("cricclubs-names", JSON.stringify(names));
    } catch {
      // Remembering names is only a convenience.
    }

    form.outcome.value = result.outcome ?? "";
    form.kingston_score.value = result.kingstonScore;
    form.opposition_score.value = result.oppositionScore;

    const tbody = form.querySelector("tbody");
    const addSelect = form.querySelector("[data-action=add-score-row]");
    for (const tr of tbody.querySelectorAll("tr[data-player]")) {
      form.querySelector(`[name="played__${CSS.escape(tr.dataset.player)}"]`).checked = chosen.has(tr.dataset.player);
    }
    for (const [id, x] of chosen) {
      if (!tbody.querySelector(`tr[data-player="${CSS.escape(id)}"]`)) {
        tbody.insertAdjacentHTML("beforeend", scoreRow(f, id, null, true));
        addSelect?.querySelector(`option[value="${CSS.escape(id)}"]`)?.remove();
      }
      const set = (name, value) => { form.querySelector(`[name="${name}__${CSS.escape(id)}"]`).value = value; };
      form.querySelector(`[name="played__${CSS.escape(id)}"]`).checked = true;
      set("runs", x.runs ?? "");
      set("balls", x.runs === null ? "" : x.balls);
      form.querySelector(`[name="out__${CSS.escape(id)}"]`).checked = x.out;
      set("overs", oversFromBalls(x.ballsBowled));
      set("conceded", x.ballsBowled ? x.conceded : "");
      set("wickets", x.ballsBowled ? x.wickets : "");
      set("catches", x.catches || "");
    }
    // The player of the match list only offers people in the scorecard.
    const motm = form.player_of_the_match;
    for (const id of chosen.keys()) {
      if (![...motm.options].some((o) => o.value === id)) motm.add(new Option(player(id)?.name ?? id, id));
    }
    document.getElementById("cricclubs-review").innerHTML =
      `<p class="notice">Filled in ${chosen.size} players from CricClubs. Check the form below, choose a player of the match, then press Save result.</p>`;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  },
  async "clear-result"(button) {
    if (!confirm("Remove the result and scorecard? The game will no longer count in the stats.")) return;
    const id = button.dataset.fixture;
    await must(db.from("fixtures").update({ outcome: null, kingston_score: "", opposition_score: "", summary: "", player_of_the_match: null }).eq("id", id));
    await must(db.from("performances").delete().eq("fixture_id", id));
    await refresh("Result removed.");
  },
  async "clear-side"(button) {
    if (!confirm("Unpublish the side? If replies haven’t closed yet, players can reply again.")) return;
    await must(db.from("fixtures").update({ squad: [] }).eq("id", button.dataset.fixture));
    state.draftSquad = null;
    await refresh("Side unpublished.");
  },
  async "save-player"(form) {
    const values = new FormData(form);
    const row = {
      name: values.get("name").trim(),
      role: values.get("role"),
      batting_style: values.get("batting_style").trim(),
      bowling_style: values.get("bowling_style").trim(),
      is_captain: values.has("is_captain"),
      is_vice_captain: values.has("is_vice_captain"),
    };
    const email = values.get("email")?.trim();
    const passcode = values.get("passcode") ?? "";
    if (email && passcode && passcode.length < 6) throw new Error("Passcodes need at least 6 characters.");

    let id = form.dataset.id;
    if (id) {
      await must(db.from("players").update(row).eq("id", id));
    } else {
      id = newPlayerID(row.name);
      await must(db.from("players").insert({ ...row, id }));
    }

    const wanted = new Set(values.getAll("league"));
    const current = new Set(state.leagues.filter((l) => squadOf(l.id).has(id)).map((l) => l.id));
    const join = [...wanted].filter((l) => !current.has(l)).map((league_id) => ({ league_id, player_id: id }));
    const leave = [...current].filter((l) => !wanted.has(l) && state.leagues.some((x) => x.id === l && x.is_active));
    if (join.length) await must(db.from("league_players").insert(join));
    for (const league_id of leave) await must(db.from("league_players").delete().eq("league_id", league_id).eq("player_id", id));

    let message = `${row.name} saved.`;
    if (email) {
      try {
        const result = await callLogins({ action: "create", player_id: id, email, passcode });
        message = result.linked
          ? `${row.name} added and linked to the existing login for ${email}. The passcode hasn’t changed.`
          : `${row.name} added. They sign in with ${email} and the passcode ${passcode}.`;
      } catch (error) {
        location.hash = `#/edit-player/${encodeURIComponent(id)}`;
        await refresh();
        notify(`${row.name} was added, but the login wasn’t: ${error.message}`, true);
        return render();
      }
    }
    location.hash = "#/squad";
    await refresh(message);
  },
  async "join-league"(button) {
    await must(db.from("league_players").insert({ league_id: state.league, player_id: button.dataset.player }));
    await refresh(`${player(button.dataset.player)?.name} is now in ${league(state.league)?.name}.`);
  },
  "suggest-passcode"(button) {
    button.closest("label").querySelector("input").value = randomPasscode();
  },
  async "create-login"(button) {
    const section = button.closest("section");
    const email = section.querySelector("[name=new_email]").value.trim();
    const passcode = section.querySelector("[name=new_login_passcode]").value;
    const result = await callLogins({ action: "create", player_id: button.dataset.player, email, passcode });
    await refresh(result.linked
      ? `Linked to the existing login for ${email}. The passcode hasn’t changed.`
      : `Login created. ${player(button.dataset.player)?.name} signs in with ${email} and the passcode ${passcode}.`);
  },
  async "reset-passcode"(button) {
    const passcode = button.closest("section").querySelector("[name=new_passcode]").value;
    await callLogins({ action: "reset", player_id: button.dataset.player, passcode });
    await refresh(`${player(button.dataset.player)?.name}’s new passcode is ${passcode}.`);
  },
  async "disable-login"(button) {
    if (!confirm(`Turn off ${player(button.dataset.player)?.name}’s login? They won’t be able to sign in until it’s turned back on.`)) return;
    await callLogins({ action: "disable", player_id: button.dataset.player });
    await refresh("Login turned off.");
  },
  async "enable-login"(button) {
    await callLogins({ action: "enable", player_id: button.dataset.player });
    await refresh("Login turned back on.");
  },
  sort(button) {
    sortDescending = sortKey === button.dataset.key ? !sortDescending : button.dataset.key !== "name";
    sortKey = button.dataset.key;
    render();
  },
};

app.addEventListener("click", (event) => {
  const target = event.target.closest("button[data-action]");
  if (target) run(() => handlers[target.dataset.action](target));
});
app.addEventListener("change", (event) => {
  const target = event.target.closest("select[data-action]");
  if (target) run(() => handlers[target.dataset.action](target));
});
app.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-action]");
  if (!form) return;
  event.preventDefault();
  run(() => handlers[form.dataset.action](form));
});
window.addEventListener("hashchange", () => {
  if (!location.hash.startsWith("#/fixture/")) state.draftSquad = null;
  render();
});

// Signing in -------------------------------------------------------------------------------------------------

db.auth.onAuthStateChange((_event, session) => {
  // Supabase asks for no awaits inside this callback, so the work happens on the next tick.
  setTimeout(() => run(() => start(session)), 0);
});

async function start(session) {
  if (session?.user.id === state.session?.user.id && state.leagues.length) return;
  state.session = null;
  if (!session) return renderSignIn();
  const { data: isAdmin, error } = await db.rpc("is_admin");
  if (error || !isAdmin) {
    await db.auth.signOut();
    notify("This login isn’t a club admin. Ask an owner to add you.", true);
    return renderSignIn();
  }
  state.session = session;
  await loadAll();
  const me = state.admins.find((a) => a.user_id === session.user.id);
  document.getElementById("whoami").textContent = `Signed in as ${me?.name ?? session.user.email}`;
  render();
}
