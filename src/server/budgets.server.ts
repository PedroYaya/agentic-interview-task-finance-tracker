import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "#/db";
import { formatMinor } from "#/lib/money";
import { m } from "#/paraglide/messages";
import { monthStart } from "#/server/ai-usage.server";
import { checkBudgetLimit, getEntitlements } from "#/server/billing.server";
import { sendEmail } from "#/server/email";
import { env } from "#/server/env";
import { getLogger } from "#/server/logger";

//
// Monthly category budgets. Spending is computed live — never stored — over
// the current UTC calendar month, so budgets reset when the month rolls
// over. A budget covers its category and every descendant category, and only
// outflows (negative amounts) count: income and refunds never reduce it.
//
// Over-budget emails are deduplicated through budget_alerts (one row per
// budget per month), claimed before sending and released if the send fails.

type Db = typeof defaultDb;

export interface BudgetStatus {
  id: string;
  categoryId: string;
  /** Category name with its ancestors, e.g. "Groceries / Vegetables". */
  categoryPath: string;
  categoryColor: string | null;
  limitMinor: number;
  spentMinor: number;
  /** Negative when over budget. */
  remainingMinor: number;
  overBudget: boolean;
}

/** "YYYY-MM-DD" bounds of the UTC calendar month containing `now`:
 * `start` inclusive, `end` exclusive. */
export function monthBounds(now: Date): { start: string; end: string } {
  const start = monthStart(now);
  const end = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
  );
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

/** Every budget of the user with this month's spending, sorted by category. */
export async function listBudgetsWithSpending(
  userId: string,
  now: Date = new Date(),
  db: Db = defaultDb,
): Promise<BudgetStatus[]> {
  const budgets = await db
    .select({
      id: schema.budgets.id,
      categoryId: schema.budgets.category_id,
      limitMinor: schema.budgets.limit_minor,
    })
    .from(schema.budgets)
    .where(eq(schema.budgets.user_id, userId));
  if (budgets.length === 0) return [];

  const categories = await db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      parentId: schema.categories.parent_id,
      color: schema.categories.color,
    })
    .from(schema.categories)
    .where(eq(schema.categories.user_id, userId));

  const { start, end } = monthBounds(now);
  const spendingRows = await db
    .select({
      categoryId: schema.transactions.category_id,
      spent: sql<number>`COALESCE(SUM(-${schema.transactions.amount_minor}), 0)`.mapWith(Number),
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.user_id, userId),
        lt(schema.transactions.amount_minor, 0),
        gte(schema.transactions.date, start),
        lt(schema.transactions.date, end),
      ),
    )
    .groupBy(schema.transactions.category_id);

  const byId = new Map(categories.map((c) => [c.id, c]));
  const children = new Map<string, string[]>();
  for (const c of categories) {
    if (!c.parentId) continue;
    children.set(c.parentId, [...(children.get(c.parentId) ?? []), c.id]);
  }
  const spentByCategory = new Map<string, number>();
  for (const row of spendingRows) {
    if (row.categoryId) spentByCategory.set(row.categoryId, row.spent);
  }

  // Sum the category and all its descendants. `seen` guards against a
  // malformed parent cycle.
  const subtreeSpent = (rootId: string): number => {
    let total = 0;
    const seen = new Set<string>();
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      total += spentByCategory.get(id) ?? 0;
      stack.push(...(children.get(id) ?? []));
    }
    return total;
  };

  const categoryPath = (id: string): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    let cursor = byId.get(id);
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      names.unshift(cursor.name);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return names.join(" / ");
  };

  return budgets
    .map((b) => {
      const spentMinor = subtreeSpent(b.categoryId);
      return {
        id: b.id,
        categoryId: b.categoryId,
        categoryPath: categoryPath(b.categoryId),
        categoryColor: byId.get(b.categoryId)?.color ?? null,
        limitMinor: b.limitMinor,
        spentMinor,
        remainingMinor: b.limitMinor - spentMinor,
        overBudget: spentMinor > b.limitMinor,
      };
    })
    .sort((a, b) => a.categoryPath.localeCompare(b.categoryPath));
}

/** Budgets page payload: the budgets plus plan usage for the upsell UI. */
export async function getBudgetsOverview(
  userId: string,
  now: Date = new Date(),
  db: Db = defaultDb,
) {
  const [budgets, entitlements] = await Promise.all([
    listBudgetsWithSpending(userId, now, db),
    getEntitlements(userId, db),
  ]);
  return {
    budgets,
    /** First day of the month the spending covers, "YYYY-MM-DD". */
    month: monthBounds(now).start,
    plan: entitlements.plan,
    /** null = unlimited. */
    maxBudgets: entitlements.maxBudgets,
  };
}

export type BudgetMutationResult =
  | { success: true; id: string }
  | {
      error: string;
      code:
        | "category_not_found"
        | "budget_exists"
        | "budget_not_found"
        | "budget_limit_reached";
      limit?: number;
    };

