import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";

/**
 * Messages already on the server, waiting for the running turn to finish.
 *
 * Sits beside the status pill instead of replacing it: a thread with work
 * waiting is almost always working as well, and "Working" is still its true
 * status. Deliberately not `QueuedMessageIcon`, which marks the local outbox,
 * where messages have not reached the server at all.
 *
 * Decorative on purpose. Each row is one accessibility element and would
 * swallow a label here, so the count is spoken from the row's own label via
 * `queuedMessageCountLabel`.
 */
export function QueuedTurnIcon(props: {
  readonly count: number | undefined;
  readonly selected?: boolean;
}) {
  if (!props.count) return null;
  return (
    <View importantForAccessibility="no-hide-descendants">
      <SymbolView
        name="text.bubble"
        size={12}
        tintColorClassName={
          props.selected ? "accent-user-bubble-foreground-muted" : "accent-foreground-muted"
        }
        type="monochrome"
      />
    </View>
  );
}
