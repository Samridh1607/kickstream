import { screen, within } from "@testing-library/react";
import { EMPTY } from "../stream/store";
import { ElementView, type ProgramData } from "../studio/elements";
import { withFallbacks } from "../studio/ProgramPage";
import { audience, element, fanQuestion, poll, scene, studio } from "../test/fixtures";
import { renderUi } from "../test/render";

const QA = { question_id: "q1", question: "Why the change?", nickname: "Ann", answer: "Fresh legs for the press.", ends_at: 1030 };
const REPLAY = { match_id: "m-1", moment_id: "m-1-k1", minute: 23, started_at: 1000, duration_s: 8 };

function show(type: "poll" | "qa", over: Partial<ProgramData> = {}) {
  const data: ProgramData = { match: EMPTY, studio: studio(), now: 1000, language: "en", audience: audience(), ...over };
  return renderUi(<ElementView element={element({ type, props: {} })} data={data} />);
}

test("a poll on air shows the question, each option's share, and whether it is open", () => {
  show("poll", { audience: audience({ poll: poll(), poll_on_air: true }) });
  const shown = within(screen.getByTestId("program-poll"));
  expect(shown.getByText("Who will win?")).toBeTruthy();
  expect(shown.getByText("Open")).toBeTruthy();
  expect(shown.getByText("Northbridge FC")).toBeTruthy();
  expect(shown.getByText("3 · 75%")).toBeTruthy();
  expect(shown.getByText("0 · 0%")).toBeTruthy();
});

test("a poll that is not on air, or does not exist, leaves the element empty", () => {
  const { unmount } = show("poll", { audience: audience({ poll: poll(), poll_on_air: false }) });
  expect(screen.queryByTestId("program-poll")).toBeNull();
  unmount();
  show("poll", { audience: audience({ poll: null, poll_on_air: true }) });
  expect(screen.queryByTestId("program-poll")).toBeNull();
});

test("before the audience arrives both elements are empty", () => {
  show("poll", { audience: null });
  show("qa", { audience: undefined });
  expect(screen.queryByTestId("program-poll")).toBeNull();
  expect(screen.queryByTestId("program-qa")).toBeNull();
});

test("a Q&A on air shows who asked, the question and the answer, in the program language", () => {
  show("qa", { audience: audience({ qa: QA }), language: "es" });
  const shown = within(screen.getByTestId("program-qa"));
  expect(shown.getByText("Ann pregunta")).toBeTruthy();
  expect(shown.getByText("Why the change?")).toBeTruthy();
  expect(shown.getByText("Fresh legs for the press.")).toBeTruthy();
});

test("markup in a question or answer is shown as text on the program", () => {
  const { container } = show("qa", { audience: audience({ qa: { ...QA, question: "<b>why?</b>", nickname: "<i>x</i>" } }) });
  expect(screen.getByText("<b>why?</b>")).toBeTruthy();
  expect(container.querySelector("b, i")).toBeNull();
});

test("a scene with no poll or Q&A element gets a box for whichever is on air", () => {
  const plain = scene();
  expect(withFallbacks(plain, studio(), audience())).toBe(plain);
  expect(withFallbacks(plain, studio(), null)).toBe(plain);
  expect(withFallbacks(plain, studio(), audience({ poll: poll(), poll_on_air: false }))).toBe(plain);

  const types = (items: ReturnType<typeof scene>) => items.elements.slice(plain.elements.length).map((item) => item.type);
  expect(types(withFallbacks(plain, studio(), audience({ poll: poll(), poll_on_air: true })))).toEqual(["poll"]);
  expect(types(withFallbacks(plain, studio(), audience({ qa: QA })))).toEqual(["qa"]);
  const all = withFallbacks(plain, studio({ replay: REPLAY }), audience({ poll: poll(), poll_on_air: true, qa: QA, questions: [fanQuestion()] }));
  expect(types(all)).toEqual(["replay", "poll", "qa"]);
  const layers = all.elements.map((item) => item.layer);
  expect(new Set(layers).size).toBe(layers.length);
  expect(new Set(all.elements.map((item) => item.id)).size).toBe(all.elements.length);
});

test("a scene that already shows the element is left alone, and a hidden one does not count", () => {
  const own = scene({ elements: [element({ id: "p", type: "poll", props: {} })] });
  const live = audience({ poll: poll(), poll_on_air: true });
  expect(withFallbacks(own, studio(), live)).toBe(own);
  const hidden = scene({ elements: [element({ id: "p", type: "poll", visible: false, props: {} })] });
  expect(withFallbacks(hidden, studio(), live).elements).toHaveLength(2);
});

const size = (text: string) => Number.parseFloat((screen.getByText(text) as HTMLElement).style.fontSize);

test("a long question and answer are set smaller, so the whole answer fits its box", () => {
  const { unmount } = show("qa", { audience: audience({ qa: QA }) });
  const short = { question: size(QA.question), answer: size(QA.answer) };
  unmount();
  const long = { ...QA, question: "Q".repeat(200), answer: "A".repeat(400) };
  show("qa", { audience: audience({ qa: long }) });
  expect(size(long.question)).toBeLessThan(short.question);
  expect(size(long.answer)).toBeLessThan(short.answer);
  expect(size(long.answer)).toBeGreaterThanOrEqual(22);
});

test("the default poll and Q&A boxes fit the frame without covering each other", () => {
  const live = audience({ poll: poll(), poll_on_air: true, qa: QA });
  const [first, second] = withFallbacks(scene({ elements: [] }), studio(), live).elements;
  for (const box of [first, second]) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1920);
    expect(box.y + box.height).toBeLessThanOrEqual(1080);
  }
  const apart = first.x + first.width <= second.x || second.x + second.width <= first.x
    || first.y + first.height <= second.y || second.y + second.height <= first.y;
  expect(apart).toBe(true);
});
