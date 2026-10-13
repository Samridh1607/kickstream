import { batched } from "./batch";

test("items that arrive close together are handed on as one list, in order", () => {
  vi.useFakeTimers();
  const delivered: number[][] = [];
  const gathered = batched<number>((items) => delivered.push(items), 30);
  gathered.add(1);
  gathered.add(2);
  expect(delivered).toEqual([]);
  vi.advanceTimersByTime(30);
  gathered.add(3);
  vi.advanceTimersByTime(30);
  expect(delivered).toEqual([[1, 2], [3]]);
  vi.useRealTimers();
});

test("without a wait each item is handed on at once", () => {
  const delivered: number[][] = [];
  const gathered = batched<number>((items) => delivered.push(items), 0);
  gathered.add(1);
  gathered.add(2);
  expect(delivered).toEqual([[1], [2]]);
});

test("cancelling drops what was waiting", () => {
  vi.useFakeTimers();
  const delivered: number[][] = [];
  const gathered = batched<number>((items) => delivered.push(items), 30);
  gathered.add(1);
  gathered.cancel();
  vi.advanceTimersByTime(100);
  expect(delivered).toEqual([]);
  gathered.add(2);
  vi.advanceTimersByTime(30);
  expect(delivered).toEqual([[2]]);
  vi.useRealTimers();
});
