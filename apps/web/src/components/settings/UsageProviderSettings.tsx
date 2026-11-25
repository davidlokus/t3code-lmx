import type { EnvironmentId, UnifiedSettings, UsageLimitSourceKind } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { displayUsageLimitSourceTarget } from "./AddUsageLimitSourceDialog.logic";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const CLI_PROXY_NAME = "CLI Proxy";

export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  readOnly,
  supportsExtendedSources = true,
  supportsExternalSources = true,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly readOnly: boolean;
  readonly supportsExtendedSources?: boolean;
  readonly supportsExternalSources?: boolean;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [adding, setAdding] = useState<UsageLimitSourceKind | null>(null);
  const entries = Object.entries(sources);

  const kindLabel = (kind: UsageLimitSourceKind) => {
    switch (kind) {
      case "cliproxy":
        return CLI_PROXY_NAME;
      case "http":
        return gt("HTTP quota source");
      case "omp":
        return gt("OMP local cache");
      case "kimi":
        return gt("Kimi Code");
      case "zai":
        return gt("Z.ai / BigModel");
      case "openrouter":
        return gt("OpenRouter");
      case "copilot":
        return gt("GitHub Copilot");
      case "ollama":
        return gt("Ollama Cloud");
      case "openaiApi":
        return gt("OpenAI API");
    }
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <div className="flex gap-2">
              <Button size="xs" variant="outline" onClick={() => setAdding("cliproxy")}>
                <PlusIcon className="size-3" aria-hidden />
                <T>Add hub</T>
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  setAdding(
                    supportsExtendedSources
                      ? "omp"
                      : supportsExternalSources
                        ? "openrouter"
                        : "http",
                  )
                }
              >
                <PlusIcon className="size-3" aria-hidden />
                <T>Add source</T>
              </Button>
            </div>
          ) : null
        }
      >
        {entries.length === 0 ? (
          <SettingsRow title={gt("No usage sources configured.")} />
        ) : (
          entries.map(([id, source]) => {
            const typeLabel = kindLabel(source.kind);
            const target = displayUsageLimitSourceTarget(source);
            const label =
              source.label?.trim() ||
              (source.kind !== "cliproxy" && source.kind !== "http" ? typeLabel : target);
            const statusLabel = source.enabled
              ? typeLabel
              : gt("{name} · Disabled", { name: typeLabel });
            const description =
              source.enabled && label === typeLabel
                ? target
                : `${statusLabel}${label !== target ? ` · ${target}` : ""}`;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={<span className="break-all">{description}</span>}
                control={
                  !readOnly ? (
                    <RemoveUsageProviderButton
                      label={label}
                      onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                    />
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          kind={adding}
          supportsExtendedSources={supportsExtendedSources}
          supportsExternalSources={supportsExternalSources}
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          sources={sources}
        />
      ) : null}
    </>
  );
}

function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <T>Remove</T>
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{label}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>The saved connection and its credentials are removed from this environment.</T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              <T>Remove</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
