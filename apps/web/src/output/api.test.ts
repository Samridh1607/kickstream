import { destination, output } from "../test/fixtures";
import { addDestination, goLive, removeDestination, setDestinationEnabled, setQuality, stopOutput } from "./api";

function serve() {
  const mock = vi.fn(async () => new Response(JSON.stringify(output({ revision: 4 })), { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return () => {
    const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as unknown as [string, RequestInit];
    return { url, method: init.method, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
  };
}

test("each call goes to its route with its body", async () => {
  const last = serve();
  expect((await addDestination({ name: "YouTube", platform: "youtube", url: "", key: "sk-1" })).revision).toBe(4);
  expect(last()).toEqual({ url: "/api/studio/output/destinations", method: "POST", body: { name: "YouTube", platform: "youtube", url: "", key: "sk-1" } });
  await setDestinationEnabled(destination({ id: "d 1", name: "Main", url: "rtmp://h/app" }), false);
  expect(last()).toEqual({ url: "/api/studio/output/destinations/d%201", method: "PUT", body: { name: "Main", url: "rtmp://h/app", enabled: false } });
  await removeDestination("d 1");
  expect(last()).toMatchObject({ url: "/api/studio/output/destinations/d%201", method: "DELETE" });
  await setQuality("1080p30");
  expect(last()).toEqual({ url: "/api/studio/output/quality", method: "PUT", body: { quality: "1080p30" } });
  await goLive();
  expect(last()).toMatchObject({ url: "/api/studio/output/start", method: "POST" });
  await stopOutput();
  expect(last()).toMatchObject({ url: "/api/studio/output/stop", method: "POST" });
});
