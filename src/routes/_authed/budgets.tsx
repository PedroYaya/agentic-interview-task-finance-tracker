import { createFileRoute, Link } from "@tanstack/react-router";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { m } from "#/paraglide/messages";
import { formatMinor, minorToInputValue, parseAmountToMinor } from "#/lib/money";
import { cn } from "#/lib/utils";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectItem } from "#/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import {
  getBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
} from "#/server/budgets.functions";
import { getCategories } from "#/server/categories.functions";


const BUDGETS_QUERY_KEY = ["budgets"] as const;
const CATEGORIES_QUERY_KEY = ["categories"] as const;

type BudgetsOverview = Awaited<ReturnType<typeof getBudgets>>;
type BudgetRow = BudgetsOverview["budgets"][number];
type CategoryRow = Awaited<ReturnType<typeof getCategories>>[number];
type MutationResult = Awaited<ReturnType<typeof createBudget>>;

/** Localized message for a failed budget mutation. */
function mutationErrorMessage(result: MutationResult): string | null {
  if (!("error" in result)) return null;
  switch (result.code) {
    case "budget_limit_reached":
      return m.budget_limit_reached({ limit: result.limit ?? 0 });
    case "budget_exists":
      return m.budget_exists();
    case "budget_not_found":
      return m.budget_not_found();
    default:
      return result.error;
  }
}

/** "Groceries / Vegetables" labels for the category picker. */
function categoryPaths(categories: CategoryRow[]): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const paths = new Map<string, string>();
  for (const category of categories) {
    const names: string[] = [];
    const seen = new Set<string>();
    let cursor: CategoryRow | undefined = category;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      names.unshift(cursor.name);
      cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
    }
    paths.set(category.id, names.join(" / "));
  }
  return paths;
}

// --- Budget Form Modal ---

interface BudgetFormData {
  categoryId: string;
  limitMinor: number;
}

function BudgetForm({
  isOpen,
  editingBudget,
  categoryOptions,
  onClose,
  onSubmit,
  error,
}: {
  isOpen: boolean;
  editingBudget: BudgetRow | null;
  categoryOptions: Array<{ id: string; path: string }>;
  onClose: () => void;
  onSubmit: (data: BudgetFormData) => Promise<void>;
  error: string | null;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [limit, setLimit] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setCategoryId(editingBudget?.categoryId ?? "");
      setLimit(
        editingBudget
          ? String(minorToInputValue(editingBudget.limitMinor))
          : "",
      );
      setValidationError(null);
      setSubmitting(false);
    }
  }, [isOpen, editingBudget]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!categoryId) {
      setValidationError(m.budget_category_required());
      return;
    }
    const limitMinor = parseAmountToMinor(limit);
    if (limitMinor === null || limitMinor <= 0) {
      setValidationError(m.budget_limit_invalid());
      return;
    }
    setSubmitting(true);
    setValidationError(null);
    await onSubmit({ categoryId, limitMinor });
    setSubmitting(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingBudget ? m.edit_budget() : m.add_budget()}
          </DialogTitle>
        </DialogHeader>

        {/* noValidate: our localized messages replace the browser's */}
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {/* Category — fixed once the budget exists; only the limit changes */}
          <div>
            <Label htmlFor="budget-category" className="mb-1">
              {m.budget_category_label()}
            </Label>
            <Select
              id="budget-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              disabled={!!editingBudget}
            >
              <SelectItem value="">{m.budget_select_category()}</SelectItem>
              {editingBudget && (
                <SelectItem value={editingBudget.categoryId}>
                  {editingBudget.categoryPath}
                </SelectItem>
              )}
              {categoryOptions.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.path}
                </SelectItem>
              ))}
            </Select>
          </div>

          {/* Monthly limit */}
          <div>
            <Label htmlFor="budget-limit" className="mb-1">
              {m.budget_limit_label()}
            </Label>
            <Input
              id="budget-limit"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              autoFocus={!!editingBudget}
              placeholder="500.00"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {m.budget_limit_hint()}
            </p>
          </div>

          {(error || validationError) && (
            <div className="text-destructive text-sm" role="alert">
              {validationError ?? error}
            </div>
          )}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              {m.cancel()}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting
                ? editingBudget
                  ? m.saving()
                  : m.creating()
                : editingBudget
                  ? m.save_changes()
                  : m.create_budget_btn()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Budget Card ---

