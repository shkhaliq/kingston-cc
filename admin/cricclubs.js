// Reads a CricClubs scorecard that's been copied from the "Full Scorecard" tab (Cmd+A, Cmd+C) and pasted in.
// Nothing is fetched from CricClubs; this only reads the text the admin pastes.

const tidy = (name) => name.replace(/†/g, "").replace(/\((?:c|wk|vc)\)/gi, "").replace(/\s+/g, " ").trim();
export const nameKey = (name) => tidy(name).toLowerCase();

/** How CricClubs shortens names in dismissals: every word but the last, then the last word's initial. */
const shortKey = (name) => {
  const words = tidy(name).split(" ");
  if (words.length < 2) return nameKey(name);
  return `${words.slice(0, -1).join(" ")} ${words.at(-1)[0]}`.toLowerCase();
};

const ballsFromOvers = (overs) => {
  const [whole, part = "0"] = overs.split(".");
  return Number(whole) * 6 + Number(part);
};

/** "216-4 (25 Ov)" as "216/4 (25)", the way the app shows scores. */
const appScore = (total) => {
  const match = total.match(/^(\d+)(?:[-/](\d+))?\s*\(([\d.]+)\s*Ov\)/i);
  if (!match) return total;
  return `${match[1]}${match[2] ? `/${match[2]}` : ""} (${match[3]})`;
};

function parseInnings(team, lines) {
  const innings = { team, total: "", batting: [], didNotBat: [], bowling: [], dismissals: [] };
  let section = "start";
  lines.forEach((line, index) => {
    if (section === "start" && /^\d+(?:[-/]\d+)?\s*\([\d.]+\s*Ov\)$/i.test(line)) {
      innings.total = line;
      return;
    }
    if (/^Batter\b/.test(line)) return void (section = "batting");
    if (/^Extras$/.test(line)) return void (section = "extras");
    if (/^Did not bat/i.test(line)) {
      section = "dnb";
      const rest = line.replace(/^Did not bat:?/i, "");
      if (rest.trim()) innings.didNotBat.push(...rest.split(","));
      return;
    }
    if (/^Bowler\b/.test(line)) return void (section = "bowling");
    if (/^Fall of Wickets/i.test(line)) return void (section = "done");

    if (section === "batting") {
      // Name, dismissal, then "R B 4s 6s SR".
      const stats = line.match(/^(\d+)\s+(\d+)\s+\d+\s+\d+(?:\s+[\d.-]+)?$/);
      if (stats && index >= 2) {
        const dismissal = lines[index - 1];
        const out = !/^(not out|retired)/i.test(dismissal);
        innings.batting.push({ name: tidy(lines[index - 2]), runs: Number(stats[1]), balls: Number(stats[2]), out });
        innings.dismissals.push(dismissal);
      }
    } else if (section === "dnb") {
      innings.didNotBat.push(...line.split(","));
    } else if (section === "bowling") {
      // "O M Dot R W", or "O M R W" where there's no dot-ball column.
      const stats = line.match(/^(\d+(?:\.\d)?)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/);
      if (stats && index >= 1) {
        const [runs, wickets] = stats[5] === undefined ? [stats[3], stats[4]] : [stats[4], stats[5]];
        innings.bowling.push({ name: tidy(lines[index - 1]), balls: ballsFromOvers(stats[1]), runs: Number(runs), wickets: Number(wickets) });
      }
    }
  });
  innings.didNotBat = innings.didNotBat.map(tidy).filter(Boolean);
  return innings;
}

/** The teams, result and both innings, or an error message if the text doesn't look like a scorecard. */
export function parseScorecard(text) {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const headers = lines.flatMap((line, index) => (/^(.+) Innings$/.test(line) && !/^Over/i.test(line) ? [index] : []));
  if (headers.length < 2) {
    throw new Error("That doesn’t look like a CricClubs scorecard. Open the match’s Full Scorecard tab, press Cmd+A then Cmd+C, and paste it here.");
  }
  const innings = headers.slice(0, 2).map((start, n) => {
    const end = headers[n + 1] ?? lines.length;
    return parseInnings(lines[start].replace(/ Innings$/, ""), lines.slice(start + 1, end));
  });
  const resultLine = lines.find((line) => /\bwon by\b|\btied\b|\bno result\b|\babandoned\b/i.test(line)) ?? "";
  const winner = resultLine.match(/^(.+?) won by/i)?.[1]?.trim() ?? null;
  return { teams: innings.map((i) => i.team), innings, resultLine, winner };
}

/** One team's match: who played, each player's figures, the scores and the result, ready for the result form. */
export function teamCard(card, team) {
  const ours = card.innings.find((i) => i.team === team);
  const theirs = card.innings.find((i) => i.team !== team);
  const players = new Map();
  const entry = (name) => {
    if (!players.has(name)) {
      players.set(name, { name, runs: null, balls: 0, out: false, ballsBowled: 0, conceded: 0, wickets: 0, catches: 0 });
    }
    return players.get(name);
  };

  for (const bat of ours.batting) Object.assign(entry(bat.name), { runs: bat.runs, balls: bat.balls, out: bat.out });
  for (const name of ours.didNotBat) entry(name);
  for (const bowl of theirs.bowling) Object.assign(entry(bowl.name), { ballsBowled: bowl.balls, conceded: bowl.runs, wickets: bowl.wickets });

  // Catches are in the other side's dismissals, with our names shortened: "c Amrith J b Harish K", "c&b MD N".
  const byShortName = new Map([...players.keys()].flatMap((name) => [[nameKey(name), name], [shortKey(name), name]]));
  const unmatchedCatches = [];
  for (const dismissal of theirs.dismissals) {
    const fielder = dismissal.match(/^c&b\s+(.+)$/i)?.[1] ?? dismissal.match(/^c\s+(.+?)\s+b\s+/i)?.[1];
    if (!fielder) continue;
    const name = byShortName.get(nameKey(fielder));
    if (name) entry(name).catches += 1;
    else unmatchedCatches.push(tidy(fielder));
  }

  let outcome = null;
  if (card.winner) outcome = card.winner === team ? "won" : "lost";
  else if (/tied/i.test(card.resultLine)) outcome = "tied";
  else if (/no result|abandoned/i.test(card.resultLine)) outcome = "no_result";

  return {
    outcome,
    kingstonScore: appScore(ours.total),
    oppositionScore: appScore(theirs.total),
    opponent: theirs.team,
    players: [...players.values()],
    unmatchedCatches,
  };
}