export async function createBudget(
  userId: string,
  input: { categoryId: string; limitMinor: number },
  db: Db = defaultDb,
): Promise<BudgetMutationResult> {
  const category = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.id, input.categoryId),
        eq(schema.categories.user_id, userId),
      ),
    )
    .limit(1);
  if (category.length === 0) {
    return { error: "Category does not exist", code: "category_not_found" };
  }

  const limit = await checkBudgetLimit(userId, db);
  if (!limit.allowed) {
    return { error: limit.error, code: limit.code, limit: limit.limit };
  }

  const id = crypto.randomUUID();
  const inserted = await db
    .insert(schema.budgets)
    .values({
      id,
      user_id: userId,
      category_id: input.categoryId,
      limit_minor: input.limitMinor,
    })
    .onConflictDoNothing({ target: schema.budgets.category_id })
    .returning({ id: schema.budgets.id });
  if (inserted.length === 0) {
    return {
      error: "This category already has a budget",
      code: "budget_exists",
    };
  }

  await checkBudgetAlerts(userId, new Date(), db);
  return { success: true, id };
}

export async function updateBudgetLimit(
  userId: string,
  input: { id: string; limitMinor: number },
  db: Db = defaultDb,
): Promise<BudgetMutationResult> {
  const updated = await db
    .update(schema.budgets)
    .set({ limit_minor: input.limitMinor, updated_at: new Date() })
    .where(
      and(
        eq(schema.budgets.id, input.id),
        eq(schema.budgets.user_id, userId),
      ),
    )
    .returning({ id: schema.budgets.id });
  if (updated.length === 0) {
    return { error: "Budget not found", code: "budget_not_found" };
  }

  // Lowering the limit below what's already spent counts as going over.
  await checkBudgetAlerts(userId, new Date(), db);
  return { success: true, id: input.id };
}

export async function deleteBudget(
  userId: string,
  id: string,
  db: Db = defaultDb,
): Promise<BudgetMutationResult> {
  const deleted = await db.transaction(async (tx) => {
    await tx
      .delete(schema.budget_alerts)
      .where(
        and(
          eq(schema.budget_alerts.budget_id, id),
          eq(schema.budget_alerts.user_id, userId),
        ),
      );
    return tx
      .delete(schema.budgets)
      .where(
        and(eq(schema.budgets.id, id), eq(schema.budgets.user_id, userId)),
      )
      .returning({ id: schema.budgets.id });
  });
  if (deleted.length === 0) {
    return { error: "Budget not found", code: "budget_not_found" };
  }
  return { success: true, id };
}

/**
 * Email the user about every budget that is over its limit this month and
 * hasn't been alerted yet. Called after any write that can change spending
 * or limits. Never throws — a failed check must not fail the user's action.
 * Returns the number of emails sent.
 *
 * Only verified email addresses are notified; without one nothing is
 * claimed, so the alert still goes out once the address is verified.
 */
export async function checkBudgetAlerts(
  userId: string,
  now: Date = new Date(),
  db: Db = defaultDb,
): Promise<number> {
  const log = getLogger();
  try {
    const [user] = await db
      .select({
        email: schema.users.email,
        email_verified_at: schema.users.email_verified_at,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!user?.email || !user.email_verified_at) return 0;

    const overBudget = (await listBudgetsWithSpending(userId, now, db)).filter(
      (b) => b.overBudget,
    );
    const month = monthBounds(now).start;
    let sent = 0;

    for (const budget of overBudget) {
      // Claim first: whoever inserts the row owns this month's email.
      const claimed = await db
        .insert(schema.budget_alerts)
        .values({ budget_id: budget.id, user_id: userId, month })
        .onConflictDoNothing()
        .returning({ budget_id: schema.budget_alerts.budget_id });
      if (claimed.length === 0) continue;

      try {
        await sendEmail({
          to: user.email,
          subject: m.email_budget_exceeded_subject({
            category: budget.categoryPath,
          }),
          text: m.email_budget_exceeded_body({
            category: budget.categoryPath,
            spent: formatMinor(budget.spentMinor),
            limit: formatMinor(budget.limitMinor),
            over: formatMinor(-budget.remainingMinor),
            link: `${env.email.baseUrl}/budgets`,
          }),
        });
        sent++;
      } catch (error) {
        // Release the claim so the next check retries instead of the alert
        // being silently lost for the rest of the month.
        await db
          .delete(schema.budget_alerts)
          .where(
            and(
              eq(schema.budget_alerts.budget_id, budget.id),
              eq(schema.budget_alerts.month, month),
            ),
          );
        log.error(
          { err: error, userId, budgetId: budget.id },
          "failed to send budget alert email — will retry on next check",
        );
      }
    }
    return sent;
  } catch (error) {
    log.error({ err: error, userId }, "budget alert check failed");
    return 0;
  }
}