function BudgetCard({
  budget,
  onEdit,
  onDelete,
}: {
  budget: BudgetRow;
  onEdit: (budget: BudgetRow) => void;
  onDelete: (budget: BudgetRow) => void;
}) {
  const ratio = budget.spentMinor / budget.limitMinor;
  const percent = Math.round(ratio * 100);
  // One status colour, used sparingly — the bar and the "Left" figure only:
  // healthy → nearing the limit (80%+) → over.
  const tone = budget.overBudget
    ? { bar: "bg-red-500", text: "text-red-600 dark:text-red-400" }
    : ratio >= 0.8
      ? { bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" }
      : {
          bar: "bg-emerald-500",
          text: "text-emerald-600 dark:text-emerald-400",
        };

  return (
    <li aria-label={budget.categoryPath} className="px-4 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <span
          className="size-2.5 rounded-full shrink-0"
          style={{ backgroundColor: budget.categoryColor ?? undefined }}
          aria-hidden
        />
        <span className="flex-1 text-sm font-medium truncate">
          {budget.categoryPath}
        </span>
        {budget.overBudget && (
          <span className="text-xs font-medium text-red-600 dark:text-red-400">
            {m.budget_over_badge()}
          </span>
        )}
        <span className="flex">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={m.edit()}
            title={m.edit()}
            onClick={() => onEdit(budget)}
            className="text-muted-foreground"
          >
            <PencilIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={m.delete()}
            title={m.delete()}
            onClick={() => onDelete(budget)}
            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          >
            <Trash2Icon />
          </Button>
        </span>
      </div>

      <div
        role="progressbar"
        aria-label={budget.categoryPath}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(percent, 100)}
        aria-valuetext={`${percent}%`}
        className="h-2 rounded-full bg-muted overflow-hidden"
      >
        <div
          className={cn("h-full rounded-full", tone.bar)}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>

      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">
            {m.budget_limit_column()}
          </dt>
          <dd className="font-mono text-foreground/80">
            {formatMinor(budget.limitMinor)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            {m.budget_spent_column()}
          </dt>
          <dd className="font-mono">{formatMinor(budget.spentMinor)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            {m.budget_left_column()}
          </dt>
          <dd className={cn("font-mono font-medium", tone.text)}>
            {budget.overBudget
              ? m.budget_over_by({
                  amount: formatMinor(-budget.remainingMinor),
                })
              : formatMinor(budget.remainingMinor)}
          </dd>
        </div>
      </dl>
    </li>
  );
}

// --- Main Page ---

export const Route = createFileRoute("/_authed/budgets")({
  component: BudgetsPage,
});

function BudgetsPage() {
  const queryClient = useQueryClient();
  const getBudgetsFn = useServerFn(getBudgets);
  const getCategoriesFn = useServerFn(getCategories);
  const createBudgetFn = useServerFn(createBudget);
  const updateBudgetFn = useServerFn(updateBudget);
  const deleteBudgetFn = useServerFn(deleteBudget);

  const { data: overview, isLoading } = useQuery({
    queryKey: BUDGETS_QUERY_KEY,
    queryFn: () => getBudgetsFn(),
  });
  const { data: categories = [] } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: (data: { categoryId: string; limitMinor: number }) =>
      createBudgetFn({ data }),
    onSuccess: invalidate,
  });
  const updateMutation = useMutation({
    mutationFn: (data: { id: string; limitMinor: number }) =>
      updateBudgetFn({ data }),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: (data: { id: string }) => deleteBudgetFn({ data }),
    onSuccess: invalidate,
  });

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<BudgetRow | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingBudget, setDeletingBudget] = useState<BudgetRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const budgets = overview?.budgets ?? [];
  const maxBudgets = overview?.maxBudgets ?? null;
  const atLimit = maxBudgets !== null && budgets.length >= maxBudgets;

  const paths = categoryPaths(categories);
  const budgeted = new Set(budgets.map((b) => b.categoryId));
  const categoryOptions = categories
    .filter((c) => !budgeted.has(c.id))
    .map((c) => ({ id: c.id, path: paths.get(c.id) ?? c.name }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const monthLabel = overview
    ? new Date(`${overview.month}T00:00:00Z`).toLocaleDateString("en", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : "";

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingBudget(null);
    setFormError(null);
  };

  const handleFormSubmit = async (data: BudgetFormData) => {
    setFormError(null);
    const result = editingBudget
      ? await updateMutation.mutateAsync({
          id: editingBudget.id,
          limitMinor: data.limitMinor,
        })
      : await createMutation.mutateAsync(data);
    const error = mutationErrorMessage(result);
    if (error) {
      setFormError(error);
      return;
    }
    closeForm();
  };

  const handleDeleteConfirm = async () => {
    if (!deletingBudget) return;
    setDeleteError(null);
    const result = await deleteMutation.mutateAsync({ id: deletingBudget.id });
    const error = mutationErrorMessage(result);
    if (error) {
      setDeleteError(error);
      return;
    }
    setDeletingBudget(null);
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold display-title">
              {m.budgets_title()}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {m.budgets_subtitle()}
            </p>
          </div>
          <Button
            onClick={() => {
              setEditingBudget(null);
              setFormError(null);
              setIsFormOpen(true);
            }}
            disabled={isLoading || atLimit}
          >
            <svg
              className="size-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4v16m8-8H4"
              />
            </svg>
            {m.add_budget()}
          </Button>
        </div>
      </header>

      <main className="page-wrap py-8 space-y-4">
        {/* Free-plan usage and upsell */}
        {maxBudgets !== null &&
          (atLimit ? (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-md border border-amber-500/40 bg-amber-500/10 text-sm"
            >
              <span>{m.budget_limit_reached({ limit: maxBudgets })}</span>
              <Button asChild size="sm">
                <Link to="/billing">{m.budget_upgrade_cta()}</Link>
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {m.budget_usage({ used: budgets.length, limit: maxBudgets })}
            </p>
          ))}

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="size-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">
                {m.loading_budgets()}
              </span>
            </div>
          </div>
        ) : budgets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <h3 className="text-base font-medium mb-1">{m.no_budgets_yet()}</h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              {m.add_first_budget()}
            </p>
          </div>
        ) : (
          <section className="island-shell rounded-xl overflow-hidden">
            <h2 className="px-4 py-2 bg-muted/40 border-b border-line/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {m.budgets_month({ month: monthLabel })}
            </h2>
            <ul aria-label={m.budgets_title()} className="divide-y divide-line/30">
              {budgets.map((budget) => (
                <BudgetCard
                  key={budget.id}
                  budget={budget}
                  onEdit={(b) => {
                    setEditingBudget(b);
                    setFormError(null);
                    setIsFormOpen(true);
                  }}
                  onDelete={(b) => {
                    setDeletingBudget(b);
                    setDeleteError(null);
                  }}
                />
              ))}
            </ul>
          </section>
        )}
      </main>

      <BudgetForm
        isOpen={isFormOpen}
        editingBudget={editingBudget}
        categoryOptions={categoryOptions}
        onClose={closeForm}
        onSubmit={handleFormSubmit}
        error={formError}
      />

      <AlertDialog
        open={!!deletingBudget}
        onOpenChange={(open) => !open && setDeletingBudget(null)}
      >
        <AlertDialogContent className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.delete_budget_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.delete_budget_confirm({
                category: deletingBudget?.categoryPath ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <div
              className="text-destructive text-sm p-3 rounded-md bg-destructive/10"
              role="alert"
            >
              {deleteError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{m.cancel()}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDeleteConfirm}>
              {m.delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
