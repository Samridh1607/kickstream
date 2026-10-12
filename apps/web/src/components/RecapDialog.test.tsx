import { fireEvent, screen } from "@testing-library/react";
import { recap } from "../test/fixtures";
import { renderUi } from "../test/render";
import { RecapDialog } from "./RecapDialog";

test("is not shown without a recap", () => {
  renderUi(<RecapDialog recap={null} language="en" onClose={vi.fn()} />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("shows the recap title, summary and three bullets", () => {
  renderUi(<RecapDialog recap={recap()} language="en" onClose={vi.fn()} />);
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Half-time: Northbridge FC 1-0 Harbour City");
  expect(dialog.textContent).toContain("4 key moments so far.");
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Northbridge FC lead 1-0.", "Shots 5-2.", "xG 0.9-0.2.",
  ]);
});

test("the close button reports the close", () => {
  const onClose = vi.fn();
  renderUi(<RecapDialog recap={recap()} language="es" onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
  expect(onClose).toHaveBeenCalledOnce();
});
