import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  createBudget as createBudgetForUser,
  deleteBudget as deleteBudgetForUser,
  getBudgetsOverview,
  updateBudgetLimit,
} from "#/server/budgets.server";
import { requireUserId } from "#/server/session";

// Postgres integer column — positive minor units up to INT4 max.
const limitMinorSchema = z.number().int().positive().max(2_147_483_647);

const createBudgetSchema = z.object({
  categoryId: z.string().min(1),
  limitMinor: limitMinorSchema,
});

const updateBudgetSchema = z.object({
  id: z.string().min(1),
  limitMinor: limitMinorSchema,
});

const deleteBudgetSchema = z.object({
  id: z.string().min(1),
});

export const getBudgets = createServerFn({ method: "GET" }).handler(
  async () => {
    const userId = await requireUserId();
    return getBudgetsOverview(userId);
  },
);

export const createBudget = createServerFn({ method: "POST" })
  .inputValidator(createBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    return createBudgetForUser(userId, data);
  });

export const updateBudget = createServerFn({ method: "POST" })
  .inputValidator(updateBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    return updateBudgetLimit(userId, data);
  });

export const deleteBudget = createServerFn({ method: "POST" })
  .inputValidator(deleteBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    return deleteBudgetForUser(userId, data.id);
  });
