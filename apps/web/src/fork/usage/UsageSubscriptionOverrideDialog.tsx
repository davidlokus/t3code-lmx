import type {
  ManualSubscriptionOverride,
  NormalizedLimitAccount,
} from "@t3tools/shared/usageLimitsIntelligence";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

const CURRENCY_OPTIONS = ["USD", "CNY", "EUR", "GBP", "JPY"] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function formatInitialDate(value: string | undefined): string {
  if (!value) return "";
  const prefix = value.slice(0, 10);
  return DATE_PATTERN.test(prefix) ? prefix : "";
}

function isValidDateDraft(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return true;
  if (!DATE_PATTERN.test(trimmed)) return false;
  const ms = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === trimmed;
}

function isValidCostDraft(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return true;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0;
}

export function UsageSubscriptionOverrideDialog({
  account,
  accountLabel,
  onSave,
  onClear,
  onClose,
}: {
  readonly account: NormalizedLimitAccount;
  readonly accountLabel: string;
  readonly onSave: (accountKey: string, override: ManualSubscriptionOverride) => void;
  readonly onClear: (accountKey: string) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const existing = account.manualOverride;

  const initialDateDraft = formatInitialDate(existing?.expiresAt);
  const [expiresAtDraft, setExpiresAtDraft] = useState(() => initialDateDraft);
  const [monthlyCostDraft, setMonthlyCostDraft] = useState(() =>
    existing?.monthlyCost !== undefined ? String(existing.monthlyCost) : "",
  );
  const [currencyDraft, setCurrencyDraft] = useState<string>(() => existing?.currency ?? "USD");
  const [planLabelDraft, setPlanLabelDraft] = useState(() => existing?.planLabel ?? "");
  const [notesDraft, setNotesDraft] = useState(() => existing?.notes ?? "");

  const dateValid = isValidDateDraft(expiresAtDraft);
  const costValid = isValidCostDraft(monthlyCostDraft);
  const trimmedDate = expiresAtDraft.trim();
  const trimmedCost = monthlyCostDraft.trim();
  const trimmedPlan = planLabelDraft.trim();
  const trimmedNotes = notesDraft.trim();
  const hasAnyField =
    trimmedDate.length > 0 ||
    trimmedCost.length > 0 ||
    trimmedPlan.length > 0 ||
    trimmedNotes.length > 0;
  const canSave = dateValid && costValid && hasAnyField;

  const handleSave = () => {
    if (!canSave) return;
    // Preserve an existing full ISO expiry timestamp unless the user actively edited the date.
    const resolvedExpiresAt =
      trimmedDate.length === 0
        ? undefined
        : trimmedDate === initialDateDraft && existing?.expiresAt
          ? existing.expiresAt
          : trimmedDate;
    const next: ManualSubscriptionOverride = {
      ...(resolvedExpiresAt !== undefined ? { expiresAt: resolvedExpiresAt } : {}),
      ...(trimmedCost.length > 0
        ? { monthlyCost: Number(trimmedCost), currency: currencyDraft }
        : {}),
      ...(trimmedPlan.length > 0 ? { planLabel: trimmedPlan } : {}),
      ...(trimmedNotes.length > 0 ? { notes: trimmedNotes } : {}),
    };
    onSave(account.key, next);
    onClose();
  };

  const handleClear = () => {
    onClear(account.key);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md" data-testid="usage-subscription-override-dialog">
        <DialogHeader>
          <DialogTitle>
            {gt("Subscription details: {account}", { account: accountLabel })}
          </DialogTitle>
          <DialogDescription>
            <T>
              Stored locally on this device to track renewal dates and monthly plan costs when a
              provider does not report them. Provider-reported expiry dates take precedence.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="usage-override-expires">
                <T>Renewal / expiry date</T>
              </Label>
              <Input
                id="usage-override-expires"
                type="date"
                font="mono"
                value={expiresAtDraft}
                aria-invalid={!dateValid || undefined}
                onChange={(event) => setExpiresAtDraft(event.target.value)}
              />
              {!dateValid ? (
                <p role="alert" className="text-xs text-destructive">
                  <T>Enter a valid date (YYYY-MM-DD) or leave blank.</T>
                </p>
              ) : null}
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="usage-override-cost">
                  <T>Monthly cost</T>
                </Label>
                <Input
                  id="usage-override-cost"
                  inputMode="decimal"
                  font="mono"
                  placeholder={gt("e.g. 20")}
                  value={monthlyCostDraft}
                  aria-invalid={!costValid || undefined}
                  onChange={(event) => setMonthlyCostDraft(event.target.value)}
                />
                {!costValid ? (
                  <p role="alert" className="text-xs text-destructive">
                    <T>Enter a non-negative number.</T>
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>
                  <T>Currency</T>
                </Label>
                <Select
                  value={currencyDraft}
                  onValueChange={(value) => {
                    if (typeof value === "string" && value.length === 3) setCurrencyDraft(value);
                  }}
                >
                  <SelectTrigger aria-label={gt("Subscription currency")}>
                    <SelectValue>{currencyDraft}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {CURRENCY_OPTIONS.map((currency) => (
                      <SelectItem key={currency} value={currency}>
                        {currency}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="usage-override-plan">
                <T>Plan label override</T>
              </Label>
              <Input
                id="usage-override-plan"
                placeholder={gt("e.g. Pro, Max 20x")}
                value={planLabelDraft}
                onChange={(event) => setPlanLabelDraft(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="usage-override-notes">
                <T>Notes</T>
              </Label>
              <Input
                id="usage-override-notes"
                placeholder={gt("Optional billing or workspace note")}
                value={notesDraft}
                onChange={(event) => setNotesDraft(event.target.value)}
              />
            </div>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare" className="items-center sm:justify-between">
          {existing ? (
            <Button variant="ghost" data-testid="usage-override-clear" onClick={handleClear}>
              <T>Clear override</T>
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              <T>Cancel</T>
            </Button>
            <Button disabled={!canSave} data-testid="usage-override-save" onClick={handleSave}>
              <T>Save</T>
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
