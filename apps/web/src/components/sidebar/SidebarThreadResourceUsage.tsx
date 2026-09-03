import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ArrowDownUpIcon, CpuIcon, HourglassIcon, TerminalIcon } from "lucide-react";

import type { TerminalStatusIndicator } from "../ThreadStatusIndicators";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import { terminalProcessLabel, threadResourceUsageRows } from "./threadResourceUsage";

function UsageRow(props: { icon: typeof CpuIcon; iconClassName?: string; children: string }) {
  const Icon = props.icon;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon
        aria-hidden
        className={cn("size-3 shrink-0 stroke-muted-foreground", props.iconClassName)}
      />
      <div className="min-w-0 truncate text-foreground/75">{props.children}</div>
    </div>
  );
}

/**
 * How much of the machine this thread is holding, live.
 *
 * Mounted only inside the open hover card: the subscription is what asks the
 * server to sample process resources at all, so it must not exist for every
 * row in the sidebar.
 */
export function SidebarThreadResourceUsage(props: {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly terminalStatus: TerminalStatusIndicator | null;
  readonly terminalProcessCount: number;
}) {
  const { data } = useEnvironmentQuery(
    serverEnvironment.threadResourceUsage({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const rows = threadResourceUsageRows(data);

  // The process row already names the thread's terminals, so the standalone
  // terminal row only appears when there is no usage to fold it into.
  const terminalRow =
    props.terminalStatus !== null && rows.processes === null ? (
      <UsageRow
        icon={TerminalIcon}
        iconClassName={cn("stroke-current", props.terminalStatus.colorClass)}
      >
        {terminalProcessLabel(props.terminalProcessCount)}
      </UsageRow>
    ) : null;

  return (
    <>
      {terminalRow}
      {rows.load ? <UsageRow icon={CpuIcon}>{rows.load}</UsageRow> : null}
      {rows.history ? <UsageRow icon={HourglassIcon}>{rows.history}</UsageRow> : null}
      {rows.processes ? <UsageRow icon={TerminalIcon}>{rows.processes}</UsageRow> : null}
      {rows.io ? <UsageRow icon={ArrowDownUpIcon}>{rows.io}</UsageRow> : null}
    </>
  );
}
