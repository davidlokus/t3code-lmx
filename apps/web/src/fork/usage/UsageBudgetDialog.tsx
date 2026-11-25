import { T, useGT } from "gt-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { type UsageBudgetScope, useUsageOptionsStore } from "./usageOptionsStore";

function parseBudgetDraft(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isValidBudgetDraft(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return true;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0;
}

export function UsageBudgetDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const gt = useGT();
  const dailyBudgetUsd = useUsageOptionsStore((state) => state.dailyBudgetUsd);
  const monthlyBudgetUsd = useUsageOptionsStore((state) => state.monthlyBudgetUsd);
  const budgetScope = useUsageOptionsStore((state) => state.budgetScope);
  const setBudget = useUsageOptionsStore((state) => state.setBudget);

  const [dailyDraft, setDailyDraft] = useState(
    dailyBudgetUsd === null ? "" : String(dailyBudgetUsd),
  );
  const [monthlyDraft, setMonthlyDraft] = useState(
    monthlyBudgetUsd === null ? "" : String(monthlyBudgetUsd),
  );
  const [scopeDraft, setScopeDraft] = useState<UsageBudgetScope>(budgetScope);

  const dailyValid = isValidBudgetDraft(dailyDraft);
  const monthlyValid = isValidBudgetDraft(monthlyDraft);
  const canSave = dailyValid && monthlyValid;

  const handleSave = () => {
    if (!canSave) return;
    setBudget({
      dailyBudgetUsd: parseBudgetDraft(dailyDraft),
      monthlyBudgetUsd: parseBudgetDraft(monthlyDraft),
      budgetScope: scopeDraft,
    });
    onOpenChange(false);
  };

  const handleClear = () => {
    setDailyDraft("");
    setMonthlyDraft("");
    setBudget({ dailyBudgetUsd: null, monthlyBudgetUsd: null });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Soft spending budget</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Local visual warnings only; never blocks sending prompts. Daily budget shows on Today,
              monthly budget shows on This month.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="usage-daily-budget">
                <T>Daily budget (USD)</T>
              </Label>
              <Input
                id="usage-daily-budget"
                inputMode="decimal"
                font="mono"
                placeholder={gt("e.g. 25")}
                value={dailyDraft}
                aria-invalid={!dailyValid || undefined}
                onChange={(event) => setDailyDraft(event.target.value)}
              />
              {!dailyValid ? (
                <p role="alert" className="text-xs text-destructive">
                  <T>Enter a positive number or leave blank to disable.</T>
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="usage-monthly-budget">
                <T>Monthly budget (USD)</T>
              </Label>
              <Input
                id="usage-monthly-budget"
                inputMode="decimal"
                font="mono"
                placeholder={gt("e.g. 300")}
                value={monthlyDraft}
                aria-invalid={!monthlyValid || undefined}
                onChange={(event) => setMonthlyDraft(event.target.value)}
              />
              {!monthlyValid ? (
                <p role="alert" className="text-xs text-destructive">
                  <T>Enter a positive number or leave blank to disable.</T>
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>
                <T>Budget spend scope</T>
              </Label>
              <ToggleGroup
                aria-label={gt("Budget spend scope")}
                variant="segmented"
                value={[scopeDraft]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "all" || value === "reportedOnly") setScopeDraft(value);
                }}
              >
                <Toggle value="all">
                  <T>All spend (reported + estimate)</T>
                </Toggle>
                <Toggle value="reportedOnly">
                  <T>Reported only</T>
                </Toggle>
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                <T>
                  Choose Reported only to exclude API-rate estimates from flat-rate subscriptions.
                </T>
              </p>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare" className="items-center sm:justify-between">
          <Button variant="ghost" onClick={handleClear}>
            <T>Clear limits</T>
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              <T>Cancel</T>
            </Button>
            <Button disabled={!canSave} onClick={handleSave}>
              <T>Save budget</T>
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
