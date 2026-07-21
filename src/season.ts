// In season now — what this month offers where you're standing.
//
// A month + a rough region (from the map centre) is enough to say what's worth
// fishing, foraging, and hunting right now, and what the season's hazard is. All
// honest generalisation, no data feed. Pure; tested in tests/season.test.ts.

export interface SeasonItem {
  icon: string;
  label: string;
  note: string;
}
export interface SeasonReport {
  season: string;
  monthName: string;
  items: SeasonItem[];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type Season = "spring" | "summer" | "fall" | "winter";
function seasonOf(month: number): Season {
  const m = ((month % 12) + 12) % 12;
  if (m <= 1 || m === 11) return "winter";
  if (m <= 4) return "spring";
  if (m <= 7) return "summer";
  return "fall";
}

export function seasonReport(month: number, lat: number, lng: number): SeasonReport {
  const season = seasonOf(month);
  const west = lng < -100;
  const north = lat >= 42; // later springs, earlier winters up north
  const items: SeasonItem[] = [];

  if (season === "spring") {
    items.push(
      { icon: "🎣", label: "Fishing", note: north
        ? "Trout wake as water warms; runoff is high and cold — fish the edges."
        : "Bass move shallow to spawn — prime lake fishing." },
      { icon: "🌿", label: "Foraging", note: west
        ? "Miner's lettuce, nettles, and morels in the burns and woods."
        : "Ramps, fiddleheads, morels, and dandelion greens." },
      { icon: "🦌", label: "Hunting", note: "Off-season for most big game — small game and turkey (spring season) only." },
      { icon: "⚠️", label: "Watch", note: north
        ? "Snowmelt floods creeks and washes out low crossings."
        : "Ticks are out — check yourself after the brush." },
    );
  } else if (season === "summer") {
    items.push(
      { icon: "🎣", label: "Fishing", note: "Fish dawn and dusk — midday heat pushes fish deep and slow." },
      { icon: "🌿", label: "Foraging", note: west
        ? "Huckleberries and thimbleberries ripen; greens everywhere."
        : "Blackberries, raspberries, and abundant wild greens." },
      { icon: "🦌", label: "Hunting", note: "Big-game seasons are mostly closed — scout now for the fall." },
      { icon: "⚠️", label: "Watch", note: "Heat and dehydration; afternoon thunderstorms and flash floods in the West." },
    );
  } else if (season === "fall") {
    items.push(
      { icon: "🎣", label: "Fishing", note: west
        ? "Salmon and steelhead run the coastal rivers; trout feed hard before winter."
        : "Cooling water fires up the bass and walleye bite." },
      { icon: "🌿", label: "Foraging", note: "Nuts and acorns drop; chanterelles and late berries — the fat time of year." },
      { icon: "🦌", label: "Hunting", note: west
        ? "Prime season — deer and elk are in the rut and on the move."
        : "Prime season — deer rut and waterfowl migration." },
      { icon: "⚠️", label: "Watch", note: north
        ? "First snows arrive; days shorten fast — plan camp before dark."
        : "Cold fronts and shorter days — carry a layer." },
    );
  } else {
    items.push(
      { icon: "🎣", label: "Fishing", note: north
        ? "Hard-water season — ice fishing where safe; open water is slow."
        : "Slow and deep; trout and catfish still take bait in the cold." },
      { icon: "🌿", label: "Foraging", note: "Lean — cattail roots, rosehips, inner bark, and any stored nuts." },
      { icon: "🦌", label: "Hunting", note: "Late seasons and trapping — snares for rabbit and small game." },
      { icon: "⚠️", label: "Watch", note: "Cold is the killer — hypothermia, short days, and thin ice." },
    );
  }

  return { season, monthName: MONTHS[((month % 12) + 12) % 12], items };
}
