import { test, expect } from "@playwright/test";
test("desktop: usable empty state, empty storage, guarded conversation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A little more human." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start conversation" }).click();
  await expect(page.locator(".error-banner")).toContainText(
    "Connect your ChatGPT account first",
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Hello");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".error-banner")).toContainText(
    "Connect your ChatGPT account",
  );
  const storage = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
  expect(storage.local).toEqual([]);
  expect(storage.session).toEqual([]);
  expect(errors).toEqual([]);
});
test("mobile: no overflow and preferences remain available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Continue with ChatGPT" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect(page.getByLabel("RUN VOICE WITH")).toBeVisible();
});
test("login rejects cross-origin requests and invalid callbacks", async ({
  request,
}) => {
  const denied = await request.post("/api/auth/start", {
    headers: { Origin: "https://other.example" },
    data: { hostId: "urn:uuid:12345678-1234-4234-8234-123456789abc" },
  });
  expect(denied.status()).toBe(403);
  const start = await request.post("/api/auth/start", {
    headers: { Origin: "http://127.0.0.1:1455" },
    data: { hostId: "urn:uuid:12345678-1234-4234-8234-123456789abc" },
  });
  expect(start.status()).toBe(200);
  const data = await start.json();
  expect(new URL(data.url).searchParams.get("redirect_uri")).toBe(
    "http://127.0.0.1:1455/auth/callback",
  );
  const callback = await request.get(
    "/auth/callback?state=wrong&code=not-a-real-code&client_id=oaiapp_test",
  );
  expect(await callback.text()).toContain("Sign-in could not be verified");
  expect(callback.headers()["cache-control"]).toContain("no-store");
  expect(callback.headers()["content-security-policy"]).toContain(
    "default-src 'none'",
  );
  const result = await request.post("/api/auth/result", {
    headers: { Origin: "http://127.0.0.1:1455" },
  });
  expect((await result.json()).error).toContain(
    "Sign-in could not be verified",
  );
  const consumed = await request.post("/api/auth/result", {
    headers: { Origin: "http://127.0.0.1:1455" },
  });
  expect((await consumed.json()).status).toBe("pending");
  expect(
    (
      await request.post("/api/auth/result", {
        headers: { Origin: "https://other.example" },
      })
    ).status(),
  ).toBe(403);
});
test("one-time login handoff works without an opener and chat uses the credential-forwarding relay", async ({
  page,
}) => {
  const token = "fixture-access-not-a-real-token";
  let signedIn = false;
  let relayedRequests = 0;
  let catalogRequests = 0;
  let expectedModel = "fixture-model";
  let expectedEffort: string | undefined = "low";
  await page.route("**/api/auth/start", async (route) => {
    signedIn = true;
    await route.fulfill({ json: { url: "about:blank" } });
  });
  await page.route("**/api/auth/result", async (route) => {
    await route.fulfill({
      json: signedIn
        ? {
            status: "complete",
            session: {
              accessToken: token,
              refreshToken: "fixture-refresh",
              idToken: "fixture-id",
              clientId: "oaiapp_fixture",
              subject: "fixture-subject",
              email: "test@example.com",
              expiresAt: Date.now() + 3600000,
              scopes: ["chatgpt.tokens.use.direct"],
            },
          }
        : { status: "pending" },
    });
    signedIn = false;
  });
  await page.route("**/api/openai/models", async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    catalogRequests++;
    if (catalogRequests === 1) {
      await route.fulfill({ status: 503, json: { error: "Temporary outage" } });
      return;
    }
    await route.fulfill({
      json: {
        models: [
          {
            slug: "fixture-model",
            display_name: "Fixture model",
            visibility: "list",
            default_reasoning_level: "low",
            supported_reasoning_levels: [
              { effort: "low", description: "Fast" },
              { effort: "medium", description: "Balanced" },
            ],
          },
          {
            slug: "other-model",
            display_name: "Other model",
            visibility: "list",
            default_reasoning_level: "high",
            supported_reasoning_levels: [
              { effort: "none", description: "No reasoning" },
              { effort: "high", description: "Deeper thinking" },
            ],
          },
          {
            slug: "fixed-model",
            display_name: "Fixed reasoning",
            visibility: "list",
          },
          { slug: "hidden-model", visibility: "hidden" },
        ],
      },
    });
  });
  await page.route("**/api/openai/responses", async (route) => {
    relayedRequests++;
    const body = route.request().postDataJSON();
    expect(body.model).toBe(expectedModel);
    expect(body.reasoning).toEqual(
      expectedEffort ? { effort: expectedEffort } : undefined,
    );
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    await route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"response.output_text.delta","delta":"A test reply from a mocked OpenAI stream."}\n\ndata: {"type":"response.completed"}\n\n',
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await expect(page.getByText("Your plan is connected")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Disconnect account" }),
  ).toHaveCount(0);
  await expect(page.locator("#manual-model")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry model list" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry model list" }).click();
  await expect(page.getByLabel("CONVERSATION MODEL")).toBeEnabled();
  await expect(page.locator("#model option")).toHaveCount(3);
  await expect(page.getByLabel("REASONING LEVEL")).toHaveValue("low");
  await expect(page.locator('#reasoning option[value="none"]')).toHaveCount(0);
  await expect(page.getByLabel("CONVERSATION MODEL")).toHaveValue(
    "fixture-model",
  );
  await page.getByRole("button", { name: "Turn spoken replies off" }).click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Hello");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".message.assistant")).toContainText(
    "A test reply from a mocked OpenAI stream.",
  );
  expect(relayedRequests).toBe(1);
  expectedModel = "other-model";
  expectedEffort = "none";
  await page.getByLabel("CONVERSATION MODEL").selectOption(expectedModel);
  await expect(page.getByLabel("REASONING LEVEL")).toHaveValue("none");
  await expect(page.locator(".message")).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Test no reasoning");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".message.assistant")).toContainText(
    "A test reply",
  );
  expectedEffort = "high";
  await page.getByLabel("REASONING LEVEL").selectOption("high");
  await expect(page.locator("#reasoning-description")).toHaveText(
    "Deeper thinking",
  );
  await page
    .getByRole("button", { name: "Refresh models", exact: true })
    .click();
  await expect(page.getByLabel("REASONING LEVEL")).toHaveValue("high");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Test high reasoning");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".message.assistant").last()).toContainText(
    "A test reply",
  );
  expectedModel = "fixed-model";
  expectedEffort = undefined;
  await page.getByLabel("CONVERSATION MODEL").selectOption(expectedModel);
  await expect(page.getByLabel("REASONING LEVEL")).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Test model default");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".message.assistant")).toContainText(
    "A test reply",
  );
  expect(relayedRequests).toBe(4);
  const storage = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(storage).toContain("voice-lab-session-v1");
  expect(storage).toContain(token);
  expect(storage).toContain("fixture-refresh");
  await page.reload();
  await expect(page.getByText("Your plan is connected")).toBeVisible();
  await expect(page.getByLabel("CONVERSATION MODEL")).toHaveValue(
    "fixed-model",
  );
  await expect(
    page.getByRole("button", { name: "Continue with ChatGPT" }),
  ).toHaveCount(0);
  await expect(page.locator(".message")).toHaveCount(0);
});

