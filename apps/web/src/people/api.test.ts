import { peopleDoc } from "../test/fixtures";
import { invite, inviteLink } from "./api";

test("an invite link uses the public address when there is one", () => {
  expect(inviteLink(peopleDoc(), "/guest/abc", "http://127.0.0.1:5173")).toBe("https://guests.example/guest/abc");
  expect(inviteLink(peopleDoc({ public_origin: null }), "/guest/abc", "http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173/guest/abc");
});

test("an invite without a name sends only the role", async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(peopleDoc()), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await invite("b1", "member", "  ");
  await invite("b1", "cohost", "Kim");
  expect(fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
    ["/api/broadcasts/b1/people/invites", { role: "member" }],
    ["/api/broadcasts/b1/people/invites", { role: "cohost", name: "Kim" }],
  ]);
});
