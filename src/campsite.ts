// Camp check — is this a good spot to camp?
//
// Scores the ground under the crosshair from what the map and terrain already
// know: how flat it is (DEM slope), how far the nearest water is, whether
// there's tree cover, and whose land it is. Pure scoring so it can be tested;
// main.ts gathers the inputs from the map. Tested in tests/campsite.test.ts.

export type CampVerdict = "good" | "fair" | "poor" | "avoid";

export interface CampInputs {
  /** Ground slope in degrees, or null if there's no terrain for this pack. */
  slopeDeg: number | null;
  /** Metres to the nearest water, or null if none was found nearby. */
  waterMeters: number | null;
  /** Is the spot in forest/woods (shelter + firewood)? */
  treeCover: boolean;
  /** Land ownership as far as the basemap knows. */
  land: "public" | "military" | "unknown";
  /** Is the spot in mapped wetland? */
  wetland: boolean;
}

export interface CampResult {
  verdict: CampVerdict;
  reasons: string[]; // plain-language, best first
}

export function scoreCamp(i: CampInputs): CampResult {
  const reasons: string[] = [];
  let score = 0;
  let hardAvoid = false;

  // --- Gates that override the score ---
  if (i.land === "military") {
    hardAvoid = true;
    reasons.push("On a military reservation — do not camp here.");
  }
  if (i.slopeDeg != null && i.slopeDeg > 20) {
    hardAvoid = true;
    reasons.push(`Steep ground (${Math.round(i.slopeDeg)}°) — no flat spot to lie down.`);
  }
  if (i.wetland) {
    score -= 3;
    reasons.push("Mapped wetland — wet, buggy, and prone to flooding.");
  }

  // --- Slope ---
  if (i.slopeDeg == null) {
    reasons.push("No terrain data here — check the ground is flat yourself.");
  } else if (i.slopeDeg <= 5) {
    score += 2;
    reasons.push(`Flat ground (${Math.round(i.slopeDeg)}°) — good for a tent.`);
  } else if (i.slopeDeg <= 12) {
    score += 1;
    reasons.push(`Gently sloped (${Math.round(i.slopeDeg)}°) — sleep with your head uphill.`);
  } else if (i.slopeDeg <= 20) {
    score -= 1;
    reasons.push(`Noticeably sloped (${Math.round(i.slopeDeg)}°) — water would run through camp.`);
  }

  // --- Water proximity: close is convenient, too close floods and chills ---
  if (i.waterMeters == null) {
    score -= 1;
    reasons.push("No water within about 3 km — you'd have to carry it in.");
  } else if (i.waterMeters < 30) {
    score -= 1;
    reasons.push("Right on the water — risk of flooding, cold air, and bugs; back off 60–90 m.");
  } else if (i.waterMeters <= 800) {
    score += 2;
    reasons.push(`Water about ${Math.round(i.waterMeters)} m away — close enough to fetch, far enough to be dry.`);
  } else if (i.waterMeters <= 3000) {
    reasons.push(`Nearest water is roughly ${(i.waterMeters / 1000).toFixed(1)} km — a hike, but reachable.`);
  } else {
    score -= 1;
    reasons.push(`Nearest water is over 3 km away — plan to carry it in.`);
  }

  // --- Cover ---
  if (i.treeCover) {
    score += 1;
    reasons.push("Tree cover for shelter, shade, and firewood.");
  } else {
    reasons.push("Open ground — exposed to wind; pitch behind what break you can find.");
  }

  // --- Land ---
  if (i.land === "public") {
    score += 1;
    reasons.push("On public land — camping is likely allowed, but check local rules.");
  } else if (i.land === "unknown") {
    reasons.push("Land ownership unknown here — could be private; verify before you settle in.");
  }

  let verdict: CampVerdict;
  if (hardAvoid) verdict = "avoid";
  else if (score >= 4) verdict = "good";
  else if (score >= 1) verdict = "fair";
  else verdict = "poor";

  return { verdict, reasons };
}
