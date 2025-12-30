export default function handler(req, res) {
  const name = (req.query.name || "").toLowerCase();

  const rightHudGames = ["fortnite", "apex", "pubg", "overwatch"];
  const leftHudGames = [
    "valorant",
    "counter strike",
    "csgo",
    "cs2",
    "call of duty",
    "warzone"
  ];

  let preferSide = "right";

  if (leftHudGames.some(g => name.includes(g))) preferSide = "left";
  if (rightHudGames.some(g => name.includes(g))) preferSide = "right";

  res.status(200).json({
    game: name || "unknown",
    preferSide,
    keepW: 0.5,
    keepH: 0.45
  });
}
