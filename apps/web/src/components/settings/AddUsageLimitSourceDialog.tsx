import type {
  EnvironmentId,
  SecretReference,
  UnifiedSettings,
  UsageLimitSourceKind,
  UsageLimitSourceRegion,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useId, useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  OMP_DEFAULT_SOURCE_URL,
  defaultUsageLimitSourceRegion,
  defaultUsageLimitSourceUrl,
  sourceIdFromUrl,
} from "./AddUsageLimitSourceDialog.logic";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";

const LEGACY_SOURCE_KINDS: ReadonlyArray<UsageLimitSourceKind> = ["cliproxy", "http"];
const SOURCE_KINDS: ReadonlyArray<UsageLimitSourceKind> = [
  "cliproxy",
  "http",
  "omp",
  "kimi",
  "zai",
];

/** Send source credentials once to server secret storage; settings retain only a redaction marker. */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  sources,
  kind = "cliproxy",
  supportsExtendedSources = true,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly kind?: UsageLimitSourceKind;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly supportsExtendedSources?: boolean;
}) {
  const gt = useGT();
  const formId = useId();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const availableKinds = supportsExtendedSources ? SOURCE_KINDS : LEGACY_SOURCE_KINDS;
  const initialKind = availableKinds.includes(kind) ? kind : "http";
  const [selectedKind, setSelectedKind] = useState<UsageLimitSourceKind>(initialKind);
  const [region, setRegion] = useState<UsageLimitSourceRegion>(
    defaultUsageLimitSourceRegion(initialKind) ?? "cn",
  );
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const secretSources = useSecretSources(environmentId);
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>("");
  const [keyValid, setKeyValid] = useState(true);
  const [secretInputResetCount, setSecretInputResetCount] = useState(0);

  const managementKey = typeof keyDraft === "string" ? keyDraft.trim() : keyDraft;
  const trimmedUrl = url.trim();
  const isCliproxy = selectedKind === "cliproxy";
  const isHttp = selectedKind === "http";
  const isOmp = selectedKind === "omp";
  const isKimi = selectedKind === "kimi";
  const isZai = selectedKind === "zai";
  const hasRegion = isKimi || isZai;
  const hasSecret = !isOmp;
  const endpoint = URL.parse(trimmedUrl);

  const canSave = isOmp
    ? true
    : keyValid &&
      (isHttp
        ? endpoint !== null &&
          /^https?:$/.test(endpoint.protocol) &&
          !endpoint.username &&
          !endpoint.password
        : isCliproxy
          ? trimmedUrl.length > 0 && managementKey !== ""
          : managementKey !== "");

  const reset = () => {
    setSelectedKind(initialKind);
    setRegion(defaultUsageLimitSourceRegion(initialKind) ?? "cn");
    setLabel("");
    setUrl("");
    setKeyDraft("");
    setKeyValid(true);
    setSecretInputResetCount((count) => count + 1);
  };

  const handleKindChange = (nextKind: UsageLimitSourceKind | null) => {
    if (!nextKind || !availableKinds.includes(nextKind) || nextKind === selectedKind) return;
    setSelectedKind(nextKind);
    const nextRegion = defaultUsageLimitSourceRegion(nextKind);
    if (nextRegion) setRegion(nextRegion);
    setUrl("");
    setKeyDraft("");
    setKeyValid(true);
  };

  const save = () => {
    if (!canSave) return;
    const resolvedUrl = isOmp
      ? trimmedUrl || OMP_DEFAULT_SOURCE_URL
      : hasRegion
        ? defaultUsageLimitSourceUrl(selectedKind, region)
        : trimmedUrl;
    const id = sourceIdFromUrl(resolvedUrl, sources, selectedKind, hasRegion ? region : undefined);
    updateSettings({
      usageLimitSources: {
        [id]: {
          kind: selectedKind,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(hasRegion ? { region } : {}),
          url: resolvedUrl,
          managementKey: isOmp ? "" : managementKey,
          enabled: true,
        },
      },
    });
    reset();
    onOpenChange(false);
  };

  const kindLabel = (value: UsageLimitSourceKind) => {
    switch (value) {
      case "cliproxy":
        return gt("CLIProxyAPI hub");
      case "http":
        return gt("HTTP quota source");
      case "omp":
        return gt("OMP local cache");
      case "kimi":
        return gt("Kimi Code");
      case "zai":
        return gt("Z.ai / BigModel");
    }
  };

  const regionLabel = (value: UsageLimitSourceRegion) => {
    if (isKimi) {
      return value === "global" ? gt("Global (api.kimi.ai)") : gt("China (api.kimi.com)");
    }
    return value === "cn" ? gt("China (open.bigmodel.cn)") : gt("Global (api.z.ai)");
  };

  const secretLabel = isHttp
    ? gt("Bearer token (optional)")
    : isCliproxy
      ? gt("Management key")
      : gt("API key");

  const labelPlaceholder = isCliproxy
    ? gt("Defaults to the hub's host name")
    : isOmp
      ? gt("Defaults to OMP local cache")
      : isKimi
        ? gt("Defaults to Kimi Code")
        : isZai
          ? gt("Defaults to Z.ai")
          : gt("Defaults to the endpoint host name");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isCliproxy ? (
              <T>Add a CLIProxyAPI hub</T>
            ) : isHttp ? (
              <T>Add an HTTP quota source</T>
            ) : isOmp ? (
              <T>Add OMP local cache</T>
            ) : isKimi ? (
              <T>Add Kimi Code quota</T>
            ) : (
              <T>Add Z.ai / BigModel quota</T>
            )}
          </DialogTitle>
          <DialogDescription>
            {isCliproxy ? (
              <T>
                Show the quota of every account the hub pools, next to the providers on{" "}
                <Var>{environmentLabel}</Var>. The key stays on that server.
              </T>
            ) : isHttp ? (
              <T>
                Read quotas from an endpoint on <Var>{environmentLabel}</Var>.
              </T>
            ) : isOmp ? (
              <T>
                Read cached quota reports read-only from agent.db on <Var>{environmentLabel}</Var>.
                Never reads OAuth credentials or refreshes tokens.
              </T>
            ) : isKimi ? (
              <T>
                Read Kimi Code plan quotas and Booster balance on <Var>{environmentLabel}</Var>. The
                API key stays on that server.
              </T>
            ) : (
              <T>
                Read GLM Coding Plan quotas and renewal date on <Var>{environmentLabel}</Var>. The
                API key stays on that server.
              </T>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-kind">
                <T>Source type</T>
              </Label>
              <Select value={selectedKind} onValueChange={handleKindChange}>
                <SelectTrigger id="usage-source-kind" aria-label={gt("Source type")}>
                  <SelectValue>{kindLabel(selectedKind)}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {availableKinds.map((option) => (
                    <SelectItem key={option} value={option}>
                      {kindLabel(option)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {hasRegion ? (
              <div className="grid gap-1.5">
                <Label htmlFor="usage-source-region">
                  <T>Region</T>
                </Label>
                <Select
                  value={region}
                  onValueChange={(next) => {
                    if (next === "cn" || next === "global") setRegion(next);
                  }}
                >
                  <SelectTrigger id="usage-source-region" aria-label={gt("Region")}>
                    <SelectValue>{regionLabel(region)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="cn">{regionLabel("cn")}</SelectItem>
                    <SelectItem value="global">{regionLabel("global")}</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="usage-source-url">
                  {isOmp ? (
                    <T>Database path (optional)</T>
                  ) : isHttp ? (
                    <T>Endpoint URL</T>
                  ) : (
                    <T>Hub URL</T>
                  )}
                </Label>
                <Input
                  id="usage-source-url"
                  placeholder={isOmp ? "~/.omp/agent/agent.db" : "https://hub.example.ts.net:8318"}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  autoFocus
                />
              </div>
            )}
            {hasSecret ? (
              <div className="grid gap-1.5">
                <Label htmlFor="usage-source-key">{secretLabel}</Label>
                <SecretSourceInput
                  key={`${selectedKind}:${secretInputResetCount}`}
                  id="usage-source-key"
                  aria-label={secretLabel}
                  value={keyDraft}
                  sources={secretSources}
                  environmentId={environmentId}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  onSecretChange={(secret) => setKeyDraft(secret ?? "")}
                  onValidityChange={setKeyValid}
                />
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-label">
                <T>Label (optional)</T>
              </Label>
              <Input
                id="usage-source-label"
                placeholder={labelPlaceholder}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            <T>Cancel</T>
          </Button>
          <Button type="submit" form={formId} disabled={!canSave}>
            {isCliproxy ? <T>Add hub</T> : <T>Add source</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