test("saved expired login renews once and persists rotated credentials across reloads", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem(
      "voice-lab-session-v1",
      JSON.stringify({
        accessToken: "expired-fixture",
        refreshToken: "old-refresh",
        idToken: "id-fixture",
        clientId: "oaiapp_fixture",
        subject: "fixture",
        email: "test@example.com",
        expiresAt: 0,
        scopes: ["chatgpt.tokens.use.direct"],
      }),
    ),
  );
  let renewals = 0;
  await page.route("**/api/openai/refresh", async (route) => {
    renewals++;
    expect(route.request().postData()).toContain("refresh_token=old-refresh");
    await route.fulfill({
      json: {
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      },
    });
  });
  await page.route("**/api/openai/models", async (route) => {
    expect(route.request().headers().authorization).toBe(
      "Bearer rotated-access",
    );
    await route.fulfill({
      json: {
        models: [
          {
            slug: "gpt-6-luna",
            display_name: "GPT-6-Luna",
            visibility: "list",
            default_reasoning_level: "medium",
            supported_reasoning_levels: [
              { effort: "low", description: "Fast" },
            ],
          },
        ],
      },
    });
  });
  await page.reload();
  await expect(page.getByLabel("REASONING LEVEL")).toHaveValue("none");
  await expect(page.getByText("Your plan is connected")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("voice-lab-session-v1")!).refreshToken,
    ),
  ).toBe("rotated-refresh");
  await page.reload();
  await expect(page.getByLabel("CONVERSATION MODEL")).toHaveValue("gpt-6-luna");
  expect(renewals).toBe(1);
});
