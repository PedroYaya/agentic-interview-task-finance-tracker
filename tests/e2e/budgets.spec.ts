import type { APIRequestContext } from "@playwright/test";
import { test, expect, type Page } from "./fixtures";

// Monthly category budgets. Every test gets its own seeded user (default
// categories + a "Main" PLN account), so the suite runs fully parallel.
// Over-budget emails are captured by the TEST_MODE provider and read back via
// /test-emails.

type CapturedEmail = { to: string; subject: string; text: string };

// Mid-month in the server's (UTC) current month, so the transaction counts
// toward "this month" whatever the local timezone.
const now = new Date();
const THIS_MONTH_DATE = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-15T12:00`;

async function budgetEmails(request: APIRequestContext, to: string) {
  const res = await request.get(`/test-emails?to=${encodeURIComponent(to)}`);
  const { emails } = (await res.json()) as { emails: CapturedEmail[] };
  return emails.filter((e) => e.subject.includes("budget"));
}

async function addBudget(page: Page, category: string, limit: string) {
  await page.getByRole("button", { name: "Add Budget" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Budget" });
  await dialog.getByLabel("Category").selectOption({ label: category });
  await dialog.getByLabel("Monthly limit").fill(limit);
  await dialog.getByRole("button", { name: "Create Budget" }).click();
  await expect(dialog).toBeHidden();
}

async function addTransaction(
  page: Page,
  opts: { description: string; amount: string; category: string; isIncome?: boolean },
) {
  await page.goto("/transactions");
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add Transaction" })
    .click();
  const modal = page.getByRole("dialog", { name: "New Transaction" });
  await modal.getByLabel("Date").fill(THIS_MONTH_DATE);
  await modal.getByLabel("Description").fill(opts.description);
  await modal
    .getByRole("spinbutton", { name: "Amount", exact: true })
    .fill(opts.amount);
  await modal.getByLabel("Account").selectOption("Main (PLN)");
  await modal.getByLabel("Category").selectOption({ label: opts.category });
  if (opts.isIncome) {
    await modal.getByLabel("Income").check();
  }
  await modal.getByRole("button", { name: "Create Transaction" }).click();
  await expect(modal).toBeHidden();
}

const budgetItem = (page: Page, category: string) =>
  page.getByRole("list", { name: "Budgets" }).getByRole("listitem", {
    name: category,
    exact: true,
  });

test.describe("Budgets", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    await page.goto("/budgets");
    await expect(page).toHaveURL("/budgets");
  });

  test("is reachable from the main navigation and starts empty", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Budgets" }).click();
    await expect(page).toHaveURL("/budgets");
    await expect(
      page.getByRole("heading", { name: "Budgets", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("No budgets yet")).toBeVisible();
    await expect(
      page.getByText("0 of 3 budgets used on the free plan."),
    ).toBeVisible();
  });

  test("adds a budget, changes its limit, and removes it", async ({ page }) => {
    await addBudget(page, "Groceries", "100");

    const item = budgetItem(page, "Groceries");
    await expect(item).toBeVisible();
    await expect(item.getByText("100.00")).toHaveCount(2); // limit + left
    await expect(item.getByText("0.00", { exact: true })).toBeVisible(); // spent

    await item.getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Budget" });
    await expect(dialog.getByLabel("Category")).toBeDisabled();
    await expect(dialog.getByLabel("Monthly limit")).toHaveValue("100");
    await dialog.getByLabel("Monthly limit").fill("250.50");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(dialog).toBeHidden();
    await expect(item.getByText("250.50")).toHaveCount(2);

    await item.getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete budget?" });
    await expect(confirm).toContainText("Groceries");
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("No budgets yet")).toBeVisible();
  });

  test("validates the form", async ({ page }) => {
    await page.getByRole("button", { name: "Add Budget" }).click();
    const dialog = page.getByRole("dialog", { name: "Add Budget" });

    await dialog.getByLabel("Monthly limit").fill("50");
    await dialog.getByRole("button", { name: "Create Budget" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Please choose a category.",
    );

    await dialog.getByLabel("Category").selectOption({ label: "Transport" });
    await dialog.getByLabel("Monthly limit").fill("0");
    await dialog.getByRole("button", { name: "Create Budget" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Enter a monthly limit greater than zero.",
    );
  });

  test("hides categories that already have a budget from the picker", async ({
    page,
  }) => {
    await addBudget(page, "Housing", "1000");
    await page.getByRole("button", { name: "Add Budget" }).click();
    const picker = page
      .getByRole("dialog", { name: "Add Budget" })
      .getByLabel("Category");
    await expect(picker.getByRole("option", { name: "Housing", exact: true })).toHaveCount(0);
    await expect(
      picker.getByRole("option", { name: "Housing / Utilities", exact: true }),
    ).toHaveCount(1);
  });

  test("counts subcategory spending but not income or refunds", async ({
    page,
  }) => {
    await addBudget(page, "Groceries", "100");

    await addTransaction(page, {
      description: "Veg market",
      amount: "30",
      category: "— Vegetables",
    });
    await addTransaction(page, {
      description: "Bakery",
      amount: "12.50",
      category: "Groceries",
    });
    await addTransaction(page, {
      description: "Grocery refund",
      amount: "20",
      category: "Groceries",
      isIncome: true,
    });

    await page.goto("/budgets");
    const item = budgetItem(page, "Groceries");
    await expect(item.getByText("42.50")).toBeVisible(); // spent
    await expect(item.getByText("57.50")).toBeVisible(); // left
    await expect(item.getByText("Over budget")).toHaveCount(0);
  });

  test("shows over budget and emails once per month", async ({
    page,
    signedInUser,
  }) => {
    const email = `${signedInUser.username}@example.com`;
    await addBudget(page, "Transport", "10");

    await addTransaction(page, {
      description: "Fuel station",
      amount: "25",
      category: "— Fuel",
    });

    await page.goto("/budgets");
    const item = budgetItem(page, "Transport");
    await expect(item.getByText("Over budget")).toBeVisible();
    await expect(item.getByText("Over by 15.00")).toBeVisible();

    await expect
      .poll(async () => (await budgetEmails(page.request, email)).length)
      .toBe(1);
    const [alert] = await budgetEmails(page.request, email);
    expect(alert.subject).toContain("Transport");
    expect(alert.text).toContain("25.00");

    // Still over after more spending — but no second email this month.
    await addTransaction(page, {
      description: "Bus ticket",
      amount: "5",
      category: "— Public Transport",
    });
    await page.goto("/budgets");
    await expect(item.getByText("Over by 20.00")).toBeVisible();
    expect(await budgetEmails(page.request, email)).toHaveLength(1);
  });

  test("emails when the limit is lowered below what's spent", async ({
    page,
    signedInUser,
  }) => {
    const email = `${signedInUser.username}@example.com`;
    await addTransaction(page, {
      description: "Cinema",
      amount: "40",
      category: "— Hobbies",
    });
    await page.goto("/budgets");
    await addBudget(page, "Entertainment", "100");
    expect(await budgetEmails(page.request, email)).toHaveLength(0);

    const item = budgetItem(page, "Entertainment");
    await item.getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Budget" });
    await dialog.getByLabel("Monthly limit").fill("30");
    await dialog.getByRole("button", { name: "Save Changes" }).click();

    await expect(item.getByText("Over by 10.00")).toBeVisible();
    await expect
      .poll(async () => (await budgetEmails(page.request, email)).length)
      .toBe(1);
  });

  test("free plan is limited to 3 budgets with an upgrade prompt", async ({
    page,
  }) => {
    await addBudget(page, "Groceries", "100");
    await addBudget(page, "Housing", "100");
    await expect(
      page.getByText("2 of 3 budgets used on the free plan."),
    ).toBeVisible();
    await addBudget(page, "Transport", "100");

    await expect(page.getByRole("button", { name: "Add Budget" })).toBeDisabled();
    const banner = page.getByRole("status").filter({
      hasText: "The free plan is limited to 3 budgets.",
    });
    await expect(banner).toBeVisible();
    await banner.getByRole("link", { name: "Upgrade to Pro" }).click();
    await expect(page).toHaveURL("/billing");
  });

  test("pro plan has unlimited budgets", async ({ page }) => {
    await page.request.post("/test-set-plan?plan=pro");
    await page.goto("/budgets");
    for (const category of ["Groceries", "Housing", "Transport", "Health"]) {
      await addBudget(page, category, "100");
    }
    await expect(page.getByRole("list", { name: "Budgets" }).getByRole("listitem")).toHaveCount(4);
    await expect(page.getByRole("button", { name: "Add Budget" })).toBeEnabled();
    await expect(page.getByText(/budgets used on the free plan/)).toHaveCount(0);
  });

  test("keeps budgets after downgrading but blocks new ones", async ({
    page,
  }) => {
    await page.request.post("/test-set-plan?plan=pro");
    await page.goto("/budgets");
    for (const category of ["Groceries", "Housing", "Transport", "Health"]) {
      await addBudget(page, category, "100");
    }

    await page.request.post("/test-set-plan?plan=free");
    await page.goto("/budgets");
    await expect(page.getByRole("list", { name: "Budgets" }).getByRole("listitem")).toHaveCount(4);
    await expect(page.getByRole("button", { name: "Add Budget" })).toBeDisabled();

    // Existing budgets stay editable.
    const item = budgetItem(page, "Health");
    await item.getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Budget" });
    await dialog.getByLabel("Monthly limit").fill("75");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(item.getByText("75.00")).toHaveCount(2);
  });

  test("deleting a category removes its budget", async ({ page }) => {
    await addBudget(page, "Shopping", "100");
    await expect(budgetItem(page, "Shopping")).toBeVisible();

    await page.goto("/categories");
    const row = page.getByRole("row").filter({ hasText: "Shopping" }).first();
    await row.getByTestId("delete-category").click();
    await page
      .getByRole("alertdialog", { name: "Delete Category" })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(
      page.getByRole("alertdialog", { name: "Delete Category" }),
    ).toBeHidden();

    await page.goto("/budgets");
    await expect(page.getByText("No budgets yet")).toBeVisible();
  });
});
