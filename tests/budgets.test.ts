// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import {
  checkBudgetAlerts,
  createBudget,
  deleteBudget,
  listBudgetsWithSpending,
  monthBounds,
  updateBudgetLimit,
} from "../src/server/budgets.server.ts";
import { getCapturedEmails, sendEmail } from "../src/server/email.ts";
import { hardDeleteUser } from "../src/server/compliance.server.ts";

// Wrap the real sender (TEST_MODE captures in memory) so individual tests can
// make it fail.
vi.mock("../src/server/email.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/email.ts")>();
  return { ...actual, sendEmail: vi.fn(actual.sendEmail) };
});

const NOW = new Date("2026-10-15T12:00:00Z");

let seq = 0;

/** A fresh user with Food > Groceries > Vegetables, Travel and one account. */
async function seedUser(opts: { verified?: boolean } = {}) {
  const userId = `budget-user-${++seq}-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${userId}@example.com`;
  await db.insert(schema.users).values({
    id: userId,
    username: userId,
    email,
    email_verified_at: opts.verified === false ? null : new Date(),
    password_hash: "x",
  });
  const cat = {
    food: `${userId}-food`,
    groceries: `${userId}-groceries`,
    vegetables: `${userId}-vegetables`,
    travel: `${userId}-travel`,
  };
  await db.insert(schema.categories).values([
    { id: cat.food, user_id: userId, name: "Food" },
    { id: cat.groceries, user_id: userId, name: "Groceries", parent_id: cat.food },
    { id: cat.vegetables, user_id: userId, name: "Vegetables", parent_id: cat.groceries },
    { id: cat.travel, user_id: userId, name: "Travel" },
  ]);
  const accountId = `${userId}-acc`;
  await db
    .insert(schema.accounts)
    .values({ id: accountId, user_id: userId, name: "Main" });

  const addTxn = (amountMinor: number, categoryId: string | null, date = "2026-10-10") =>
    db.insert(schema.transactions).values({
      id: crypto.randomUUID(),
      user_id: userId,
      account_id: accountId,
      date,
      amount_minor: amountMinor,
      category_id: categoryId,
    });

  return { userId, email, cat, addTxn };
}

const budgetAlertEmails = (to: string) =>
  getCapturedEmails(to).filter((e) => e.subject.includes("budget"));

const createdUsers: string[] = [];
async function user(opts?: { verified?: boolean }) {
  const u = await seedUser(opts);
  createdUsers.push(u.userId);
  return u;
}

beforeEach(() => {
  vi.mocked(sendEmail).mockClear();
});

afterEach(async () => {
  for (const id of createdUsers.splice(0)) await hardDeleteUser(id);
});

describe("budgets: month window", () => {
  it("covers the UTC calendar month, rolling over the year", () => {
    expect(monthBounds(NOW)).toEqual({ start: "2026-10-01", end: "2026-11-01" });
    expect(monthBounds(new Date("2026-12-31T23:59:59Z"))).toEqual({
      start: "2026-12-01",
      end: "2027-01-01",
    });
  });
});

