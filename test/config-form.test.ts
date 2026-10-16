import { describe, expect, it } from "vitest";
import { changedConfigSections, configFormFromServer } from "@/lib/admin/config-form";

const FALLBACK = ["Cheetahs", "Milk"];

const SERVER = {
  defaultTopics: ["Space", "Food"],
  variants: [{ conditionName: "ab", expression: "percent <= 50", tagColor: "BLUE", topics: ["A"] }],
  enableInterstitialAds: false,
  interstitialAdFrequency: 3,
  enableRewardedAds: true,
  enableBannerAds: false,
  allowedEmails: ["@example.com"],
  modeVisibility: {
    solitaire: true, arena: true, octagon: false, standard: false, cutthroat: false,
    daily: false, versus: false, blitz: false, party: false,
  },
  customParameters: { min_app_version: { value: "1.2.0", valueType: "STRING" as const, description: undefined } },
};

describe("config form dirty check", () => {
  it("treats an unedited form as clean", () => {
    const baseline = configFormFromServer(SERVER, FALLBACK);
    expect(changedConfigSections(configFormFromServer(SERVER, FALLBACK), baseline)).toEqual([]);
  });

  it("ignores key order and undefined-vs-absent fields from serialization", () => {
    const baseline = configFormFromServer(SERVER, FALLBACK);
    const roundTripped = JSON.parse(JSON.stringify(SERVER));
    roundTripped.modeVisibility = Object.fromEntries(Object.entries(SERVER.modeVisibility).reverse());
    expect(changedConfigSections(configFormFromServer(roundTripped, FALLBACK), baseline)).toEqual([]);
  });

  it("fills defaults the same way on both sides", () => {
    const empty = configFormFromServer({}, FALLBACK);
    expect(empty.defaultTopics).toEqual(FALLBACK);
    expect(changedConfigSections(configFormFromServer(undefined, FALLBACK), empty)).toEqual([]);
  });

  it("names exactly the sections that were edited", () => {
    const baseline = configFormFromServer(SERVER, FALLBACK);
    const edited = configFormFromServer(SERVER, FALLBACK);
    edited.modeVisibility = { ...edited.modeVisibility, octagon: true };
    edited.allowedEmails = [...edited.allowedEmails, "new@example.com"];
    expect(changedConfigSections(edited, baseline)).toEqual(["allowedEmails", "modeVisibility"]);
  });

  it("does not share arrays with the server data", () => {
    const form = configFormFromServer(SERVER, FALLBACK);
    form.defaultTopics.push("Mutated");
    form.variants[0].topics.push("Mutated");
    expect(SERVER.defaultTopics).toEqual(["Space", "Food"]);
    expect(SERVER.variants[0].topics).toEqual(["A"]);
  });
});
