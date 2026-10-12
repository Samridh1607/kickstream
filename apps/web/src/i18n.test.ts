import { LANGUAGES, LANGUAGE_NAMES, STRINGS, t } from "./i18n";

test("every language defines every string, with no blanks", () => {
  const keys = Object.keys(STRINGS.en).sort();
  for (const language of LANGUAGES) {
    expect(Object.keys(STRINGS[language]).sort()).toEqual(keys);
    for (const value of Object.values(STRINGS[language])) expect(value.trim()).not.toBe("");
  }
});

test("t returns the string for the language", () => {
  expect(t("en", "start")).toBe("Start match");
  expect(t("es", "start")).toBe("Iniciar partido");
  expect(t("hi", "analyst")).toBe("विश्लेषक");
  expect(LANGUAGE_NAMES.es).toBe("Español");
});