describe("budgets: spending", () => {
  it("includes all descendant categories and only this month's outflows", async () => {
    const { userId, cat, addTxn } = await user();
    await createBudget(userId, { categoryId: cat.food, limitMinor: 100_00 });

    await addTxn(-10_00, cat.food);
    await addTxn(-20_00, cat.groceries);
    await addTxn(-5_00, cat.vegetables); // grandchild
    await addTxn(+50_00, cat.groceries); // refund/income — never reduces spent
    await addTxn(-99_00, cat.travel); // unrelated category
    await addTxn(-99_00, null); // uncategorized
    await addTxn(-99_00, cat.food, "2026-09-30"); // last month
    await addTxn(-99_00, cat.food, "2026-11-01"); // next month

    const [food] = await listBudgetsWithSpending(userId, NOW);
    expect(food).toMatchObject({
      categoryPath: "Food",
      limitMinor: 100_00,
      spentMinor: 35_00,
      remainingMinor: 65_00,
      overBudget: false,
    });
  });

  it("budgets a parent and its subcategory independently", async () => {
    const { userId, cat, addTxn } = await user();
    await createBudget(userId, { categoryId: cat.food, limitMinor: 100_00 });
    await createBudget(userId, { categoryId: cat.groceries, limitMinor: 10_00 });
    await addTxn(-30_00, cat.vegetables);

    const budgets = await listBudgetsWithSpending(userId, NOW);
    expect(budgets.map((b) => [b.categoryPath, b.spentMinor, b.overBudget])).toEqual([
      ["Food", 30_00, false],
      ["Food / Groceries", 30_00, true],
    ]);
  });

  it("is over budget only when spent exceeds the limit", async () => {
    const { userId, cat, addTxn } = await user();
    await createBudget(userId, { categoryId: cat.travel, limitMinor: 50_00 });
    await addTxn(-50_00, cat.travel);
    expect((await listBudgetsWithSpending(userId, NOW))[0].overBudget).toBe(false);
    await addTxn(-1, cat.travel);
    const [travel] = await listBudgetsWithSpending(userId, NOW);
    expect(travel.overBudget).toBe(true);
    expect(travel.remainingMinor).toBe(-1);
  });

  it("never mixes users' data", async () => {
    const a = await user();
    const b = await user();
    await createBudget(a.userId, { categoryId: a.cat.food, limitMinor: 100_00 });
    await b.addTxn(-40_00, b.cat.food);
    expect((await listBudgetsWithSpending(a.userId, NOW))[0].spentMinor).toBe(0);
    expect(await listBudgetsWithSpending(b.userId, NOW)).toEqual([]);
  });
});

describe("budgets: create / update / delete", () => {
  it("caps the free plan at 3 budgets and lifts the cap on Pro", async () => {
    const { userId, cat } = await user();
    for (const categoryId of [cat.food, cat.groceries, cat.vegetables]) {
      expect(await createBudget(userId, { categoryId, limitMinor: 1_00 })).toMatchObject({
        success: true,
      });
    }
    expect(
      await createBudget(userId, { categoryId: cat.travel, limitMinor: 1_00 }),
    ).toMatchObject({ code: "budget_limit_reached", limit: 3 });

    await db
      .insert(schema.subscriptions)
      .values({ user_id: userId, plan: "pro", status: "active" });
    expect(
      await createBudget(userId, { categoryId: cat.travel, limitMinor: 1_00 }),
    ).toMatchObject({ success: true });
  });

  it("keeps existing budgets after a downgrade but blocks new ones", async () => {
    const { userId, cat } = await user();
    await db
      .insert(schema.subscriptions)
      .values({ user_id: userId, plan: "pro", status: "active" });
    for (const categoryId of Object.values(cat)) {
      await createBudget(userId, { categoryId, limitMinor: 1_00 });
    }
    await db
      .update(schema.subscriptions)
      .set({ status: "canceled" })
      .where(eq(schema.subscriptions.user_id, userId));

    expect(await listBudgetsWithSpending(userId, NOW)).toHaveLength(4);
    const [first] = await listBudgetsWithSpending(userId, NOW);
    expect(await updateBudgetLimit(userId, { id: first.id, limitMinor: 2_00 })).toMatchObject({
      success: true,
    });
  });

  it("allows one budget per category", async () => {
    const { userId, cat } = await user();
    await createBudget(userId, { categoryId: cat.food, limitMinor: 1_00 });
    expect(
      await createBudget(userId, { categoryId: cat.food, limitMinor: 2_00 }),
    ).toMatchObject({ code: "budget_exists" });
  });

  it("rejects other users' categories and budgets as not found", async () => {
    const owner = await user();
    const intruder = await user();
    expect(
      await createBudget(intruder.userId, { categoryId: owner.cat.food, limitMinor: 1_00 }),
    ).toMatchObject({ code: "category_not_found" });

    const created = await createBudget(owner.userId, {
      categoryId: owner.cat.food,
      limitMinor: 1_00,
    });
    if (!("success" in created)) throw new Error("setup failed");
    expect(
      await updateBudgetLimit(intruder.userId, { id: created.id, limitMinor: 9_00 }),
    ).toMatchObject({ code: "budget_not_found" });
    expect(await deleteBudget(intruder.userId, created.id)).toMatchObject({
      code: "budget_not_found",
    });
    expect((await listBudgetsWithSpending(owner.userId, NOW))[0].limitMinor).toBe(1_00);
  });

  it("deletes a budget together with its alert history", async () => {
    const { userId, cat, addTxn } = await user();
    const created = await createBudget(userId, { categoryId: cat.food, limitMinor: 10_00 });
    if (!("success" in created)) throw new Error("setup failed");
    await addTxn(-20_00, cat.food);
    expect(await checkBudgetAlerts(userId, NOW)).toBe(1);

    expect(await deleteBudget(userId, created.id)).toMatchObject({ success: true });
    expect(await listBudgetsWithSpending(userId, NOW)).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.budget_alerts)
        .where(eq(schema.budget_alerts.user_id, userId)),
    ).toEqual([]);
  });
});

