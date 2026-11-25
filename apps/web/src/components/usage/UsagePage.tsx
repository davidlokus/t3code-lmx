// fork: Delegate `/usage` to T3 Lab's UsageDashboard while keeping the upstream export stable.
import { UsageDashboard } from "~/fork/usage/UsageDashboard";

export function UsagePage() {
  return <UsageDashboard />;
}
