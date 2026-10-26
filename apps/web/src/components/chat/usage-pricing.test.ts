import { describe, expect, it } from "vite-plus/test";
import { usageDollars } from "./usage-pricing";

describe("usageDollars", () => {
  it("rounds API-equivalent costs to one decimal place", () => {
    expect(usageDollars(11.5027)).toBe("$11.5");
    expect(usageDollars(11.56)).toBe("$11.6");
    expect(usageDollars(0.04)).toBe("$0.0");
  });

  it("keeps missing costs unavailable", () => {
    expect(usageDollars(null)).toBe("—");
    expect(usageDollars(undefined)).toBe("—");
  });
});
