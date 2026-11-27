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
  OLLAMA_DEFAULT_SOURCE_URL,
  OMP_DEFAULT_SOURCE_URL,
  defaultUsageLimitSourceRegion,
  defaultUsageLimitSourceUrl,
  sourceIdFromUrl,
} from "./AddUsageLimitSourceDialog.logic";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";

const LEGACY_SOURCE_KINDS: ReadonlyArray<UsageLimitSourceKind> = ["cliproxy", "http"];
const EXTENDED_SOURCE_KINDS: ReadonlyArray<UsageLimitSourceKind> = ["omp", "kimi", "zai"];
const EXTERNAL_SOURCE_KINDS: ReadonlyArray<UsageLimitSourceKind> = [
  "openrouter",
  "copilot",
  "ollama",
  "openaiApi",
];

/** Send source credentials once to server secret storage; settings retain only a redaction marker. */
export function AddUsageLimitSourceDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly kind?: UsageLimitSourceKind;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly supportsExtendedSources?: boolean;
  readonly supportsExternalSources?: boolean;
}) {
  const capabilityKey = `${props.environmentId}:${props.supportsExtendedSources !== false}:${props.supportsExternalSources !== false}`;
  return <AddUsageLimitSourceDialogInner key={capabilityKey} {...props} />;
}

function AddUsageLimitSourceDialogInner({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  sources,
  kind = "cliproxy",
  supportsExtendedSources = true,
  supportsExternalSources = true,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly kind?: UsageLimitSourceKind;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly supportsExtendedSources?: boolean;
  readonly supportsExternalSources?: boolean;
}) {
  const gt = useGT();
  const formId = useId();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const availableKinds: ReadonlyArray<UsageLimitSourceKind> = [
    ...LEGACY_SOURCE_KINDS,
    ...(supportsExtendedSources ? EXTENDED_SOURCE_KINDS : []),
    ...(supportsExternalSources ? EXTERNAL_SOURCE_KINDS : []),
  ];
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

  const isSelectedKindSupported = availableKinds.includes(selectedKind);
  const managementKey = typeof keyDraft === "string" ? keyDraft.trim() : keyDraft;
  const trimmedUrl = url.trim();
  const isCliproxy = selectedKind === "cliproxy";
  const isHttp = selectedKind === "http";
  const isOmp = selectedKind === "omp";
  const isKimi = selectedKind === "kimi";
  const isZai = selectedKind === "zai";
  const isOpenRouter = selectedKind === "openrouter";
  const isCopilot = selectedKind === "copilot";
  const isOllama = selectedKind === "ollama";
  const isOpenAiApi = selectedKind === "openaiApi";
  const hasRegion = isKimi || isZai;
  const hasFixedEndpoint = isOpenRouter || isCopilot || isOpenAiApi;
  const hasUrlInput = isCliproxy || isHttp || isOmp || isOllama;
  const hasSecret = !isOmp && !isOllama;
  const endpoint = URL.parse(trimmedUrl);

  const canSave =
    isSelectedKindSupported &&
    (isOmp || isOllama
      ? true
      : keyValid &&
        (isHttp
          ? endpoint !== null &&
            /^https?:$/.test(endpoint.protocol) &&
            !endpoint.username &&
            !endpoint.password
          : isCliproxy
            ? trimmedUrl.length > 0 && managementKey !== ""
            : managementKey !== ""));

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
      : isOllama
        ? trimmedUrl || OLLAMA_DEFAULT_SOURCE_URL
        : hasRegion
          ? defaultUsageLimitSourceUrl(selectedKind, region)
          : hasFixedEndpoint
            ? defaultUsageLimitSourceUrl(selectedKind)
            : trimmedUrl;
    const id = sourceIdFromUrl(resolvedUrl, sources, selectedKind, hasRegion ? region : undefined);
    updateSettings({
      usageLimitSources: {
        [id]: {
          kind: selectedKind,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(hasRegion ? { region } : {}),
          url: resolvedUrl,
          managementKey: hasSecret ? managementKey : "",
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
      : isCopilot
        ? gt("GitHub token")
        : isOpenAiApi
          ? gt("Admin API key")
          : gt("API key");

  const labelPlaceholder = isCliproxy
    ? gt("Defaults to the hub's host name")
    : isOmp
      ? gt("Defaults to OMP local cache")
      : isKimi
        ? gt("Defaults to Kimi Code")
        : isZai
          ? gt("Defaults to Z.ai")
          : isOpenRouter
            ? gt("Defaults to OpenRouter")
            : isCopilot
              ? gt("Defaults to GitHub Copilot")
              : isOllama
                ? gt("Defaults to Ollama Cloud")
                : isOpenAiApi
                  ? gt("Defaults to OpenAI API")
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
            ) : isZai ? (
              <T>Add Z.ai / BigModel quota</T>
            ) : isOpenRouter ? (
              <T>Add OpenRouter quota</T>
            ) : isCopilot ? (
              <T>Add GitHub Copilot quota</T>
            ) : isOllama ? (
              <T>Add Ollama Cloud quota</T>
            ) : (
              <T>Add OpenAI API costs</T>
            )}
          </DialogTitle>
          <DialogDescription>
            {isCliproxy ? (
              <T>
                Show the quota of every Codex, Claude, and Grok account the hub pools, next to the
                providers on <Var>{environmentLabel}</Var>. The key stays on that server.
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
            ) : isZai ? (
              <T>
                Read GLM Coding Plan quotas and renewal date on <Var>{environmentLabel}</Var>. The
                API key stays on that server.
              </T>
            ) : isOpenRouter ? (
              <T>
                Read OpenRouter credits, key limits, and period spend on{" "}
                <Var>{environmentLabel}</Var>. The API key stays on that server.
              </T>
            ) : isCopilot ? (
              <T>
                Read GitHub Copilot quota snapshots and overage on <Var>{environmentLabel}</Var>.
                The token stays on that server.
              </T>
            ) : isOllama ? (
              <T>
                Sign read-only Ollama Cloud balance requests using the local Ed25519 key on{" "}
                <Var>{environmentLabel}</Var>. The private key never leaves that host.
              </T>
            ) : (
              <T>
                Read OpenAI organization API spend on <Var>{environmentLabel}</Var> using an
                organization Admin key. Never reads OPENAI_API_KEY or Codex OAuth.
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
            ) : hasUrlInput ? (
              <div className="grid gap-1.5">
                <Label htmlFor="usage-source-url">
                  {isOmp ? (
                    <T>Database path (optional)</T>
                  ) : isOllama ? (
                    <T>Signing key path (optional)</T>
                  ) : isHttp ? (
                    <T>Endpoint URL</T>
                  ) : (
                    <T>Hub URL</T>
                  )}
                </Label>
                <Input
                  id="usage-source-url"
                  placeholder={
                    isOmp
                      ? "~/.omp/agent/agent.db"
                      : isOllama
                        ? "~/.ollama/id_ed25519"
                        : "https://hub.example.ts.net:8318"
                  }
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  autoFocus
                />
              </div>
            ) : null}
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
