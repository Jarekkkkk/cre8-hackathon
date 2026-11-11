import { test, expect } from "bun:test";
import worker from "../public/_worker.js";

test("the root serves the landing page on every host, while filtered root links stay in the app", async () => {
  const env = {
    ASSETS: {
      fetch: (request: Request) => {
        const { pathname, search } = new URL(request.url);
        return new Response(pathname + search);
      },
    },
  };
  const app = await worker.fetch(new Request("https://cre8-atp.pages.dev/?period=30D"), env);
  const pagesRoot = await worker.fetch(new Request("https://cre8-atp.pages.dev/"), env);
  const marketing = await worker.fetch(new Request("https://beta.cre8.finance/"), env);
  const landing = await worker.fetch(new Request("https://cre8-atp.pages.dev/landing/"), env);
  expect(await app.text()).toBe("/?period=30D");
  expect(await pagesRoot.text()).toBe("/landing/");
  expect(await marketing.text()).toBe("/landing/");
  expect(await landing.text()).toBe("/landing/");
});

test("public history proxy is fixed, read-only and strips wallet credentials", async () => {
  const original = globalThis.fetch,
    calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    if (init?.redirect === "error")
      throw new TypeError("Workers does not implement redirect:error");
    calls.push({ url: String(input), init });
    return new Response(init?.method === "HEAD" ? null : "{}", {
      headers: { "set-cookie": "upstream=unused" },
    });
  };
  try {
    const response = await worker.fetch(
      new Request(
        "https://cre8-atp.pages.dev/reference-data/demo-funds?url=https://example.invalid",
        {
          headers: {
            Authorization: "Bearer fixture-only",
            Cookie: "fixture=unused",
          },
        },
      ),
      {
        ASSETS: {
          fetch: () => {
            throw new Error("Unexpected static fetch");
          },
        },
      },
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://bnb-agent-vaults.vercel.app/api/demo-funds/",
    );
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    const denied = await worker.fetch(
      new Request("https://cre8-atp.pages.dev/reference-data/demo-funds", {
        method: "POST",
      }),
      {},
    );
    expect(denied.status).toBe(405);
    expect(calls).toHaveLength(1);
    const head = await worker.fetch(
      new Request("https://cre8-atp.pages.dev/reference-data/demo-funds", {
        method: "HEAD",
      }),
      {},
    );
    expect(head.body).toBeNull();
    expect(calls[1].init?.method).toBe("HEAD");
  } finally {
    globalThis.fetch = original;
  }
});
test("existing authenticated Railway API path and static routing keep their behavior", async () => {
  const original = globalThis.fetch;
  let seen: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = async (input, init) => {
    seen = { url: String(input), init };
    return new Response("{}");
  };
  try {
    await worker.fetch(
      new Request("https://cre8-atp.pages.dev/api/portfolios?limit=1", {
        headers: { Authorization: "Bearer fixture-only" },
      }),
      {},
    );
    expect(seen!.url).toBe(
      "https://api-production-7f13.up.railway.app/portfolios?limit=1",
    );
    const headers = new Headers(seen!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-only");
    expect(headers.get("x-forwarded-host")).toBe("cre8-atp.pages.dev");
    let assets = 0;
    const response = await worker.fetch(
      new Request("https://cre8-atp.pages.dev/funds/mag7"),
      {
        ASSETS: {
          fetch: () => {
            assets++;
            return new Response("SPA");
          },
        },
      },
    );
    expect(await response.text()).toBe("SPA");
    expect(assets).toBe(1);
  } finally {
    globalThis.fetch = original;
  }
});

test("public reference refuses upstream redirects and reports fetch failures without leaving the fixed source", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://unrelated.example" },
      });
    const redirected = await worker.fetch(
      new Request("https://cre8-atp.pages.dev/reference-data/demo-funds"),
      {},
    );
    expect(redirected.status).toBe(502);
    expect(redirected.headers.get("location")).toBeNull();
    globalThis.fetch = async () => {
      throw new Error("Origin unavailable");
    };
    const unavailable = await worker.fetch(
      new Request("https://cre8-atp.pages.dev/reference-data/demo-funds"),
      {},
    );
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error).toBe(
      "Reference temporarily unavailable",
    );
  } finally {
    globalThis.fetch = original;
  }
});