describe("budgets: over-budget email", () => {
  it("sends one email per budget per month, however often it's checked", async () => {
    const { userId, email, cat, addTxn } = await user();
    await createBudget(userId, { categoryId: cat.food, limitMinor: 10_00 });
    await addTxn(-15_00, cat.groceries);

    expect(await checkBudgetAlerts(userId, NOW)).toBe(1);
    expect(await checkBudgetAlerts(userId, NOW)).toBe(0);
    await addTxn(-5_00, cat.food);
    expect(await checkBudgetAlerts(userId, NOW)).toBe(0);

    const emails = budgetAlertEmails(email);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toContain("Food");
    expect(emails[0].text).toContain("15.00");
    expect(emails[0].text).toContain("10.00");
  });

  it("does not double-send when checks run concurrently", async () => {
    const { userId, email, cat, addTxn } = await user();
    await createBudget(userId, { categoryId: cat.food, limitMinor: 10_00 });
    await addTxn(-15_00, cat.food);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => checkBudgetAlerts(userId, NOW)),
    );
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(budgetAlertEmails(email)).toHaveLength(1);
  });

  it("alerts again in a new month", async () => {
    const { userId, email, cat, addTxn } = await user();
    await createBudget(userId, { categoryId: cat.food, limitMinor: 10_00 });
    await addTxn(-15_00, cat.food, "2026-10-10");
    await addTxn(-15_00, cat.food, "2026-11-10");

    expect(await checkBudgetAlerts(userId, NOW)).toBe(1);
    expect(await checkBudgetAlerts(userId, new Date("2026-11-15T12:00:00Z"))).toBe(1);
    expect(budgetAlertEmails(email)).toHaveLength(2);
  });

  it("releases the alert when sending fails so the next check retries", async () => {
    const { userId, email, cat, addTxn } = await user();
    await createBudget(userId, { categoryId: cat.food, limitMinor: 10_00 });
    await addTxn(-15_00, cat.food);

    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("provider down"));
    // A failed send never throws to the caller (the user's action succeeds).
    expect(await checkBudgetAlerts(userId, NOW)).toBe(0);
    expect(budgetAlertEmails(email)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.budget_alerts)
        .where(eq(schema.budget_alerts.user_id, userId)),
    ).toEqual([]);

    expect(await checkBudgetAlerts(userId, NOW)).toBe(1);
    expect(await checkBudgetAlerts(userId, NOW)).toBe(0);
    expect(budgetAlertEmails(email)).toHaveLength(1);
  });

  it("only emails verified addresses, without using up the month's alert", async () => {
    const { userId, email, cat, addTxn } = await user({ verified: false });
    await createBudget(userId, { categoryId: cat.food, limitMinor: 10_00 });
    await addTxn(-15_00, cat.food);

    expect(await checkBudgetAlerts(userId, NOW)).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();

    await db
      .update(schema.users)
      .set({ email_verified_at: new Date() })
      .where(eq(schema.users.id, userId));
    expect(await checkBudgetAlerts(userId, NOW)).toBe(1);
    expect(budgetAlertEmails(email)).toHaveLength(1);
  });

  it("checks when a limit is lowered below what's already spent", async () => {
    const { userId, email, cat, addTxn } = await user();
    await addTxn(-15_00, cat.travel, monthBounds(new Date()).start);
    const created = await createBudget(userId, { categoryId: cat.travel, limitMinor: 100_00 });
    if (!("success" in created)) throw new Error("setup failed");
    expect(budgetAlertEmails(email)).toHaveLength(0);

    await updateBudgetLimit(userId, { id: created.id, limitMinor: 10_00 });
    expect(budgetAlertEmails(email)).toHaveLength(1);
  });
});
