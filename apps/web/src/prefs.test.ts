import { DEFAULT_PROFILE, loadProfile, saveProfile } from "./prefs";

const KEY = "kickstream.profile";

test("a saved profile is read back", () => {
  saveProfile({ mode: "analyst", language: "hi", club: "nbr", player: "nbr-9" });
  expect(loadProfile()).toEqual({ mode: "analyst", language: "hi", club: "nbr", player: "nbr-9" });
});

test("nothing saved gives the defaults", () => {
  expect(loadProfile()).toEqual(DEFAULT_PROFILE);
  expect(DEFAULT_PROFILE).toEqual({ mode: "fan", language: "en", club: null, player: null });
});

test.each([
  ["invalid JSON", "{not json"],
  ["a non-object", '"fan"'],
  ["null", "null"],
  ["an array", "[1,2]"],
])("%s gives the defaults", (_, raw) => {
  localStorage.setItem(KEY, raw);
  expect(loadProfile()).toEqual(DEFAULT_PROFILE);
});

test("unknown or mistyped fields fall back one by one", () => {
  localStorage.setItem(KEY, JSON.stringify({ mode: "coach", language: "fr", club: 7, player: "" }));
  expect(loadProfile()).toEqual(DEFAULT_PROFILE);
  localStorage.setItem(KEY, JSON.stringify({ mode: "analyst", language: "de", club: "nbr" }));
  expect(loadProfile()).toEqual({ mode: "analyst", language: "en", club: "nbr", player: null });
});

test("storage that throws is tolerated on read and write", () => {
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("quota"); },
  };
  expect(loadProfile(broken)).toEqual(DEFAULT_PROFILE);
  expect(() => saveProfile(DEFAULT_PROFILE, broken)).not.toThrow();
});

test("a browser that refuses access to storage altogether still gets the defaults", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });
  try {
    expect(loadProfile()).toEqual(DEFAULT_PROFILE);
    expect(() => saveProfile(DEFAULT_PROFILE)).not.toThrow();
  } finally {
    Object.defineProperty(globalThis, "localStorage", original);
  }
});
